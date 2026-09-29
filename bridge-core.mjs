import path from "node:path";

export function parseCommand(text) {
  const trimmed = text.trim();
  if (trimmed === "/help" || trimmed === "帮助") return { type: "help" };
  if (trimmed === "/panel" || trimmed === "/card" || trimmed === "面板" || trimmed === "控制台") {
    return { type: "panel" };
  }
  if (trimmed === "/sessions" || trimmed === "/session" || trimmed === "会话列表") {
    return { type: "sessions" };
  }

  const modelMatch = trimmed.match(/^\/(?:model|模型)(?:\s+(.+))?$/i);
  if (modelMatch) {
    const value = (modelMatch[1] || "").trim();
    if (!value) return { type: "model", action: "show" };
    if (/^(default|reset|clear|默认|重置|清除)$/i.test(value)) {
      return { type: "model", action: "clear" };
    }
    const parts = value.split(/\s+/).filter(Boolean);
    const maybeEffort = parts.length > 1 ? parts.at(-1) : "";
    if (maybeEffort && validateReasoningEffort(maybeEffort).ok) {
      return {
        type: "model",
        action: "set",
        model: parts.slice(0, -1).join(" "),
        reasoningEffort: normalizeReasoningEffort(maybeEffort),
      };
    }
    return { type: "model", action: "set", model: value, reasoningEffort: "" };
  }

  const reasoningMatch = trimmed.match(/^\/(?:reasoning|effort|推理)(?:\s+(.+))?$/i);
  if (reasoningMatch) {
    const value = (reasoningMatch[1] || "").trim();
    if (!value) return { type: "reasoning", action: "show" };
    if (/^(default|reset|clear|默认|重置|清除)$/i.test(value)) {
      return { type: "reasoning", action: "clear" };
    }
    return { type: "reasoning", action: "set", reasoningEffort: normalizeReasoningEffort(value) };
  }

  const projectMatch = trimmed.match(/^\/(?:project|repo|项目)(?:\s+(.+))?$/i);
  if (projectMatch) {
    const value = (projectMatch[1] || "").trim();
    if (!value) return { type: "project", action: "show" };
    if (/^(default|reset|clear|默认|重置|清除)$/i.test(value)) {
      return { type: "project", action: "clear" };
    }
    return { type: "project", action: "set", project: value };
  }

  const useMatch = trimmed.match(/^\/use\s+(\S+)$/);
  if (useMatch) return { type: "use", sessionName: useMatch[1] };

  const newMatch = trimmed.match(/^\/new(?:\s+(\S+))?$/);
  if (newMatch || trimmed === "新会话" || trimmed === "重置") {
    return { type: "new", sessionName: newMatch?.[1] };
  }

  const statusMatch = trimmed.match(/^\/status\s*(task-\S+)?$/);
  if (statusMatch) return { type: "status", taskId: statusMatch[1] };

  const cancelMatch = trimmed.match(/^\/cancel\s+(task-\S+)$/);
  if (cancelMatch) return { type: "cancel", taskId: cancelMatch[1] };

  const runWithPath = trimmed.match(/^\/run\s+((?:~|\.{1,2}|[A-Za-z]:)?[\\/][^\s]+)\s+(.+)$/s);
  if (runWithPath) {
    return { type: "run", projectPath: runWithPath[1], prompt: runWithPath[2].trim() };
  }

  const runNoPath = trimmed.match(/^\/run\s+(.+)$/s);
  if (runNoPath) return { type: "run", prompt: runNoPath[1].trim() };

  if (trimmed) return { type: "run", prompt: trimmed };
  return { type: "unknown" };
}

export function validateModelName(value) {
  const model = (value || "").trim();
  if (!model) return { ok: false, reason: "模型名不能为空。" };
  if (model.length > 96) return { ok: false, reason: "模型名过长，最多 96 个字符。" };
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) {
    return {
      ok: false,
      reason: "模型名只能包含英文字母、数字、点、下划线、横线、冒号和斜杠。",
    };
  }
  return { ok: true, model };
}

const DEFAULT_GROK_MODELS = ["grok-4.6", "grok-4.5"];

function uniqueModelList(items) {
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const validation = validateModelName(item);
    if (!validation.ok || seen.has(validation.model)) continue;
    seen.add(validation.model);
    models.push(validation.model);
  }
  return models;
}

export function buildModelChoiceGroups({
  configuredChoices = [],
  configuredModel = "",
  defaultModel = "",
} = {}) {
  const all = uniqueModelList([
    ...DEFAULT_GROK_MODELS,
    ...configuredChoices,
    configuredModel,
    defaultModel,
  ]);
  return {
    grok: all.filter((model) => /^grok(?:-|$)/i.test(model)),
    codex: all.filter((model) => !/^grok(?:-|$)/i.test(model)),
  };
}

export function buildModelArgs({
  configuredModel = "",
  defaultModel = "",
  scopedModel = "",
} = {}) {
  const model = effectiveCodexModel({ configuredModel, defaultModel, scopedModel });
  return model ? ["-m", model] : [];
}

export function buildImageArgs(imagePath = "") {
  const normalizedPath = String(imagePath || "").trim();
  return normalizedPath ? ["-i", normalizedPath] : [];
}

export function parseFeishuImageContent(content) {
  try {
    const parsed = JSON.parse(String(content || "{}"));
    const imageKey = typeof parsed?.image_key === "string" ? parsed.image_key.trim() : "";
    return { imageKey };
  } catch {
    return { imageKey: "" };
  }
}

export function canResumeCodexSession({ session = null, model = "" } = {}) {
  const threadId = typeof session?.threadId === "string" ? session.threadId.trim() : "";
  const storedModel = typeof session?.model === "string" ? session.model.trim() : "";
  const requestedModel = String(model || "").trim();
  return Boolean(threadId && storedModel && requestedModel && storedModel === requestedModel);
}

const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export function normalizeReasoningEffort(value) {
  return (value || "").trim().toLowerCase();
}

export function validateReasoningEffort(value) {
  const effort = normalizeReasoningEffort(value);
  if (!effort) return { ok: false, reason: "推理强度不能为空。" };
  if (!VALID_REASONING_EFFORTS.has(effort)) {
    return {
      ok: false,
      reason: "推理强度只能是 low、medium、high、xhigh、max 或 ultra。",
    };
  }
  return { ok: true, effort };
}

function parseTomlString(value) {
  const trimmed = String(value || "").trim();
  const quoted = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
  if (quoted) {
    try {
      return JSON.parse(`"${quoted[1]}"`).trim();
    } catch {
      return quoted[1].trim();
    }
  }
  const literal = trimmed.match(/^'([^']*)'/);
  if (literal) return literal[1].trim();
  return trimmed.replace(/\s+#.*$/, "").trim();
}

export function parseCodexConfigDefaults(content) {
  const defaults = { model: "", reasoningEffort: "" };
  let inTable = false;
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[\[?.+\]\]?$/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable) continue;
    const match = line.match(/^(model|model_reasoning_effort)\s*=\s*(.+)$/);
    if (!match) continue;
    const value = parseTomlString(match[2]);
    if (match[1] === "model") defaults.model = value;
    if (match[1] === "model_reasoning_effort") {
      defaults.reasoningEffort = normalizeReasoningEffort(value);
    }
  }
  return defaults;
}

export function effectiveCodexModel({ configuredModel = "", defaultModel = "", scopedModel = "" } = {}) {
  return (scopedModel || configuredModel || defaultModel || "").trim();
}

export function effectiveReasoningEffort({
  configuredEffort = "",
  defaultEffort = "",
  scopedEffort = "",
} = {}) {
  return normalizeReasoningEffort(scopedEffort || configuredEffort || defaultEffort);
}

export function codexConfigOverrideForReasoning(value) {
  const validation = validateReasoningEffort(value);
  if (!validation.ok) return "";
  return `model_reasoning_effort="${validation.effort}"`;
}

export function parseProjectChoices(value) {
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const idx = item.indexOf("=");
      if (idx > 0) {
        const alias = item.slice(0, idx).trim();
        const projectPath = item.slice(idx + 1).trim();
        return { alias, path: projectPath };
      }
      const normalized = item.replace(/[\\/]+$/, "");
      const alias = normalized.split(/[\\/]/).pop() || normalized;
      return { alias, path: item };
    })
    .filter((item) => item.alias && item.path);
}

export function extractThreadCwds(payload) {
  const threads = payload?.result?.data || payload?.data;
  if (!Array.isArray(threads)) return [];
  return threads
    .map((thread) => thread?.cwd)
    .filter((cwd) => typeof cwd === "string" && cwd.trim())
    .map((cwd) => cwd.trim());
}

export function mergeProjectChoices(baseChoices = [], discoveredPaths = []) {
  const choices = [];
  const seenPaths = new Set();
  const usedAliases = new Set();

  const addChoice = (alias, projectPath) => {
    if (typeof projectPath !== "string" || !projectPath.trim()) return;
    const normalizedPath = path.normalize(projectPath.trim());
    const pathKey = normalizedPath.toLowerCase();
    if (seenPaths.has(pathKey)) return;

    let normalizedAlias = String(alias || path.basename(normalizedPath) || normalizedPath).trim();
    if (!normalizedAlias) normalizedAlias = normalizedPath;
    const aliasBase = normalizedAlias;
    let suffix = 2;
    while (usedAliases.has(normalizedAlias.toLowerCase())) {
      normalizedAlias = `${aliasBase}-${suffix}`;
      suffix += 1;
    }

    seenPaths.add(pathKey);
    usedAliases.add(normalizedAlias.toLowerCase());
    choices.push({ alias: normalizedAlias, path: normalizedPath });
  };

  for (const choice of Array.isArray(baseChoices) ? baseChoices : []) {
    addChoice(choice?.alias, choice?.path);
  }
  for (const projectPath of Array.isArray(discoveredPaths) ? discoveredPaths : []) {
    addChoice(path.basename(path.normalize(projectPath)), projectPath);
  }

  return choices;
}

export function shouldRefreshProjectChoicesForCardAction(action) {
  return action === "refresh" || action === "show_sessions";
}

export function createKeyedSerialExecutor() {
  const tails = new Map();
  return function execute(key, task) {
    const queueKey = String(key || "");
    const previous = tails.get(queueKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    tails.set(queueKey, current);
    return current.finally(() => {
      if (tails.get(queueKey) === current) tails.delete(queueKey);
    });
  };
}

export function assertFeishuApiSuccess(response, operation = "飞书 API") {
  const code = response?.code;
  if (response && (code === undefined || code === 0)) return response;
  const message = response?.msg || "unknown error";
  throw new Error(`${operation}失败: code=${code ?? "unknown"} msg=${message}`);
}

export function isStaleControlCardAction({ currentMessageId = "", actionMessageId = "" } = {}) {
  return Boolean(currentMessageId && actionMessageId && currentMessageId !== actionMessageId);
}

export function cardProjectPathForAction({
  activeProjectPath,
  cardProjectPath,
  defaultProjectPath,
}) {
  return activeProjectPath || cardProjectPath || defaultProjectPath;
}
