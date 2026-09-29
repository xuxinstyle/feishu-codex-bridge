import { Client, EventDispatcher, WSClient, normalizeCardAction } from "@larksuiteoapi/node-sdk";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  assertFeishuApiSuccess,
  buildImageArgs,
  buildModelArgs,
  buildModelChoiceGroups,
  canResumeCodexSession,
  codexConfigOverrideForReasoning,
  cardProjectPathForAction,
  createKeyedSerialExecutor,
  effectiveCodexModel,
  effectiveReasoningEffort,
  mergeProjectChoices,
  parseCodexConfigDefaults,
  parseFeishuImageContent,
  parseCommand,
  parseProjectChoices,
  shouldRefreshProjectChoicesForCardAction,
  isStaleControlCardAction,
  validateModelName,
  validateReasoningEffort,
} from "./bridge-core.mjs";
import { discoverCodexProjectPaths } from "./codex-projects.mjs";

const HOME_CONFIG_DIR = path.join(homedir(), ".feishu-codex-bridge");
const HOME_CONFIG_PATH = path.join(HOME_CONFIG_DIR, "config.env");
const HOME_STATE_PATH = path.join(HOME_CONFIG_DIR, "state.json");
const CONFIG_PATH = process.env.DOTENV_CONFIG_PATH || HOME_CONFIG_PATH;

function readDotenv(filePath) {
  if (!existsSync(filePath)) return {};
  const env = {};
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

for (const [key, value] of Object.entries(readDotenv(CONFIG_PATH))) {
  if (process.env[key] === undefined) process.env[key] = value;
}

function requiredEnv(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

function optionalEnv(key, fallback = "") {
  return process.env[key] || fallback;
}

function optionalIntEnv(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${key}: ${value}`);
  return parsed;
}

function boolEnv(key, fallback = false) {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseListEnv(key) {
  return optionalEnv(key)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stripFeishuMentions(text) {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/g, "")
    .replace(/@_[A-Za-z0-9_:-]+/g, "")
    .trim();
}

function expandHome(input) {
  if (!input) return input;
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

function resolveProjectPath(input, basePath) {
  const expanded = expandHome(input);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(basePath, expanded);
}

function projectDisplayName(projectPath) {
  return path.basename(projectPath) || projectPath;
}

function buildProjectChoices(defaultProjectPath, rawChoices) {
  const choices = [
    { alias: projectDisplayName(defaultProjectPath), path: defaultProjectPath },
    ...parseProjectChoices(rawChoices).map((item) => ({
      alias: item.alias,
      path: resolveProjectPath(item.path, defaultProjectPath),
    })),
  ];
  const seen = new Set();
  return choices.filter((item) => {
    const key = path.resolve(item.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitConfigOverrides(value) {
  if (!value) return [];
  return value
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveCodexLauncher(bin) {
  const cleanBin = bin.replace(/^["']|["']$/g, "");
  if (process.platform !== "win32") {
    return { command: cleanBin, argsPrefix: [], shell: false };
  }

  const basename = path.basename(cleanBin).toLowerCase();
  const dirname = path.dirname(cleanBin);
  const candidateDirs = [];
  if (dirname && dirname !== ".") candidateDirs.push(dirname);
  if (process.env.APPDATA) candidateDirs.push(path.join(process.env.APPDATA, "npm"));
  candidateDirs.push(path.join(homedir(), "AppData", "Roaming", "npm"));
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidateDirs.push(dir);
  }

  if (["codex", "codex.cmd", "codex.ps1"].includes(basename)) {
    for (const dir of candidateDirs) {
      const codexJs = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(codexJs)) {
        const localNode = path.join(dir, "node.exe");
        return {
          command: existsSync(localNode) ? localNode : process.execPath,
          argsPrefix: [codexJs],
          shell: false,
        };
      }
    }
  }

  const ext = path.extname(cleanBin).toLowerCase();
  if (ext === ".js") {
    return { command: process.execPath, argsPrefix: [cleanBin], shell: false };
  }
  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      argsPrefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cleanBin],
      shell: false,
    };
  }
  return { command: cleanBin, argsPrefix: [], shell: false };
}

function readCodexDefaults(codexHome, profile = "") {
  const readDefaults = (filePath) =>
    existsSync(filePath) ? parseCodexConfigDefaults(readFileSync(filePath, "utf8")) : { model: "", reasoningEffort: "" };
  const baseDefaults = readDefaults(path.join(codexHome, "config.toml"));
  if (!profile) return baseDefaults;
  const profileDefaults = readDefaults(path.join(codexHome, `${profile}.config.toml`));
  return {
    model: profileDefaults.model || baseDefaults.model,
    reasoningEffort: profileDefaults.reasoningEffort || baseDefaults.reasoningEffort,
  };
}

const codexHome = resolveProjectPath(optionalEnv("CODEX_HOME", path.join(homedir(), ".codex")), process.cwd());
const configuredCodexProfile = optionalEnv("CODEX_PROFILE");
const codexDefaults = readCodexDefaults(codexHome, configuredCodexProfile);

const config = {
  feishu: {
    appId: requiredEnv("FEISHU_APP_ID"),
    appSecret: requiredEnv("FEISHU_APP_SECRET"),
  },
  codex: {
    bin: optionalEnv("CODEX_BIN", "codex"),
    model: optionalEnv("CODEX_MODEL"),
    defaultModel: codexDefaults.model,
    reasoningEffort: optionalEnv("CODEX_REASONING_EFFORT"),
    defaultReasoningEffort: codexDefaults.reasoningEffort,
    profile: configuredCodexProfile,
    sandboxMode: optionalEnv("CODEX_SANDBOX_MODE", "workspace-write"),
    approvalPolicy: optionalEnv("CODEX_APPROVAL_POLICY", "never"),
    dangerousBypass: boolEnv("CODEX_DANGEROUS_BYPASS", false),
    fullAuto: boolEnv("CODEX_FULL_AUTO", false),
    enableWebSearch: boolEnv("CODEX_ENABLE_WEB_SEARCH", false),
    configOverrides: splitConfigOverrides(optionalEnv("CODEX_CONFIG_OVERRIDES")),
    taskTimeout: optionalIntEnv("TASK_TIMEOUT", 1_200_000),
  },
  bridge: {
    defaultProjectPath: resolveProjectPath(optionalEnv("DEFAULT_PROJECT_PATH", homedir()), process.cwd()),
    sessionStatePath: resolveProjectPath(optionalEnv("SESSION_STATE_PATH", HOME_STATE_PATH), process.cwd()),
    projectDiscovery: optionalEnv("CODEX_PROJECT_DISCOVERY", "thread-list").trim().toLowerCase(),
    projectDiscoveryTimeout: optionalIntEnv("CODEX_PROJECT_DISCOVERY_TIMEOUT", 15_000),
    projectDiscoveryInterval: optionalIntEnv("CODEX_PROJECT_DISCOVERY_INTERVAL", 60_000),
    streamPushInterval: optionalIntEnv("STREAM_PUSH_INTERVAL", 5000),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    allowedUserIds: parseListEnv("ALLOWED_USER_IDS"),
  },
};
config.codex.modelGroups = buildModelChoiceGroups({
  configuredChoices: [
    ...parseListEnv("CODEX_MODEL_CHOICES"),
    "gpt-5.5",
    "gpt-5.4",
  ],
  configuredModel: config.codex.model,
  defaultModel: config.codex.defaultModel,
});
config.codex.reasoningEffortChoices = uniqueList(
  [
    ...(parseListEnv("CODEX_REASONING_EFFORT_CHOICES").length > 0
      ? parseListEnv("CODEX_REASONING_EFFORT_CHOICES")
      : ["low", "medium", "high", "xhigh", "max", "ultra"]),
    config.codex.reasoningEffort,
    config.codex.defaultReasoningEffort,
  ]
).filter((effort) => validateReasoningEffort(effort).ok);
config.bridge.projectChoices = buildProjectChoices(
  config.bridge.defaultProjectPath,
  optionalEnv("CODEX_PROJECTS")
);
config.bridge.manualProjectChoices = config.bridge.projectChoices;
const codexLauncher = resolveCodexLauncher(config.codex.bin);

if (!existsSync(config.bridge.defaultProjectPath)) {
  throw new Error(`DEFAULT_PROJECT_PATH does not exist: ${config.bridge.defaultProjectPath}`);
}

function log(level, message, data = undefined) {
  const levels = ["debug", "info", "warn", "error"];
  const current = levels.indexOf(config.bridge.logLevel);
  const wanted = levels.indexOf(level);
  if (wanted < (current < 0 ? 1 : current)) return;
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console.log(`[${new Date().toISOString()}] [${level}] ${message}${suffix}`);
}

function isExistingDirectory(projectPath) {
  try {
    return existsSync(projectPath) && statSync(projectPath).isDirectory();
  } catch {
    return false;
  }
}

function normalizeDiscoveredProjectPaths(projectPaths) {
  return [...new Set(
    (Array.isArray(projectPaths) ? projectPaths : [])
      .map((projectPath) => {
        try {
          return resolveProjectPath(projectPath, config.bridge.defaultProjectPath);
        } catch {
          return "";
        }
      })
      .filter((projectPath) => projectPath && isExistingDirectory(projectPath))
  )];
}

let projectRefreshPromise = null;

async function refreshProjectChoices(reason = "manual") {
  if (config.bridge.projectDiscovery !== "thread-list") return config.bridge.projectChoices;
  if (projectRefreshPromise) return projectRefreshPromise;

  projectRefreshPromise = (async () => {
    try {
      const discoveredPaths = normalizeDiscoveredProjectPaths(
        await discoverCodexProjectPaths({
          codexCommand: codexLauncher.command,
          codexArgsPrefix: codexLauncher.argsPrefix,
          shell: codexLauncher.shell,
          timeoutMs: config.bridge.projectDiscoveryTimeout,
        })
      );
      config.bridge.projectChoices = mergeProjectChoices(
        config.bridge.manualProjectChoices,
        discoveredPaths
      );
      log("info", "project choices refreshed from Codex thread history", {
        reason,
        discoveredCount: discoveredPaths.length,
        totalCount: config.bridge.projectChoices.length,
      });
    } catch (error) {
      config.bridge.projectChoices = config.bridge.manualProjectChoices;
      log("warn", "failed to refresh project choices from Codex thread history", {
        reason,
        error: String(error),
      });
    } finally {
      projectRefreshPromise = null;
    }
    return config.bridge.projectChoices;
  })();

  return projectRefreshPromise;
}

function saveAllowedUserId(userId) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  let content = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  if (/^ALLOWED_USER_IDS=/m.test(content)) {
    content = content.replace(/^ALLOWED_USER_IDS=.*$/m, `ALLOWED_USER_IDS=${userId}`);
  } else {
    if (content && !content.endsWith("\n")) content += "\n";
    content += `ALLOWED_USER_IDS=${userId}\n`;
  }
  writeFileSync(CONFIG_PATH, content, "utf8");
}

function readSessionState() {
  const filePath = config.bridge.sessionStatePath;
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    log("warn", "failed to read session state; starting empty", { filePath, error: String(error) });
    return {};
  }
}

function writeSessionState(state) {
  const filePath = config.bridge.sessionStatePath;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function makePairingCode() {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

function parseMessageEvent(data) {
  try {
    const payload = data?.event?.message ? data.event : data;
    const message = payload?.message;
    const sender = payload?.sender;
    if (!message) {
      log("warn", "ignored event without message field", {
        keys: data && typeof data === "object" ? Object.keys(data) : [],
        eventKeys: data?.event && typeof data.event === "object" ? Object.keys(data.event) : [],
      });
      return null;
    }
    if (!['text', 'image'].includes(message.message_type)) {
      log("info", "ignored unsupported message type", {
        messageId: message.message_id,
        messageType: message.message_type,
        chatId: message.chat_id,
      });
      return null;
    }
    let rawText = "";
    let imageKey = "";
    if (message.message_type === "image") {
      imageKey = parseFeishuImageContent(message.content).imageKey;
      if (!imageKey) {
        log("warn", "ignored image message without image_key", {
          messageId: message.message_id,
          chatId: message.chat_id,
        });
        return null;
      }
    } else {
      try {
        rawText = JSON.parse(message.content || "{}").text || "";
      } catch {
        rawText = message.content || "";
      }
    }
    const text = stripFeishuMentions(rawText);
    return {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      senderId: sender?.sender_id?.open_id || "unknown",
      text,
      rawText,
      imageKey,
      raw: data,
    };
  } catch (error) {
    log("error", "failed to parse message event", { error: String(error) });
    return null;
  }
}

function getHelpMessage() {
  return [
    "Codex 飞书助手",
    "",
    "直接发消息即可让本机 Codex 在默认仓库执行任务。同一聊天窗口会尽量恢复上次 Codex session。",
    "",
    "指令:",
    "- /panel：发送按钮控制卡片",
    "- /run <描述>：在默认仓库执行",
    "- /run <路径> <描述>：指定仓库或目录执行",
    "- 直接发送图片：下载图片后交给 Codex 通过 -i 参数分析",
    "- 连续发送多个任务会排队执行，不会自动取消前一个任务",
    "- /sessions：查看当前仓库的 Codex session",
    "- /use <名字>：切换当前聊天窗口的 active session",
    "- /new <名字>：新建/重置命名 session 并切换过去",
    "- /new：清除当前 active session 映射",
    "- /model：查看当前聊天窗口的模型覆盖",
    "- /model <模型名>：切换当前聊天窗口后续任务使用的模型，例如 /model gpt-5.5",
    "- /panel：面板提供 grok-4.6、grok-4.5 和配置的 Codex/provider 模型按钮；其他模型可直接用 /model <模型名>",
    "- /model <模型名> <推理强度>：同时切换模型和推理强度，例如 /model gpt-5.5 high",
    "- /model default：清除模型覆盖，回到 CODEX_MODEL 或 ~/.codex/config.toml",
    "- /reasoning <low|medium|high|xhigh|max|ultra>：切换当前项目的推理强度",
    "- /reasoning default：清除推理强度覆盖，回到 CODEX_REASONING_EFFORT 或 ~/.codex/config.toml",
    "- /project：查看当前聊天窗口项目",
    "- /project <别名或路径>：切换当前聊天窗口后续任务使用的项目",
    "- /status：查看最近任务",
    "- /cancel task-xxxx：取消任务",
    "- /help：显示帮助",
  ].join("\n");
}

class FeishuMessenger {
  constructor(client) {
    this.client = client;
  }

  async sendText(chatId, text) {
    const res = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return res?.data?.message_id;
  }

  async sendCard(chatId, card) {
    const res = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    return res?.data?.message_id;
  }

  async replyText(messageId, text) {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return res?.data?.message_id;
  }

  async replyCard(messageId, card) {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    return res?.data?.message_id;
  }

  async downloadMessageResource(messageId, fileKey, filePath) {
    const resource = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: "image" },
    });
    await resource.writeFile(filePath);
    const contentTypeHeader = resource.headers?.["content-type"] || resource.headers?.["Content-Type"] || "";
    return {
      filePath,
      contentType: String(contentTypeHeader).split(";", 1)[0].trim().toLowerCase(),
    };
  }

  async updateText(messageId, text) {
    await this.client.im.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  async updateCard(messageId, card) {
    const res = await this.client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
      },
    });
    assertFeishuApiSuccess(res, "更新飞书卡片");
    return res;
  }
}

function truncateText(text, maxLength = 3500) {
  if (!text || text.length <= maxLength) return text || "";
  return `${text.slice(0, 1200)}\n\n...[truncated]...\n\n${text.slice(-maxLength + 1230)}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function generateTaskId() {
  return `task-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

function normalizeSessionName(name) {
  const trimmed = (name || "default").trim();
  if (!trimmed) return "default";
  return trimmed.slice(0, 48);
}

function sessionScopeKey(chatId, projectPath) {
  return `${chatId}::${projectPath}`;
}

function sessionKey(chatId, projectPath, sessionName) {
  return `${sessionScopeKey(chatId, projectPath)}::${normalizeSessionName(sessionName)}`;
}

const CARD_BRIDGE_ID = "feishu-codex-bridge";

function cardActionValue(action, extra = {}) {
  return { bridge: CARD_BRIDGE_ID, action, ...extra };
}

function parseCardActionValue(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function cardButton(text, action, extra = {}, type = "default", confirm = null) {
  const button = {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    value: cardActionValue(action, extra),
  };
  if (confirm) button.confirm = confirm;
  return button;
}

function firstNonEmptyLine(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function compactText(text, maxLength = 90) {
  const line = firstNonEmptyLine(text);
  if (!line) return "";
  return line.length > maxLength ? `${line.slice(0, maxLength - 3)}...` : line;
}

function buildControlCard(runner, chatId, projectPath, notice = "", view = "sessions") {
  const activeName = runner.activeSessionName(chatId, projectPath);
  const sessions = runner.sessionStates(chatId, projectPath);
  const recentTask = runner.recentTask(chatId);
  const pendingCount = runner.pendingCount(chatId);
  const scopedModel = runner.modelOverride(chatId, projectPath);
  const modelText = runner.effectiveModel(chatId, projectPath) || "未设置";
  const scopedReasoning = runner.reasoningOverride(chatId, projectPath);
  const reasoningText = runner.effectiveReasoning(chatId, projectPath) || "未设置";
  const projectAlias = runner.projectAlias(projectPath);
  const scopedButton = (text, action, extra = {}, type = "default", confirm = null) =>
    cardButton(text, action, { scopeChatId: chatId, projectPath, ...extra }, type, confirm);
  const recentTaskText = recentTask
    ? `${recentTask.taskId} / ${recentTask.status} / session=${recentTask.sessionName || "default"}`
    : "无";
  const sessionLines =
    sessions.length > 0
      ? sessions
          .map((item) => {
            const mark = item.name === activeName ? "*" : "-";
            const taskPart = item.taskId ? ` task=${item.taskId}` : "";
            const turnsPart = item.turns > 0 ? ` turns=${item.turns}` : "";
            const progressPart = item.progress ? `\n  ${item.progress}` : "";
            return `${mark} ${item.name} [${item.status}]${taskPart}${turnsPart}${progressPart}`;
          })
          .join("\n")
      : "暂无 session；当前 active 会在下一次任务完成后保存。";
  const sessionButtons = sessions
    .slice(0, 5)
    .map((item) =>
      scopedButton(
        item.name === activeName ? `当前 ${item.name}` : `切到 ${item.name}`,
        "use_session",
        { sessionName: item.name },
        item.name === activeName ? "primary" : "default"
      )
    );
  const cancelButtons = sessions
    .filter((item) => item.taskId && ["pending", "running"].includes(item.status))
    .slice(0, 5)
    .map((item) =>
      scopedButton(
        `取消 ${item.name}`,
        "cancel_task",
        { taskId: item.taskId },
        "danger",
        {
          title: { tag: "plain_text", content: "取消任务?" },
          text: { tag: "plain_text", content: `将取消 ${item.name} 的任务 ${item.taskId}。` },
        }
      )
    );
  const primaryActions = [
    scopedButton("新建会话", "new_session", {}, "primary"),
    scopedButton("会话列表", "show_sessions"),
    scopedButton("刷新列表", "refresh"),
  ];
  const projectButtons = config.bridge.projectChoices
    .slice(0, 8)
    .map((item) =>
      scopedButton(
        item.path === projectPath ? `当前 ${item.alias}` : `项目 ${item.alias}`,
        "set_project",
        { targetProjectPath: item.path },
        item.path === projectPath ? "primary" : "default"
      )
    );
  const modelButtons = (models) =>
    models.slice(0, 8).map((model) =>
      scopedButton(
        model === modelText ? `当前 ${model}` : `模型 ${model}`,
        "set_model",
        { model },
        model === modelText ? "primary" : "default"
      )
    );
  const grokButtons = modelButtons(config.codex.modelGroups.grok);
  const codexButtons = modelButtons(config.codex.modelGroups.codex);
  const reasoningButtons = config.codex.reasoningEffortChoices
    .slice(0, 8)
    .map((effort) =>
      scopedButton(
        effort === reasoningText ? `当前 ${effort}` : `推理 ${effort}`,
        "set_reasoning",
        { reasoningEffort: effort },
        effort === reasoningText ? "primary" : "default"
      )
    );
  const manageActions = [
    scopedButton("清除模型", "clear_model"),
    scopedButton("清除推理", "clear_reasoning"),
    scopedButton(
      "重置当前会话",
      "reset_active_session",
      {},
      "danger",
      {
        title: { tag: "plain_text", content: "重置当前会话?" },
        text: { tag: "plain_text", content: "这会清除当前 active session 的 thread 映射，下一条消息会新开 Codex 对话。" },
      }
    ),
  ];
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Codex 会话" },
    },
    elements: [
      {
        tag: "markdown",
        content: [
          `**project**: ${projectAlias} (${projectPath})`,
          `**active session**: ${activeName}`,
          `**model**: ${modelText}${scopedModel ? " (chat override)" : ""}`,
          `**reasoning**: ${reasoningText}${scopedReasoning ? " (chat override)" : ""}`,
          `**queued/running**: ${pendingCount}`,
          `**recent task**: ${recentTaskText}`,
          notice ? `**提示**: ${notice}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      { tag: "hr" },
      { tag: "action", layout: "flow", actions: primaryActions },
      { tag: "hr" },
      { tag: "markdown", content: "**projects**" },
      projectButtons.length > 0 ? { tag: "action", layout: "flow", actions: projectButtons } : null,
      { tag: "markdown", content: "**Grok models**" },
      grokButtons.length > 0 ? { tag: "action", layout: "flow", actions: grokButtons } : null,
      { tag: "markdown", content: "**Codex/provider models**" },
      codexButtons.length > 0 ? { tag: "action", layout: "flow", actions: codexButtons } : null,
      { tag: "markdown", content: "**reasoning effort**" },
      reasoningButtons.length > 0 ? { tag: "action", layout: "flow", actions: reasoningButtons } : null,
      { tag: "hr" },
      { tag: "markdown", content: `**sessions / progress**\n${sessionLines}` },
      sessionButtons.length > 0 ? { tag: "action", layout: "flow", actions: sessionButtons } : null,
      cancelButtons.length > 0 ? { tag: "action", layout: "flow", actions: cancelButtons } : null,
      { tag: "hr" },
      { tag: "action", layout: "flow", actions: manageActions },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content:
              "项目、模型和推理强度只影响后续任务；面板列出 Grok 预设和 Codex/provider 候选。要使用其他已配置模型可发送 /model <模型名>；要自定义 session 名称可发送 /new 名字。",
          },
        ],
      },
    ].filter(Boolean),
  };
}

function extractCodexTextEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return typeof event.item.text === "string" ? event.item.text : "";
  }
  if (event.type === "item.completed" && event.item?.type === "assistant_message") {
    return typeof event.item.text === "string" ? event.item.text : "";
  }
  if (event.type === "agent_message" && typeof event.message === "string") return event.message;
  if (event.type === "assistant_message" && typeof event.message === "string") return event.message;
  if (event.type === "error" && typeof event.message === "string") return `ERROR: ${event.message}\n`;
  if (event.type === "turn.failed" && event.error?.message) return `FAILED: ${event.error.message}\n`;
  if (event.type === "exec_command.begin" && event.command) return `RUN: ${event.command}\n`;
  if (event.type === "exec_command.end" && event.exit_code !== undefined) {
    return `EXIT ${event.exit_code}: ${event.command || ""}\n`;
  }
  return "";
}

function appendTaskOutput(task, text) {
  const block = String(text || "").trim();
  if (!block) return;
  task.output = task.output ? `${task.output.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

function describeCodexProgressEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "thread.started") return `Codex session 已启动: ${event.thread_id || "unknown"}`;
  if (event.type === "turn.started") return "Codex 已开始处理任务。";
  if (event.type === "turn.completed") return "Codex 已完成本轮处理。";
  if (event.type === "turn.failed") return "Codex 本轮处理失败。";
  if (event.type === "item.completed" && event.item?.type) {
    return `Codex 事件: item.completed/${event.item.type}`;
  }
  if (event.type) return `Codex 事件: ${event.type}`;
  return "";
}

class TaskRunner {
  constructor(messenger) {
    this.messenger = messenger;
    this.tasks = new Map();
    const state = readSessionState();
    this.sessions = new Map(Array.isArray(state.sessions) ? state.sessions : []);
    this.activeSessions = new Map(Array.isArray(state.activeSessions) ? state.activeSessions : []);
    this.activeProjects = new Map(Array.isArray(state.activeProjects) ? state.activeProjects : []);
    this.knownSessions = new Set(Array.isArray(state.knownSessions) ? state.knownSessions : []);
    this.modelOverrides = new Map(Array.isArray(state.modelOverrides) ? state.modelOverrides : []);
    this.reasoningOverrides = new Map(Array.isArray(state.reasoningOverrides) ? state.reasoningOverrides : []);
    this.controlCards = new Map(Array.isArray(state.controlCards) ? state.controlCards : []);
    this.sessionResetAt = new Map();
    this.activeTasks = new Map();
    this.sessionQueues = new Map();
  }

  persistSessionState() {
    writeSessionState({
      version: 1,
      savedAt: new Date().toISOString(),
      sessions: [...this.sessions.entries()],
      activeSessions: [...this.activeSessions.entries()],
      activeProjects: [...this.activeProjects.entries()],
      knownSessions: [...this.knownSessions],
      modelOverrides: [...this.modelOverrides.entries()],
      reasoningOverrides: [...this.reasoningOverrides.entries()],
      controlCards: [...this.controlCards.entries()],
    });
  }

  markKnownSession(chatId, projectPath, sessionName) {
    this.knownSessions.add(sessionKey(chatId, projectPath, sessionName));
  }

  recentTask(chatId = null) {
    let latest = null;
    for (const task of this.tasks.values()) {
      if (chatId && task.source.chatId !== chatId) continue;
      if (!latest || task.createdAt > latest.createdAt) latest = task;
    }
    return latest;
  }

  activeSessionName(chatId, projectPath) {
    return this.activeSessions.get(sessionScopeKey(chatId, projectPath)) || "default";
  }

  setActiveSession(chatId, projectPath, sessionName) {
    const normalized = normalizeSessionName(sessionName);
    this.activeSessions.set(sessionScopeKey(chatId, projectPath), normalized);
    this.markKnownSession(chatId, projectPath, normalized);
    this.persistSessionState();
    return normalized;
  }

  activeProjectPath(chatId) {
    const projectPath = this.activeProjects.get(chatId);
    if (projectPath && existsSync(projectPath)) return projectPath;
    return config.bridge.defaultProjectPath;
  }

  projectAlias(projectPath) {
    const found = config.bridge.projectChoices.find((item) => item.path === projectPath);
    return found?.alias || projectDisplayName(projectPath);
  }

  resolveProjectSelection(input) {
    const raw = String(input || "").trim();
    if (!raw) return { ok: false, reason: "项目不能为空。" };
    const byAlias = config.bridge.projectChoices.find((item) => item.alias === raw);
    const byPath = config.bridge.projectChoices.find((item) => item.path === raw);
    const projectPath = byAlias?.path || byPath?.path || resolveProjectPath(raw, config.bridge.defaultProjectPath);
    if (!existsSync(projectPath)) return { ok: false, reason: `路径不存在: ${projectPath}` };
    return { ok: true, path: projectPath, alias: this.projectAlias(projectPath) };
  }

  setActiveProject(chatId, projectPath) {
    this.activeProjects.set(chatId, projectPath);
    this.persistSessionState();
    return projectPath;
  }

  clearActiveProject(chatId) {
    const existed = this.activeProjects.delete(chatId);
    this.persistSessionState();
    return existed;
  }

  controlCardMessageId(chatId) {
    return this.controlCards.get(chatId) || "";
  }

  setControlCardMessageId(chatId, messageId) {
    if (!chatId || !messageId) return "";
    this.controlCards.set(chatId, messageId);
    this.persistSessionState();
    return messageId;
  }

  clearControlCardMessageId(chatId) {
    const existed = this.controlCards.delete(chatId);
    this.persistSessionState();
    return existed;
  }

  projectInfo(chatId) {
    const activePath = this.activeProjectPath(chatId);
    const lines = [
      `当前项目: ${this.projectAlias(activePath)}`,
      `路径: ${activePath}`,
      "",
      "可选项目:",
      ...config.bridge.projectChoices.map((item) => {
        const mark = item.path === activePath ? "*" : "-";
        return `${mark} ${item.alias} => ${item.path}`;
      }),
      "",
      "切换: /project <别名或路径>",
    ];
    return lines.join("\n");
  }

  modelOverride(chatId, projectPath) {
    return this.modelOverrides.get(sessionScopeKey(chatId, projectPath)) || "";
  }

  reasoningOverride(chatId, projectPath) {
    return this.reasoningOverrides.get(sessionScopeKey(chatId, projectPath)) || "";
  }

  effectiveModel(chatId, projectPath) {
    return effectiveCodexModel({
      configuredModel: config.codex.model,
      defaultModel: config.codex.defaultModel,
      scopedModel: this.modelOverride(chatId, projectPath),
    });
  }

  effectiveReasoning(chatId, projectPath) {
    return effectiveReasoningEffort({
      configuredEffort: config.codex.reasoningEffort,
      defaultEffort: config.codex.defaultReasoningEffort,
      scopedEffort: this.reasoningOverride(chatId, projectPath),
    });
  }

  modelInfo(chatId, projectPath) {
    const scopedModel = this.modelOverride(chatId, projectPath);
    const scopedReasoning = this.reasoningOverride(chatId, projectPath);
    const effectiveReasoning = this.effectiveReasoning(chatId, projectPath) || "未设置";
    const reasoningLine = scopedReasoning
      ? `当前推理强度覆盖: ${scopedReasoning}`
      : `当前未设置推理强度覆盖。\n生效推理强度: ${effectiveReasoning}`;
    if (scopedModel) {
      return `当前模型覆盖: ${scopedModel}\n${reasoningLine}\n作用范围: 当前飞书聊天窗口 + ${projectPath}\n清除: /model default 或 /reasoning default`;
    }
    const configuredModel = config.codex.model || config.codex.defaultModel || "";
    if (configuredModel) {
      const source = config.codex.model ? "CODEX_MODEL" : "~/.codex/config.toml";
      return `当前未设置聊天窗口模型覆盖。\n生效模型: ${configuredModel}（来自 ${source}）\n${reasoningLine}\n切换: /model gpt-5.5 high`;
    }
    return `当前未设置聊天窗口模型覆盖。\n生效模型: 由 Codex CLI 读取 ~/.codex/config.toml\n${reasoningLine}\n切换: /model gpt-5.5 high`;
  }

  setModelOverride(chatId, projectPath, model) {
    this.modelOverrides.set(sessionScopeKey(chatId, projectPath), model);
    this.persistSessionState();
    return model;
  }

  clearModelOverride(chatId, projectPath) {
    const existed = this.modelOverrides.delete(sessionScopeKey(chatId, projectPath));
    this.persistSessionState();
    return existed;
  }

  setReasoningOverride(chatId, projectPath, effort) {
    this.reasoningOverrides.set(sessionScopeKey(chatId, projectPath), effort);
    this.persistSessionState();
    return effort;
  }

  clearReasoningOverride(chatId, projectPath) {
    const existed = this.reasoningOverrides.delete(sessionScopeKey(chatId, projectPath));
    this.persistSessionState();
    return existed;
  }

  sessionSummaries(chatId, projectPath) {
    const scope = sessionScopeKey(chatId, projectPath);
    return [...this.sessions.entries()]
      .filter(([key]) => key.startsWith(`${scope}::`))
      .map(([, value]) => value)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  sessionInfo(chatId, projectPath) {
    const activeName = this.activeSessionName(chatId, projectPath);
    const entries = this.sessionStates(chatId, projectPath);
    if (entries.length === 0) {
      return `当前 active session: ${activeName}\n当前仓库还没有 Codex session 映射。`;
    }
    return [`当前 active session: ${activeName}`, ...entries
      .map((item) => {
        const mark = item.name === activeName ? "*" : "-";
        return [
          `${mark} ${item.name}`,
          `status=${item.status}`,
          item.taskId ? `task=${item.taskId}` : "",
          `turns=${item.turns}`,
          item.progress ? `progress=${item.progress}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })]
      .join("\n\n");
  }

  resetSession(chatId, projectPath, sessionName) {
    const normalized = this.setActiveSession(chatId, projectPath, sessionName);
    const key = sessionKey(chatId, projectPath, normalized);
    this.sessionResetAt.set(key, Date.now());
    const existed = this.sessions.delete(key);
    this.persistSessionState();
    return { sessionName: normalized, existed };
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || ["success", "failed", "cancelled"].includes(task.status)) return false;
    task.status = "cancelled";
    if (this.activeTasks.has(taskId)) this.killActive(taskId);
    return true;
  }

  pendingCount(chatId = null) {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (chatId && task.source.chatId !== chatId) continue;
      if (["pending", "running"].includes(task.status)) count += 1;
    }
    return count;
  }

  pendingCountForSession(chatId, projectPath, sessionName) {
    const normalized = normalizeSessionName(sessionName);
    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        task.source.chatId === chatId &&
        task.projectPath === projectPath &&
        (task.sessionName || "default") === normalized &&
        ["pending", "running"].includes(task.status)
      ) {
        count += 1;
      }
    }
    return count;
  }

  sessionStates(chatId, projectPath) {
    const activeName = this.activeSessionName(chatId, projectPath);
    const saved = new Map(this.sessionSummaries(chatId, projectPath).map((item) => [item.name, item]));
    const scope = sessionScopeKey(chatId, projectPath);
    const knownNames = [...this.knownSessions]
      .filter((key) => key.startsWith(`${scope}::`))
      .map((key) => key.slice(scope.length + 2));
    const names = new Set([activeName, ...saved.keys(), ...knownNames]);
    for (const task of this.tasks.values()) {
      if (task.source.chatId === chatId && task.projectPath === projectPath) {
        names.add(task.sessionName || "default");
      }
    }

    return [...names]
      .map((name) => {
        const session = saved.get(name);
        const tasks = [...this.tasks.values()]
          .filter(
            (task) =>
              task.source.chatId === chatId &&
              task.projectPath === projectPath &&
              (task.sessionName || "default") === name
          )
          .sort((a, b) => b.createdAt - a.createdAt);
        const activeTask =
          tasks.find((task) => ["running", "pending"].includes(task.status)) || tasks[0] || null;
        const status = activeTask ? activeTask.status : session ? "idle" : "new";
        const progress =
          activeTask
            ? compactText(activeTask.progress || activeTask.output || activeTask.error) ||
              (activeTask.status === "pending" ? "排队中" : "执行中")
            : session
              ? `last updated ${session.updatedAt}`
              : "下一条消息会新开 Codex 对话";
        return {
          name,
          status,
          taskId: activeTask?.taskId || "",
          progress,
          turns: session?.turns || 0,
          updatedAt: session?.updatedAt || "",
          isActive: name === activeName,
        };
      })
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        const activeA = ["running", "pending"].includes(a.status);
        const activeB = ["running", "pending"].includes(b.status);
        if (activeA !== activeB) return activeA ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  async create(source, projectPath, prompt, sessionName, imageKey = "") {
    const normalizedSessionName = normalizeSessionName(sessionName);
    const ahead = this.pendingCountForSession(source.chatId, projectPath, normalizedSessionName);
    const task = {
      taskId: generateTaskId(),
      source,
      projectPath,
      sessionName: normalizedSessionName,
      prompt,
      imageKey,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      output: "",
      error: null,
      statusMessageId: null,
      progress: "",
      lastEventAt: null,
      modelOverride: this.modelOverride(source.chatId, projectPath),
      reasoningOverride: this.reasoningOverride(source.chatId, projectPath),
      model: this.effectiveModel(source.chatId, projectPath),
    };
    this.tasks.set(task.taskId, task);
    try {
      const queueText =
        ahead > 0
          ? `Codex 已收到任务 ${task.taskId}，session=${task.sessionName}，已加入该会话队列，前面还有 ${ahead} 个任务。`
          : `Codex 已收到任务 ${task.taskId}，session=${task.sessionName}，即将开始执行。`;
      task.statusMessageId = await this.messenger.replyText(task.source.messageId, queueText);
    } catch (error) {
      log("warn", "failed to send queue reply", { taskId: task.taskId, error: String(error) });
    }
    const key = sessionKey(task.source.chatId, task.projectPath, task.sessionName);
    const queue = this.sessionQueues.get(key) || Promise.resolve();
    this.sessionQueues.set(key, queue.then(() => this.run(task)).catch((error) => {
      log("error", "task queue error", { taskId: task.taskId, error: String(error) });
    }));
    return task;
  }

  buildArgs(task, lastMessageFile) {
    const existing = this.sessions.get(sessionKey(task.source.chatId, task.projectPath, task.sessionName));
    const args = [];
    if (canResumeCodexSession({ session: existing, model: task.model })) {
      args.push("exec", "resume", "--json", "-o", lastMessageFile);
      this.appendCodexOptions(args, {
        isResume: true,
        modelOverride: task.modelOverride,
        reasoningOverride: task.reasoningOverride,
      });
      args.push(...buildImageArgs(task.imagePath));
      args.push(existing.threadId, "-");
      return args;
    }
    args.push("exec", "--json", "-o", lastMessageFile, "-C", task.projectPath);
    this.appendCodexOptions(args, {
      isResume: false,
      modelOverride: task.modelOverride,
      reasoningOverride: task.reasoningOverride,
    });
    args.push(...buildImageArgs(task.imagePath));
    args.push("-");
    return args;
  }

  appendCodexOptions(args, { isResume, modelOverride = "", reasoningOverride = "" }) {
    args.push(...buildModelArgs({
      configuredModel: config.codex.model,
      defaultModel: config.codex.defaultModel,
      scopedModel: modelOverride,
    }));
    const reasoningEffort = effectiveReasoningEffort({
      configuredEffort: config.codex.reasoningEffort,
      defaultEffort: config.codex.defaultReasoningEffort,
      scopedEffort: reasoningOverride,
    });
    if (config.codex.profile) args.push("-p", config.codex.profile);
    for (const override of config.codex.configOverrides) {
      args.push("-c", override);
    }
    const reasoningOverrideArg = codexConfigOverrideForReasoning(reasoningEffort);
    if (reasoningOverrideArg) args.push("-c", reasoningOverrideArg);
    if (config.codex.approvalPolicy) {
      args.push("-c", `approval_policy="${config.codex.approvalPolicy}"`);
    }
    if (config.codex.enableWebSearch && !isResume) args.push("--search");
    if (config.codex.dangerousBypass) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else if (config.codex.fullAuto) {
      args.push("--full-auto");
    } else if (!isResume && config.codex.sandboxMode) {
      args.push("--sandbox", config.codex.sandboxMode);
    }
  }

  async run(task) {
    if (task.status === "cancelled") return;
    task.status = "running";
    task.startedAt = Date.now();
    task.lastEventAt = task.startedAt;
    const lastMessageFile = path.join(tmpdir(), `feishu-codex-${task.taskId}.txt`);
    let imageDownloadPath = "";
    let pushTimer = null;
    let lastPushed = "";

    try {
      if (task.statusMessageId) {
        await this.messenger.updateText(task.statusMessageId, `Codex 开始执行任务 ${task.taskId}...`);
      } else {
        task.statusMessageId = await this.messenger.replyText(
          task.source.messageId,
          `Codex 开始执行任务 ${task.taskId}...`
        );
      }
    } catch (error) {
      log("warn", "failed to send initial reply", { taskId: task.taskId, error: String(error) });
    }

    const push = async (force = false) => {
      if (!task.statusMessageId) return;
      const now = Date.now();
      const elapsed = task.startedAt ? formatDuration(now - task.startedAt) : "0s";
      const lastEventAgo = task.lastEventAt ? formatDuration(now - task.lastEventAt) : "unknown";
      const body = truncateText(task.output || task.progress || "Codex 正在执行，暂时还没有可展示输出。");
      const text = `${body}\n\n状态: ${task.status}  task=${task.taskId}  elapsed=${elapsed}  last_event=${lastEventAgo} ago`;
      if (!force && text === lastPushed) return;
      lastPushed = text;
      try {
        await this.messenger.updateText(task.statusMessageId, text);
      } catch (error) {
        log("warn", "failed to update status message", { taskId: task.taskId, error: String(error) });
      }
    };

    try {
      pushTimer = setInterval(() => {
        push(false).catch((error) => log("warn", "periodic push failed", { error: String(error) }));
      }, config.bridge.streamPushInterval);

      if (task.imageKey) {
        imageDownloadPath = path.join(tmpdir(), `feishu-codex-${task.taskId}-image.download`);
        const downloaded = await this.messenger.downloadMessageResource(
          task.source.messageId,
          task.imageKey,
          imageDownloadPath
        );
        const extensionByType = {
          "image/jpeg": ".jpg",
          "image/png": ".png",
          "image/gif": ".gif",
          "image/webp": ".webp",
          "image/bmp": ".bmp",
        };
        const extension = extensionByType[downloaded.contentType] || ".png";
        task.imagePath = imageDownloadPath.replace(/\.download$/, extension);
        renameSync(imageDownloadPath, task.imagePath);
        log("info", "downloaded Feishu image", {
          taskId: task.taskId,
          contentType: downloaded.contentType || "unknown",
          imagePath: task.imagePath,
        });
      }

      const args = this.buildArgs(task, lastMessageFile);
      const spawnArgs = [...codexLauncher.argsPrefix, ...args];
      log("info", "starting codex", {
        taskId: task.taskId,
        cwd: task.projectPath,
        command: codexLauncher.command,
        args: spawnArgs,
      });

      await new Promise((resolve, reject) => {
        const child = spawn(codexLauncher.command, spawnArgs, {
          cwd: task.projectPath,
          env: { ...process.env },
          shell: codexLauncher.shell,
          stdio: ["pipe", "pipe", "pipe"],
        });
        this.activeTasks.set(task.taskId, child);
        child.stdin?.on("error", (error) => {
          log("debug", "codex stdin error", { taskId: task.taskId, error: String(error) });
        });
        child.stdin?.end(task.prompt, "utf8");

      let stdoutBuffer = "";
      let stderrTail = "";
      let threadId = null;
      let settled = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timeout = setTimeout(() => {
        task.status = "timeout";
        this.killActive(task.taskId);
        settle(() => reject(new Error(`Codex task timeout after ${config.codex.taskTimeout / 1000}s`)));
      }, config.codex.taskTimeout);

      child.stdout?.on("data", (chunk) => {
        task.lastEventAt = Date.now();
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            if (event.thread_id && !threadId) threadId = event.thread_id;
            const progress = describeCodexProgressEvent(event);
            if (progress && progress !== task.progress) {
              task.progress = progress;
              log("info", "codex progress", { taskId: task.taskId, progress });
            }
            appendTaskOutput(task, extractCodexTextEvent(event));
          } catch {
            appendTaskOutput(task, trimmed);
          }
        }
      });

      child.stderr?.on("data", (chunk) => {
        task.lastEventAt = Date.now();
        const text = chunk.toString("utf8");
        stderrTail = `${stderrTail}${text}`.slice(-4000);
        log("debug", "codex stderr", { taskId: task.taskId, text: text.trim() });
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        this.activeTasks.delete(task.taskId);
        settle(() => reject(error));
      });

      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        this.activeTasks.delete(task.taskId);
        if (stdoutBuffer.trim()) {
          try {
            const event = JSON.parse(stdoutBuffer.trim());
            if (event.thread_id && !threadId) threadId = event.thread_id;
            const progress = describeCodexProgressEvent(event);
            if (progress && progress !== task.progress) {
              task.progress = progress;
              log("info", "codex progress", { taskId: task.taskId, progress });
            }
            appendTaskOutput(task, extractCodexTextEvent(event));
          } catch {
            appendTaskOutput(task, stdoutBuffer.trim());
          }
        }
        if (existsSync(lastMessageFile)) {
          const finalMessage = readFileSync(lastMessageFile, "utf8").trim();
          if (finalMessage) task.output = finalMessage;
        }
        if (threadId) {
          const key = sessionKey(task.source.chatId, task.projectPath, task.sessionName);
          const resetAt = this.sessionResetAt.get(key) || 0;
          if (task.createdAt >= resetAt) {
            const existing = this.sessions.get(key);
            this.markKnownSession(task.source.chatId, task.projectPath, task.sessionName);
            this.sessions.set(key, {
              name: task.sessionName,
              threadId,
              model: task.model,
              projectPath: task.projectPath,
              turns: (existing?.turns || 0) + 1,
              updatedAt: new Date().toISOString(),
            });
            this.persistSessionState();
          }
        }
        if (exitCode === 0 || task.status === "cancelled") {
          settle(resolve);
        } else {
          const detail = task.output || stderrTail || `Codex exit code ${exitCode}`;
          settle(() => reject(new Error(detail.slice(-2000))));
        }
      });
    });

    if (task.status === "cancelled") return;
    task.status = "success";
  } catch (error) {
    if (task.status !== "cancelled") {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      if (!task.output) task.output = task.error;
    }
  } finally {
    if (pushTimer) clearInterval(pushTimer);
    task.finishedAt = Date.now();
    const seconds = ((task.finishedAt - task.startedAt) / 1000).toFixed(1);
    const finalText =
      task.status === "success"
        ? `${truncateText(task.output || "Codex 已完成。")}\n\n完成: ${seconds}s  task=${task.taskId}`
        : task.status === "cancelled"
          ? `已取消 task=${task.taskId}`
          : `执行失败 task=${task.taskId}\n\n${truncateText(task.output || task.error || "unknown error")}`;
    try {
      if (task.statusMessageId) await this.messenger.updateText(task.statusMessageId, finalText);
      else await this.messenger.sendText(task.source.chatId, finalText);
    } catch (error) {
      log("warn", "failed to send final message", { taskId: task.taskId, error: String(error) });
    }
    rmSync(lastMessageFile, { force: true });
    if (imageDownloadPath) rmSync(imageDownloadPath, { force: true });
    if (task.imagePath) rmSync(task.imagePath, { force: true });
    log("info", "task finished", { taskId: task.taskId, status: task.status, seconds });
  }
  }

  killActive(taskId = null) {
    if (!taskId) {
      for (const activeTaskId of [...this.activeTasks.keys()]) this.killActive(activeTaskId);
      return;
    }
    const child = this.activeTasks.get(taskId);
    if (!child) return;
    log("info", "killing active codex process", { taskId });
    try {
      child.kill("SIGINT");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 3000);
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5000);
    } catch {
      // Ignore process shutdown races.
    }
    this.activeTasks.delete(taskId);
  }
}

const client = new Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
});
const messenger = new FeishuMessenger(client);
const runner = new TaskRunner(messenger);
const allowedUserIds = new Set(config.bridge.allowedUserIds);
let pairingCode = allowedUserIds.size === 0 ? makePairingCode() : null;

async function showControlCard(chatId, replyToMessageId, notice = "") {
  const projectPath = runner.activeProjectPath(chatId);
  const card = buildControlCard(runner, chatId, projectPath, notice);
  const messageId = await messenger.replyCard(replyToMessageId, card);
  if (messageId) runner.setControlCardMessageId(chatId, messageId);
  return messageId;
}

if (pairingCode) {
  log("info", "pairing required", {
    pairingCode,
    hint: "Send this code to the Feishu bot to bind your open_id.",
  });
} else {
  log("info", "allowlist enabled", { allowedUserIds: [...allowedUserIds] });
}

async function handleMessage(message) {
  log("info", "message received", {
    senderId: message.senderId,
    chatId: message.chatId,
    chatType: message.chatType,
    rawText: message.rawText?.slice(0, 120),
    text: message.text.slice(0, 120),
  });

  if (pairingCode && message.text.trim() === pairingCode) {
    allowedUserIds.add(message.senderId);
    pairingCode = null;
    saveAllowedUserId(message.senderId);
    await messenger.replyText(message.messageId, "配对成功，已绑定你的飞书 open_id。");
    return;
  }

  if (allowedUserIds.size > 0 && !allowedUserIds.has(message.senderId)) {
    log("warn", "ignored unauthorized sender", { senderId: message.senderId });
    return;
  }

  const command = message.imageKey
    ? { type: "run", prompt: message.text || "请分析这张图片并回答。" }
    : parseCommand(message.text);
  if (command.type === "help") {
    await messenger.replyText(message.messageId, getHelpMessage());
    return;
  }
  if (command.type === "panel" || command.type === "project") {
    await refreshProjectChoices(command.type);
  }
  if (command.type === "panel") {
    await showControlCard(message.chatId, message.messageId, "控制卡片已打开");
    return;
  }
  const activeProjectPath = runner.activeProjectPath(message.chatId);
  if (command.type === "sessions") {
    await messenger.replyText(message.messageId, runner.sessionInfo(message.chatId, activeProjectPath));
    return;
  }
  if (command.type === "use") {
    const sessionName = runner.setActiveSession(message.chatId, activeProjectPath, command.sessionName);
    await messenger.replyText(message.messageId, `已切换到 session=${sessionName}`);
    return;
  }
  if (command.type === "new") {
    const targetName =
      command.sessionName || runner.activeSessionName(message.chatId, activeProjectPath);
    const result = runner.resetSession(message.chatId, activeProjectPath, targetName);
    await messenger.replyText(
      message.messageId,
      result.existed
        ? `已重置并切换到 session=${result.sessionName}`
        : `已切换到新的 session=${result.sessionName}`
    );
    return;
  }
  if (command.type === "project") {
    if (command.action === "show") {
      await messenger.replyText(message.messageId, runner.projectInfo(message.chatId));
      return;
    }
    if (command.action === "clear") {
      runner.clearActiveProject(message.chatId);
      await messenger.replyText(message.messageId, `已切回默认项目: ${config.bridge.defaultProjectPath}`);
      return;
    }
    const resolved = runner.resolveProjectSelection(command.project);
    if (!resolved.ok) {
      await messenger.replyText(message.messageId, `项目无效：${resolved.reason}`);
      return;
    }
    runner.setActiveProject(message.chatId, resolved.path);
    await messenger.replyText(message.messageId, `已切换当前聊天窗口项目为 ${resolved.alias}: ${resolved.path}`);
    return;
  }
  if (command.type === "model") {
    if (command.action === "show") {
      await messenger.replyText(message.messageId, runner.modelInfo(message.chatId, activeProjectPath));
      return;
    }
    if (command.action === "clear") {
      const existed = runner.clearModelOverride(message.chatId, activeProjectPath);
      await messenger.replyText(
        message.messageId,
        existed
          ? "已清除当前聊天窗口的模型覆盖；后续任务会回到 CODEX_MODEL 或 ~/.codex/config.toml。"
          : "当前聊天窗口没有模型覆盖；后续任务仍使用 CODEX_MODEL 或 ~/.codex/config.toml。"
      );
      return;
    }
    const validation = validateModelName(command.model);
    if (!validation.ok) {
      await messenger.replyText(message.messageId, `模型名无效：${validation.reason}`);
      return;
    }
    runner.setModelOverride(message.chatId, activeProjectPath, validation.model);
    let reasoningNotice = "";
    if (command.reasoningEffort) {
      const effortValidation = validateReasoningEffort(command.reasoningEffort);
      if (!effortValidation.ok) {
        await messenger.replyText(message.messageId, `推理强度无效：${effortValidation.reason}`);
        return;
      }
      runner.setReasoningOverride(message.chatId, activeProjectPath, effortValidation.effort);
      reasoningNotice = `\n推理强度: ${effortValidation.effort}`;
    }
    await messenger.replyText(
      message.messageId,
      `已切换当前聊天窗口后续任务模型为 ${validation.model}。${reasoningNotice}\n清除可发送 /model default 或 /reasoning default。`
    );
    return;
  }
  if (command.type === "reasoning") {
    if (command.action === "show") {
      await messenger.replyText(message.messageId, runner.modelInfo(message.chatId, activeProjectPath));
      return;
    }
    if (command.action === "clear") {
      const existed = runner.clearReasoningOverride(message.chatId, activeProjectPath);
      await messenger.replyText(
        message.messageId,
        existed
          ? "已清除当前项目的推理强度覆盖；后续任务会回到 CODEX_REASONING_EFFORT 或 ~/.codex/config.toml。"
          : "当前项目没有推理强度覆盖；后续任务仍使用 CODEX_REASONING_EFFORT 或 ~/.codex/config.toml。"
      );
      return;
    }
    const validation = validateReasoningEffort(command.reasoningEffort);
    if (!validation.ok) {
      await messenger.replyText(message.messageId, `推理强度无效：${validation.reason}`);
      return;
    }
    runner.setReasoningOverride(message.chatId, activeProjectPath, validation.effort);
    await messenger.replyText(message.messageId, `已切换当前项目后续任务推理强度为 ${validation.effort}。`);
    return;
  }
  if (command.type === "status") {
    const task = command.taskId ? runner.tasks.get(command.taskId) : runner.recentTask(message.chatId);
    const parts = [runner.projectInfo(message.chatId), runner.sessionInfo(message.chatId, activeProjectPath)];
    if (task) {
      const elapsed = task.startedAt ? ((Date.now() - task.startedAt) / 1000).toFixed(1) : "0.0";
      parts.push(`最近任务: ${task.taskId}\nsession=${task.sessionName}\nstatus=${task.status}\nelapsed=${elapsed}s`);
    } else {
      parts.push("最近任务: 无");
    }
    await messenger.replyText(message.messageId, parts.join("\n\n"));
    return;
  }
  if (command.type === "cancel") {
    const ok = runner.cancelTask(command.taskId);
    await messenger.replyText(message.messageId, ok ? "已取消。" : "无法取消，任务可能已完成或不存在。");
    return;
  }
  if (command.type !== "run") {
    await messenger.replyText(message.messageId, "无法识别指令，发送 /help 查看用法。");
    return;
  }
  if (!command.prompt) {
    await messenger.replyText(message.messageId, "请输入任务描述。");
    return;
  }

  const projectPath = command.projectPath
    ? resolveProjectPath(command.projectPath, config.bridge.defaultProjectPath)
    : runner.activeProjectPath(message.chatId);
  if (!existsSync(projectPath)) {
    await messenger.replyText(message.messageId, `路径不存在: ${projectPath}`);
    return;
  }

  const sessionName = runner.activeSessionName(message.chatId, projectPath);
  const task = await runner.create(
    {
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.senderId,
    },
    projectPath,
    command.prompt,
    sessionName,
    message.imageKey
  );
  log("info", "task queued", { taskId: task.taskId, projectPath, sessionName: task.sessionName });
}

const executeCardActionSerially = createKeyedSerialExecutor();

async function handleCardAction(raw) {
  const event = normalizeCardAction(raw, { includeRaw: true });
  if (!event) {
    log("warn", "ignored unrecognized card action", {
      keys: raw && typeof raw === "object" ? Object.keys(raw) : [],
    });
    return;
  }
  return executeCardActionSerially(event.messageId, () => handleNormalizedCardAction(event));
}

async function handleNormalizedCardAction(event) {
  if (allowedUserIds.size > 0 && !allowedUserIds.has(event.operator.openId)) {
    log("warn", "ignored unauthorized card action", { senderId: event.operator.openId });
    return;
  }
  const value = parseCardActionValue(event.action?.value);
  if (!value || typeof value !== "object" || value.bridge !== CARD_BRIDGE_ID) {
    log("debug", "ignored foreign card action", { action: event.action });
    return;
  }

  const actionChatId = typeof value.scopeChatId === "string" && value.scopeChatId
    ? value.scopeChatId
    : event.chatId;
  const cardProjectPath =
    typeof value.projectPath === "string" && value.projectPath
      ? resolveProjectPath(value.projectPath, config.bridge.defaultProjectPath)
      : config.bridge.defaultProjectPath;
  if (!actionChatId) {
    log("warn", "card action missing chat scope", { action: value.action, event });
    return;
  }
  const currentCardMessageId = runner.controlCardMessageId(actionChatId);
  if (
    isStaleControlCardAction({
      currentMessageId: currentCardMessageId,
      actionMessageId: event.messageId,
    })
  ) {
    log("warn", "ignored action from stale control card", {
      action: value.action,
      actionMessageId: event.messageId,
      currentCardMessageId,
      chatId: actionChatId,
    });
    return;
  }
  if (!currentCardMessageId) {
    runner.setControlCardMessageId(actionChatId, event.messageId);
  }
  if (shouldRefreshProjectChoicesForCardAction(value.action)) {
    await refreshProjectChoices(`card:${value.action}`);
  }
  const projectPath = cardProjectPathForAction({
    activeProjectPath: runner.activeProjectPath(actionChatId),
    cardProjectPath,
    defaultProjectPath: config.bridge.defaultProjectPath,
  });
  let notice = "";
  if (value.action === "refresh" || value.action === "show_sessions") {
    notice = "已刷新";
  } else if (value.action === "set_project") {
    const targetProjectPath = typeof value.targetProjectPath === "string" ? value.targetProjectPath : "";
    const resolved = runner.resolveProjectSelection(targetProjectPath);
    if (resolved.ok) {
      runner.setActiveProject(actionChatId, resolved.path);
      notice = `已切换项目为 ${resolved.alias}`;
      await messenger.updateCard(event.messageId, buildControlCard(runner, actionChatId, resolved.path, notice));
      return;
    }
    notice = `项目无效: ${resolved.reason}`;
  } else if (value.action === "set_model") {
    const validation = validateModelName(value.model);
    if (validation.ok) {
      runner.setModelOverride(actionChatId, projectPath, validation.model);
      notice = `已切换模型为 ${validation.model}`;
    } else {
      notice = `模型无效: ${validation.reason}`;
    }
  } else if (value.action === "clear_model") {
    const existed = runner.clearModelOverride(actionChatId, projectPath);
    notice = existed ? "已清除模型覆盖" : "当前没有模型覆盖";
  } else if (value.action === "set_reasoning") {
    const validation = validateReasoningEffort(value.reasoningEffort);
    if (validation.ok) {
      runner.setReasoningOverride(actionChatId, projectPath, validation.effort);
      notice = `已切换推理强度为 ${validation.effort}`;
    } else {
      notice = `推理强度无效: ${validation.reason}`;
    }
  } else if (value.action === "clear_reasoning") {
    const existed = runner.clearReasoningOverride(actionChatId, projectPath);
    notice = existed ? "已清除推理强度覆盖" : "当前没有推理强度覆盖";
  } else if (value.action === "use_session") {
    const sessionName = runner.setActiveSession(actionChatId, projectPath, value.sessionName);
    notice = `已切换到 session=${sessionName}`;
  } else if (value.action === "new_session") {
    const sessionName = runner.setActiveSession(
      actionChatId,
      projectPath,
      `session-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`
    );
    notice = `已新建并切换到 session=${sessionName}`;
  } else if (value.action === "reset_active_session") {
    const activeName = runner.activeSessionName(actionChatId, projectPath);
    const result = runner.resetSession(actionChatId, projectPath, activeName);
    notice = result.existed
      ? `已重置 session=${result.sessionName}`
      : `当前 session=${result.sessionName} 尚无映射，已保持为 active`;
  } else if (value.action === "cancel_task") {
    const taskId = typeof value.taskId === "string" ? value.taskId : "";
    const ok = taskId ? runner.cancelTask(taskId) : false;
    notice = ok ? `已取消 task=${taskId}` : `无法取消 task=${taskId || "unknown"}，任务可能已完成或不存在`;
  } else {
    notice = `未知动作: ${value.action}`;
  }

  await messenger.updateCard(event.messageId, buildControlCard(runner, actionChatId, projectPath, notice));
}

const dispatcher = new EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    log("info", "raw Feishu message event received", {
      keys: data && typeof data === "object" ? Object.keys(data) : [],
      eventKeys: data?.event && typeof data.event === "object" ? Object.keys(data.event) : [],
    });
    const parsed = parseMessageEvent(data);
    if (!parsed) return;
    try {
      await handleMessage(parsed);
    } catch (error) {
      log("error", "message handler failed", { error: String(error) });
      try {
        await messenger.replyText(parsed.messageId, `处理消息失败: ${String(error)}`);
      } catch {
        // Nothing else to do if Feishu reply fails.
      }
    }
  },
  "card.action.trigger": async (data) => {
    log("info", "card action received", {
      keys: data && typeof data === "object" ? Object.keys(data) : [],
      eventKeys: data?.event && typeof data.event === "object" ? Object.keys(data.event) : [],
    });
    const raw = data?.event ? data.event : data;
    try {
      await handleCardAction(raw);
    } catch (error) {
      log("error", "card action handler failed", { error: String(error) });
    }
  },
});

const wsClient = new WSClient({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  loggerLevel: 2,
});

log("info", "starting Feishu Codex bridge", {
  configPath: CONFIG_PATH,
  sessionStatePath: config.bridge.sessionStatePath,
  defaultProjectPath: config.bridge.defaultProjectPath,
  codexBin: config.codex.bin,
});
await wsClient.start({ eventDispatcher: dispatcher });
log("info", "Feishu WebSocket connected; waiting for messages");

await refreshProjectChoices("startup");
let projectRefreshTimer = null;
if (
  config.bridge.projectDiscovery === "thread-list" &&
  config.bridge.projectDiscoveryInterval > 0
) {
  projectRefreshTimer = setInterval(() => {
    refreshProjectChoices("interval").catch((error) => {
      log("warn", "periodic project discovery failed", { error: String(error) });
    });
  }, config.bridge.projectDiscoveryInterval);
}

function shutdown(signal) {
  log("info", "shutting down", { signal });
  if (projectRefreshTimer) clearInterval(projectRefreshTimer);
  runner.killActive();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  log("error", "uncaught exception", { error: String(error) });
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled rejection", { reason: String(reason) });
});
