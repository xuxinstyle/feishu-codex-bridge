import { Client, EventDispatcher, WSClient, normalizeCardAction } from "@larksuiteoapi/node-sdk";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  assertFeishuApiSuccess,
  buildModelChoiceGroups,
  cardProjectPathForAction,
  createKeyedSerialExecutor,
  createMessageDeduper,
  effectiveCodexModel,
  effectiveReasoningEffort,
  findFeishuApiErrorCode,
  mergeProjectChoices,
  parseCodexConfigDefaults,
  parseFeishuImageContent,
  parseCommand,
  parseProjectChoices,
  selectGeneratedImagesForTask,
  shouldRefreshProjectChoicesForCardAction,
  isStaleControlCardAction,
  updateOrRotateTextMessage,
  validateModelName,
  validateReasoningEffort,
} from "./bridge-core.mjs";
import { discoverCodexProjectPaths } from "./codex-projects.mjs";
import { APP_SERVER_SESSION_BACKEND, canResumeAppServerSession, desktopCodexBinary, runAppServerTask } from "./codex-app-server.mjs";
import { runDesktopTask } from "./codex-desktop.mjs";
import { TaskSteering } from "./task-steering.mjs";
import { uploadAndSendFeishuImage } from "./feishu-media.mjs";
import { SessionTaskQueue } from "./task-queue.mjs";
import { TaskInterruption } from "./task-interruption.mjs";
import { buildPanelCard, buildTaskCard } from "./feishu-cards.mjs";

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
    transport: optionalEnv("CODEX_TASK_TRANSPORT", "desktop"),
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
    generatedImageMaxCount: optionalIntEnv("GENERATED_IMAGE_MAX_COUNT", 4),
    streamPushInterval: optionalIntEnv("STREAM_PUSH_INTERVAL", 30_000),
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
const codexLauncher = resolveCodexLauncher(desktopCodexBinary(config.codex.bin));
if (!["desktop", "app-server"].includes(config.codex.transport)) {
  throw new Error("CODEX_TASK_TRANSPORT must be desktop or app-server");
}

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
    const startedAt = Date.now();
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
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      log("warn", "failed to refresh project choices from Codex thread history", {
        reason,
        error: String(error),
        retainedCount: config.bridge.projectChoices.length,
        durationMs: Date.now() - startedAt,
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
      eventId: data?.event_id || data?.event?.event_id || "",
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
    "- 直接发送图片：交给 Codex 分析图片",
    "- 连续发送多个任务会排队执行，不会自动取消前一个任务",
    "- 排队文字消息可点击「引导」提交给当前任务，不中断运行；也可发送 /steer 补充要求",
    "- /sessions：查看当前仓库的 Codex session",
    "- /use <名字>：切换当前聊天窗口的 active session",
    "- /new <名字>：新建/重置命名 session 并切换过去",
    "- /new：清除当前 active session 映射",
    "- /model：查看当前聊天窗口的模型覆盖",
    "- /model <模型名>：切换当前聊天窗口后续任务使用的模型，例如 /model gpt-5.5",
    "- /panel → 设置：切换模型和推理强度；其他模型可直接用 /model <模型名>",
    "- /model <模型名> <推理强度>：同时切换模型和推理强度，例如 /model gpt-5.5 high",
    "- /model default：清除模型覆盖，回到 CODEX_MODEL 或 ~/.codex/config.toml",
    "- /reasoning <low|medium|high|xhigh|max|ultra>：切换当前项目的推理强度",
    "- /reasoning default：清除推理强度覆盖，回到 CODEX_REASONING_EFFORT 或 ~/.codex/config.toml",
    "- /project：查看当前聊天窗口项目",
    "- /project <别名或路径>：切换当前聊天窗口后续任务使用的项目",
    "- /status：查看最近任务",
    "- /stop 或 停止：停止当前任务，暂停当前会话旧待办",
    "- /resume 或 继续：继续最近停止的任务",
    "- /queue：查看待办并恢复执行",
    "- /cancel task-xxxx：取消排队，或停止指定任务",
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
    assertFeishuApiSuccess(res, "发送任务卡片");
    return res?.data?.message_id;
  }

  async sendCard(chatId, card) {
    const res = await this.client.im.message.create({ params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    });
    assertFeishuApiSuccess(res, "发送任务卡片");
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

  async sendImage(chatId, filePath) {
    return uploadAndSendFeishuImage(this.client, chatId, filePath);
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

function buildControlCard(runner, chatId, projectPath, notice = "", view = "home", page = 0, scopedSession = null) {
  const sessionName = scopedSession || runner.activeSessionName(chatId, projectPath);
  const tasks = [...runner.tasks.values()].filter(task => task.source.chatId === chatId && task.projectPath === projectPath && task.sessionName === sessionName)
    .sort((a, b) => b.createdAt - a.createdAt);
  const task = tasks.find(t => ["running", "stopping"].includes(t.status)) || tasks.find(t => !["steered", "steer_unknown"].includes(t.status));
  return buildPanelCard({ chatId, projectPath, projectLabel: runner.projectAlias(projectPath), sessionName, task, notice, view, page,
    model: runner.effectiveModel(chatId, projectPath), reasoning: runner.effectiveReasoning(chatId, projectPath),
    projects: config.bridge.projectChoices, models: [...(config.codex.modelGroups?.codex || []), ...(config.codex.modelGroups?.grok || [])],
    reasoningChoices: config.codex.reasoningEffortChoices || [], sessions: runner.sessionStates(chatId, projectPath),
    queued: runner.queue.queued(sessionKey(chatId, projectPath, sessionName)), paused: runner.queue.isPaused(sessionKey(chatId, projectPath, sessionName)),
  });
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
    this.messageDeduper = createMessageDeduper({
      initialEntries: state.handledMessageIds,
    });
    this.sessionResetAt = new Map();
    this.sessionGenerations = new Map();
    this.activeTasks = new Map();
    this.sessionQueues = new Map();
    this.publishSerial = createKeyedSerialExecutor();
    this.queue = new SessionTaskQueue({ run: task => this.run(task), paused: state.pausedQueues || [],
      onChange: () => this.persistSessionState(), onError: (error, task) => log("error", "task queue error", { taskId: task.taskId, error: String(error) }),
    });
    this.interruption = new TaskInterruption({ tasks: this.tasks, controls: this.activeTasks,
      pause: task => this.queue.pause(sessionKey(task.source.chatId, task.projectPath, task.sessionName)),
      isCurrent: task => task.sessionGeneration === (this.sessionGenerations.get(sessionKey(task.source.chatId, task.projectPath, task.sessionName)) || 0),
      onChange: task => { this.publishTaskText(task, task.status === "stopping" ? "正在请求停止当前任务…" : "").catch(error => log("warn", "task card update failed", { error: String(error) })); },
      onError: (task, error) => log("warn", "task interruption failed", { taskId: task.taskId, error: String(error) }),
    });
    this.steering = new TaskSteering({ tasks: this.tasks, controls: this.activeTasks,
      isCurrent: task => task.sessionGeneration === (this.sessionGenerations.get(sessionKey(task.source.chatId, task.projectPath, task.sessionName)) || 0),
    });
  }

  persistSessionState() {
    writeSessionState({
      version: 1,
      pausedQueues: this.queue.snapshot(),
      savedAt: new Date().toISOString(),
      sessions: [...this.sessions.entries()],
      activeSessions: [...this.activeSessions.entries()],
      activeProjects: [...this.activeProjects.entries()],
      knownSessions: [...this.knownSessions],
      modelOverrides: [...this.modelOverrides.entries()],
      reasoningOverrides: [...this.reasoningOverrides.entries()],
      controlCards: [...this.controlCards.entries()],
      handledMessageIds: this.messageDeduper.snapshot(),
    });
  }

  claimMessage(messageId) {
    const claimed = this.messageDeduper.claim(messageId);
    if (claimed && messageId) this.persistSessionState();
    return claimed;
  }

  releaseMessage(messageId) {
    this.messageDeduper.release(messageId);
    if (messageId) this.persistSessionState();
  }

  async publishTaskText(task, text = "", { rotateOnAnyUpdateError = false } = {}) {
    if (!task) return;
    return this.publishSerial(task.taskId, async () => {
      const card = buildTaskCard(task, { projectLabel: this.projectAlias(task.projectPath), text,
        pendingCount: this.queue.queued(sessionKey(task.source.chatId, task.projectPath, task.sessionName)).length,
        paused: this.queue.isPaused(sessionKey(task.source.chatId, task.projectPath, task.sessionName)),
      });
      const result = await updateOrRotateTextMessage({ messageId: task.statusMessageId, text: card,
        updateText: (id, next) => this.messenger.updateCard(id, next),
        createText: next => this.messenger.sendCard(task.source.chatId, next), rotateOnAnyUpdateError,
      });
      task.statusMessageId = result.messageId || null;
      if (task.steerTargetTaskId && task.status === "pending") task.steerCardMessageId = task.statusMessageId;
      return result;
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
    this.sessionGenerations.set(key, (this.sessionGenerations.get(key) || 0) + 1);
    const existed = this.sessions.delete(key);
    this.persistSessionState();
    return { sessionName: normalized, existed };
  }

  stopTask(taskId, scope) { return this.interruption.stop(taskId, scope); }

  currentTask(chatId, projectPath) {
    const name = this.activeSessionName(chatId, projectPath);
    return [...this.tasks.values()].find(t => t.source.chatId === chatId && t.projectPath === projectPath && t.sessionName === name && ["running", "stopping"].includes(t.status) && this.steering.isCurrent(t));
  }

  async resumeTask(taskId, source) {
    const task = this.tasks.get(taskId);
    if (!task || task.source.chatId !== source.chatId || (task.source.senderId && task.source.senderId !== source.senderId) || task.status !== "interrupted") {
      throw new Error("这条任务没有处于已停止状态，或不属于当前聊天和用户。");
    }
    if (!this.steering.isCurrent(task)) throw new Error("会话已经重置，旧任务卡片不能继续执行。");
    if (this.currentTask(source.chatId, task.projectPath)) throw new Error("当前会话还有任务正在执行，请等待结束。");
    if (task.resumedAs) throw new Error("这条任务已经继续，请查看新的任务卡片。");
    if (!task.resumeOperation) task.resumeOperation = this.create(source, task.projectPath,
      `请继续刚才被停止的任务，先核对已经完成的进展，再接着完成。\n原任务：${task.prompt}`, task.sessionName, task.imageKey, {
        threadId: task.threadId, model: task.model, reasoningOverride: task.reasoningOverride,
        imageMessageId: task.imageMessageId || task.source.messageId,
      }).then(next => {
        task.resumedAs = next.taskId;
        this.publishTaskText(task, "已开始继续任务，请查看新的任务卡片。").catch(() => {});
        return next;
      });
    return task.resumeOperation;
  }

  pendingCount(chatId = null) {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (chatId && task.source.chatId !== chatId) continue;
      if (["pending", "running", "stopping"].includes(task.status)) count += 1;
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
        ["pending", "running", "stopping"].includes(task.status)
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
          tasks.find((task) => ["running", "pending", "stopping"].includes(task.status)) || tasks[0] || null;
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

  async create(source, projectPath, prompt, sessionName, imageKey = "", resume = null) {
    const normalizedSessionName = normalizeSessionName(sessionName);
    const ahead = this.pendingCountForSession(source.chatId, projectPath, normalizedSessionName);
    const steerTarget = this.steering.active(source.chatId, projectPath, normalizedSessionName);
    const task = {
      taskId: generateTaskId(),
      source,
      projectPath,
      sessionName: normalizedSessionName,
      prompt,
      imageKey,
      imageMessageId: resume?.imageMessageId || source.messageId,
      resumeThreadId: resume?.threadId || null,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      output: "",
      error: null,
      statusMessageId: null,
      threadId: null,
      progress: "",
      lastEventAt: null,
      modelOverride: this.modelOverride(source.chatId, projectPath),
      reasoningOverride: resume?.reasoningOverride ?? this.reasoningOverride(source.chatId, projectPath),
      model: resume?.model || this.effectiveModel(source.chatId, projectPath),
      steerTargetTaskId: steerTarget?.taskId,
      sessionGeneration: this.sessionGenerations.get(sessionKey(source.chatId, projectPath, normalizedSessionName)) || 0,
    };
    task.generation = task.taskId;
    this.tasks.set(task.taskId, task);
    try {
      task.statusMessageId = await this.messenger.replyCard(task.source.messageId, buildTaskCard(task, {
        projectLabel: this.projectAlias(projectPath), pendingCount: ahead,
        paused: this.queue.isPaused(sessionKey(source.chatId, projectPath, task.sessionName)),
      }));
      if (steerTarget && !imageKey) task.steerCardMessageId = task.statusMessageId;
    } catch (error) {
      log("warn", "failed to send task card", { taskId: task.taskId, error: String(error) });
    }
    const key = sessionKey(task.source.chatId, task.projectPath, task.sessionName);
    this.queue.enqueue(key, task, { priority: this.queue.isPaused(key) });
    this.sessionQueues.set(key, this.queue.idle(key));
    return task;
  }

  appServerConfigArgs(task) {
    const overrides = [...config.codex.configOverrides];
    if (config.codex.profile) overrides.push(`profile=${JSON.stringify(config.codex.profile)}`);
    if (config.codex.enableWebSearch) overrides.push('web_search="live"');
    const effort = effectiveReasoningEffort({
      configuredEffort: config.codex.reasoningEffort,
      defaultEffort: config.codex.defaultReasoningEffort,
      scopedEffort: task.reasoningOverride,
    });
    if (effort) overrides.push(`model_reasoning_effort=${JSON.stringify(effort)}`);
    return overrides.flatMap((value) => ["-c", value]);
  }

  saveAppServerSession(task, threadId, { completed = false } = {}) {
    const key = sessionKey(task.source.chatId, task.projectPath, task.sessionName);
    if (!this.steering.isCurrent(task)) return;
    const existing = this.sessions.get(key);
    this.markKnownSession(task.source.chatId, task.projectPath, task.sessionName);
    this.sessions.set(key, {
      name: task.sessionName,
      threadId,
      backend: APP_SERVER_SESSION_BACKEND,
      transport: config.codex.transport,
      model: task.model,
      projectPath: task.projectPath,
      turns: (existing?.threadId === threadId ? existing.turns || 0 : 0) + (completed ? 1 : 0),
      updatedAt: new Date().toISOString(),
    });
    this.persistSessionState();
  }

  async run(task) {
    if (!await this.steering.claimForRun(task)) return;
    if (!this.steering.isCurrent(task)) {
      task.status = "cancelled";
      task.finishedAt = Date.now();
      await this.publishTaskText(task, "会话已重置，这条旧待办已取消。", { rotateOnAnyUpdateError: true }).catch(() => {});
      return;
    }
    task.startedAt = Date.now();
    task.lastEventAt = task.startedAt;
    let imageDownloadPath = "";
    let pushTimer = null;
    let pushInFlight = null;
    let lastPushed = "";

    try {
      await this.publishTaskText(task, "正在准备你的任务。");
    } catch (error) {
      log("warn", "failed to send initial reply", { taskId: task.taskId, error: String(error) });
    }

    const push = async (force = false) => {
      if (pushInFlight) {
        if (force) await pushInFlight;
        else return;
      }
      const now = Date.now();
      const elapsed = task.startedAt ? formatDuration(now - task.startedAt) : "0s";
      const lastEventAgo = task.lastEventAt ? formatDuration(now - task.lastEventAt) : "unknown";
      const body = truncateText(task.output || task.progress || "Codex 正在执行，暂时还没有可展示输出。");
      const text = body;
      const signature = `${task.status}:${elapsed}:${text}`;
      if (!force && signature === lastPushed) return;
      const operation = this.publishTaskText(task, text);
      pushInFlight = operation;
      try {
        await operation;
        lastPushed = signature;
      } catch (error) {
        log("warn", "failed to update status message", { taskId: task.taskId, error: String(error) });
      } finally {
        if (pushInFlight === operation) pushInFlight = null;
      }
    };

    try {
      pushTimer = setInterval(() => {
        push(false).catch((error) => log("warn", "periodic push failed", { error: String(error) }));
      }, config.bridge.streamPushInterval);

      if (task.imageKey) {
        imageDownloadPath = path.join(tmpdir(), `feishu-codex-${task.taskId}-image.download`);
        const downloaded = await this.messenger.downloadMessageResource(
          task.imageMessageId,
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

      if (task.stopRequested || task.status === "cancelled") { task.status = task.stopRequested ? "interrupted" : "cancelled"; return; }
      const existing = this.sessions.get(sessionKey(task.source.chatId, task.projectPath, task.sessionName));
      const threadId = task.resumeThreadId || (canResumeAppServerSession(existing, task.model) ? existing.threadId : null);
      const name = `[飞书] ${path.basename(task.projectPath)} · ${task.sessionName}`;
      log("info", "starting Codex task", {
        taskId: task.taskId, cwd: task.projectPath, command: codexLauncher.command, threadId, transport: config.codex.transport,
      });
      const executeTask = config.codex.transport === "desktop" ? runDesktopTask : runAppServerTask;
      const result = await executeTask({
        command: codexLauncher.command,
        argsPrefix: codexLauncher.argsPrefix,
        shell: codexLauncher.shell,
        configArgs: this.appServerConfigArgs(task),
        cwd: task.projectPath,
        env: { ...process.env, CODEX_HOME: codexHome },
        threadId,
        model: task.model,
        effort: effectiveReasoningEffort({
          configuredEffort: config.codex.reasoningEffort,
          defaultEffort: config.codex.defaultReasoningEffort,
          scopedEffort: task.reasoningOverride,
        }),
        sandbox: config.codex.dangerousBypass ? "danger-full-access"
          : config.codex.fullAuto ? "workspace-write" : config.codex.sandboxMode,
        approvalPolicy: config.codex.dangerousBypass ? "never" : config.codex.approvalPolicy,
        prompt: task.prompt,
        imagePath: task.imagePath,
        name,
        timeoutMs: config.codex.taskTimeout,
        onControl: (control) => {
          if (control) this.activeTasks.set(task.taskId, control);
          else this.activeTasks.delete(task.taskId);
        },
        onTurnStarted: ({ turnId }) => { task.turnId = turnId; },
        onThread: (id) => {
          task.threadId = id;
          task.desktopName = name;
          this.saveAppServerSession(task, id);
        },
        onOutput: (output) => { task.output = output; task.lastEventAt = Date.now(); },
        onProgress: (progress) => { task.progress = progress; task.lastEventAt = Date.now(); },
        onDiagnostic: (text) => {
          task.lastEventAt = Date.now();
          log("debug", "codex app-server diagnostic", { taskId: task.taskId, text: text.trim() });
        },
      });
      task.output = result.output || task.output;
      this.saveAppServerSession(task, result.threadId, { completed: Boolean(result.turn?.id) });

      if (task.status === "cancelled") return;
      task.status = result.turn?.status === "interrupted" ? "interrupted" : "success";
      task.stopError = "";
      if (task.status === "interrupted") this.queue.pause(sessionKey(task.source.chatId, task.projectPath, task.sessionName));
    } catch (error) {
      if (task.status !== "cancelled") {
        task.status = "failed";
        task.error = error instanceof Error ? error.message : String(error);
        if (!task.output) task.output = task.error;
      }
    } finally {
      this.interruption.finish(task);
      if (pushTimer) clearInterval(pushTimer);
      if (pushInFlight) {
        try {
          await pushInFlight;
        } catch {
          // The final delivery below has its own fallback.
        }
      }
      task.finishedAt = Date.now();
      const generatedImages = this.generatedImagesForTask(task);
      let sentImageCount = 0;
      let imageDeliveryError = "";
      for (const filePath of generatedImages) {
        try {
          const sent = await this.messenger.sendImage(task.source.chatId, filePath);
          sentImageCount += 1;
          log("info", "sent generated image to Feishu", {
            taskId: task.taskId,
            filePath,
            imageKey: sent.imageKey,
            messageId: sent.messageId,
          });
        } catch (error) {
          imageDeliveryError = error instanceof Error ? error.message : String(error);
          log("warn", "failed to send generated image", {
            taskId: task.taskId,
            filePath,
            error: imageDeliveryError,
          });
        }
      }
      const seconds = ((task.finishedAt - task.startedAt) / 1000).toFixed(1);
      const imageDeliveryNote =
        sentImageCount > 0
          ? `\n图片: 已发送 ${sentImageCount} 张`
          : imageDeliveryError
            ? `\n图片发送失败: ${imageDeliveryError}`
            : "";
      const finalText = task.status === "success" ? `${truncateText(task.output || "任务已完成。")}${imageDeliveryNote}`
        : task.status === "interrupted" ? `${truncateText(task.output || "当前任务已停止。")}`
        : task.status === "cancelled" ? "这条任务已取消排队。"
        : `执行未完成\n${truncateText([task.output, task.error !== task.output ? task.error : ""].filter(Boolean).join("\n\n") || "请重试。")}`;
      try { await this.publishTaskText(task, finalText, { rotateOnAnyUpdateError: true }); }
      catch (error) { log("warn", "failed to send final message", { taskId: task.taskId, error: String(error) }); }
      if (imageDownloadPath) rmSync(imageDownloadPath, { force: true });
      if (task.imagePath) rmSync(task.imagePath, { force: true });
      log("info", "task finished", { taskId: task.taskId, status: task.status, seconds });
    }
  }

  generatedImagesForTask(task) {
    if (task.status !== "success" || !task.threadId || config.bridge.generatedImageMaxCount <= 0) {
      return [];
    }
    const generatedRoot = path.resolve(codexHome, "generated_images");
    const threadDirectory = path.resolve(generatedRoot, task.threadId);
    if (
      threadDirectory === generatedRoot ||
      !threadDirectory.startsWith(`${generatedRoot}${path.sep}`) ||
      !existsSync(threadDirectory)
    ) {
      return [];
    }
    const entries = [];
    for (const item of readdirSync(threadDirectory, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const filePath = path.join(threadDirectory, item.name);
      const stats = statSync(filePath);
      entries.push({
        filePath,
        isFile: true,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
    return selectGeneratedImagesForTask(entries, {
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      maxCount: config.bridge.generatedImageMaxCount,
    });
  }

  killActive(taskId = null) {
    if (!taskId) {
      for (const activeTaskId of [...this.activeTasks.keys()]) this.killActive(activeTaskId);
      return;
    }
    const child = this.activeTasks.get(taskId);
    if (!child) return;
    if (child.interrupt && !child.cancel && !child.kill) { this.activeTasks.delete(taskId); return; }
    if (child.canCancel === false) {
      this.activeTasks.delete(taskId);
      return;
    }
    log("info", "killing active codex process", { taskId });
    try {
      if (child.cancel) {
        child.cancel();
        this.activeTasks.delete(taskId);
        return;
      }
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

async function showControlCard(chatId, replyToMessageId, notice = "", view = "home", page = 0, scope = {}) {
  const projectPath = scope.projectPath || runner.activeProjectPath(chatId);
  const card = buildControlCard(runner, chatId, projectPath, notice, view, page, scope.sessionName);
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
    eventId: message.eventId,
    messageId: message.messageId,
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
  if (command.type === "panel") {
    const cardMessageId = await showControlCard(message.chatId, message.messageId, "控制卡片已打开");
    refreshProjectChoices("panel")
      .then(async () => {
        if (!cardMessageId || runner.controlCardMessageId(message.chatId) !== cardMessageId) return;
        await messenger.updateCard(
          cardMessageId,
          buildControlCard(
            runner,
            message.chatId,
            runner.activeProjectPath(message.chatId),
            "项目列表已刷新"
          )
        );
      })
      .catch((error) => log("warn", "background panel project refresh failed", { error: String(error) }));
    return;
  }
  if (command.type === "project") {
    await refreshProjectChoices("project");
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
  if (["stop", "cancel"].includes(command.type)) {
    let notice;
    try {
      const taskId = command.taskId || runner.currentTask(message.chatId, activeProjectPath)?.taskId;
      notice = taskId ? runner.stopTask(taskId, { chatId: message.chatId, senderId: message.senderId }).notice : "当前会话没有正在执行的任务。";
    } catch (error) { notice = error.message; }
    await messenger.replyText(message.messageId, notice);
    return;
  }
  if (command.type === "queue") {
    await showControlCard(message.chatId, message.messageId, "", "queue");
    return;
  }
  if (command.type === "resume") {
    try {
      const name = runner.activeSessionName(message.chatId, activeProjectPath);
      const target = command.taskId || [...runner.tasks.values()].reverse().find(t => t.source.chatId === message.chatId && t.projectPath === activeProjectPath && t.sessionName === name && t.status === "interrupted" && !t.resumedAs)?.taskId;
      if (!target && message.text.trim() === "继续") {
        await runner.create(message, activeProjectPath, "继续", name);
        return;
      }
      if (!target) throw new Error("当前会话没有已停止的任务，直接发送新要求即可开始。");
      await runner.resumeTask(target, message);
    } catch (error) { await messenger.replyText(message.messageId, error.message); }
    return;
  }
  if (command.type === "steer") {
    let notice;
    try {
      const result = command.taskId
        ? await runner.steering.promote(command.taskId, { chatId: message.chatId, senderId: message.senderId })
        : await runner.steering.submit(runner.steering.active(message.chatId, activeProjectPath,
          runner.activeSessionName(message.chatId, activeProjectPath)), command.prompt);
      notice = "已提交引导，当前任务会按补充要求继续。";
      if (command.taskId) {
        try { await runner.publishTaskText(runner.tasks.get(command.taskId), notice); }
        catch (error) { log("warn", "failed to update steering receipt", { error: String(error) }); }
      }
    } catch (error) {
      notice = error.steerOutcomeUnknown
        ? (command.taskId ? "引导回执未确认，请到 Codex 客户端核对；为避免重复执行，这条排队消息已暂停。"
          : "引导回执未确认，请到 Codex 客户端核对；未自动重发，请核对后再决定是否补发。")
        : `引导未提交：${error.message}`;
    }
    await messenger.replyText(message.messageId, notice);
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
  // Queue cards have their own identity and remain usable after /panel refresh.
  if (value.action === "steer_task") {
    if (!event.messageId || (event.chatId && event.chatId !== actionChatId)) return;
    const task = runner.tasks.get(value.taskId);
    let notice;
    try {
      const result = await runner.steering.promote(value.taskId, {
        chatId: actionChatId, senderId: event.operator.openId, messageId: event.messageId,
      });
      notice = "已提交引导，当前任务会按补充要求继续。";
      try { await runner.publishTaskText(task, notice); }
      catch (error) { log("warn", "failed to update steering receipt", { error: String(error) }); }
    } catch (error) {
      notice = error.steerOutcomeUnknown
        ? "引导回执未确认，请到 Codex 客户端核对；为避免重复执行，这条排队消息已暂停。"
        : `引导未提交：${error.message}`;
    }
    if (task?.steerCardMessageId === event.messageId && task.source.chatId === actionChatId && task.source.senderId === event.operator.openId) {
      await runner.publishTaskText(task, notice);
    }
    return;
  }
  if (["stop_task", "cancel_task", "resume_task"].includes(value.action)) {
    const task = runner.tasks.get(value.taskId);
    const ownTaskCard = task?.statusMessageId === event.messageId;
    const currentPanel = runner.controlCardMessageId(actionChatId) === event.messageId;
    if (!task || (!ownTaskCard && !currentPanel) || (event.chatId && event.chatId !== actionChatId)) return;
    let notice;
    try {
      if (value.action === "resume_task") {
        if (value.generation !== task.generation) throw new Error("任务卡片已失效。");
        await runner.resumeTask(task.taskId, { chatId: actionChatId, senderId: event.operator.openId, messageId: event.messageId });
        notice = "已开始继续任务。";
      } else notice = runner.stopTask(task.taskId, { chatId: actionChatId, senderId: event.operator.openId,
        generation: value.generation, messageId: ownTaskCard ? event.messageId : undefined }).notice;
    } catch (error) { notice = error.message; }
    if (currentPanel) await messenger.updateCard(event.messageId, buildControlCard(runner, actionChatId, cardProjectPath, notice,
      value.view === "queue" ? "queue" : "home", value.page, value.sessionName));
    else if (notice && task.source.chatId === actionChatId && task.source.senderId === event.operator.openId) await runner.publishTaskText(task, notice);
    return;
  }
  if (value.action === "show_queue" && value.taskId) {
    const task = runner.tasks.get(value.taskId);
    if (!task || task.statusMessageId !== event.messageId || task.source.chatId !== actionChatId || task.source.senderId !== event.operator.openId) return;
    await showControlCard(actionChatId, event.messageId, "", "queue", 0, { projectPath: task.projectPath, sessionName: task.sessionName });
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
  const projectPath = value.view === "queue" ? cardProjectPath : cardProjectPathForAction({
    activeProjectPath: runner.activeProjectPath(actionChatId),
    cardProjectPath,
    defaultProjectPath: config.bridge.defaultProjectPath,
  });
  const controlSession = value.sessionName || runner.activeSessionName(actionChatId, projectPath);
  let view = ["home", "projects", "sessions", "settings", "models", "reasoning", "queue"].includes(value.view) ? value.view : "home";
  let notice = "";
  if (["show_home", "show_projects", "show_sessions", "show_settings", "show_models", "show_reasoning", "show_queue"].includes(value.action)) {
    view = value.action.slice(5);
  } else if (value.action === "resume_queue") {
    runner.queue.resume(sessionKey(actionChatId, projectPath, controlSession));
    view = "queue";
    notice = "待办将按顺序执行。";
  } else if (value.action === "refresh") {
    notice = "已刷新";
  } else if (value.action === "reset_settings") {
    runner.clearModelOverride(actionChatId, projectPath);
    runner.clearReasoningOverride(actionChatId, projectPath);
    view = "settings";
    notice = "已恢复默认配置。";
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
      view = "settings";
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
      view = "settings";
      notice = `已切换推理强度为 ${validation.effort}`;
    } else {
      notice = `推理强度无效: ${validation.reason}`;
    }
  } else if (value.action === "clear_reasoning") {
    const existed = runner.clearReasoningOverride(actionChatId, projectPath);
    notice = existed ? "已清除推理强度覆盖" : "当前没有推理强度覆盖";
  } else if (value.action === "use_session") {
    const sessionName = runner.setActiveSession(actionChatId, projectPath, value.sessionName);
    notice = `已切换到 ${sessionName === "default" ? "默认会话" : sessionName}`;
    view = "home";
  } else if (value.action === "new_session") {
    const existingNames = new Set(runner.sessionStates(actionChatId, projectPath).map(item => item.name));
    let number = 1;
    while (existingNames.has(`会话${number}`)) number++;
    const sessionName = runner.setActiveSession(
      actionChatId,
      projectPath,
      `会话${number}`
    );
    notice = "新会话已准备好，直接发送消息即可。";
    view = "home";
  } else if (value.action === "reset_active_session") {
    const activeName = runner.activeSessionName(actionChatId, projectPath);
    const result = runner.resetSession(actionChatId, projectPath, activeName);
    notice = result.existed ? "已重置会话，下一条消息会开启新上下文。" : "会话已准备好，直接发送消息即可。";
  } else {
    notice = `未知动作: ${value.action}`;
  }

  await messenger.updateCard(event.messageId, buildControlCard(runner, actionChatId, projectPath, notice, view, value.page,
    view === "queue" ? controlSession : null));
}

const dispatcher = new EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    log("info", "raw Feishu message event received", {
      keys: data && typeof data === "object" ? Object.keys(data) : [],
      eventKeys: data?.event && typeof data.event === "object" ? Object.keys(data.event) : [],
    });
    const parsed = parseMessageEvent(data);
    if (!parsed) return;
    if (!runner.claimMessage(parsed.messageId)) {
      log("warn", "ignored duplicate message event", {
        eventId: parsed.eventId,
        messageId: parsed.messageId,
        chatId: parsed.chatId,
        text: parsed.text.slice(0, 120),
      });
      return;
    }
    try {
      await handleMessage(parsed);
    } catch (error) {
      log("error", "message handler failed", { error: String(error) });
      runner.releaseMessage(parsed.messageId);
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
  codexCommand: codexLauncher.command,
  sessionBackend: APP_SERVER_SESSION_BACKEND,
  taskTransport: config.codex.transport,
  cardLayout: "compact-v1",
  taskControl: "interrupt-v1",
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
