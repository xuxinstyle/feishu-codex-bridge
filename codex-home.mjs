import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Inspect files, not just directories or the state DB: both can outlive a rollout.
function inspectHome(home, threadId) {
  const checked = [];
  const errors = [];
  function find(directory, depth) {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== "ENOENT") errors.push(`${directory}: ${error.code || error.message}`);
      return null;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) {
        const found = find(file, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name.startsWith("rollout-") &&
          (threadId ? entry.name.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/)?.[1] === threadId
            : entry.name.endsWith(".jsonl"))) {
        try {
          if (statSync(file).size === 0) { errors.push(`${file}: 文件为空`); continue; }
          accessSync(file, constants.R_OK);
          return file;
        } catch (error) { errors.push(`${file}: ${error.code || error.message}`); }
      }
    }
    return null;
  }
  for (const directory of ["sessions", "archived_sessions"]) {
    const root = path.join(home, directory);
    checked.push(root);
    const file = find(root, 0);
    if (file) return { home, file, checked, errors };
  }
  return { home, file: null, checked, errors };
}

function diagnostic(probes, { configuredHome, defaultHome, threadId }) {
  return [
    `Codex 会话文件检查失败${threadId ? `（会话 ID: ${threadId}）` : ""}。`,
    `CODEX_HOME: ${configuredHome || "未设置"}`,
    `默认目录: ${defaultHome}`,
    `查找目标: ${threadId ? `rollout-*-${threadId}.jsonl` : "非空、可读的 rollout-*.jsonl"}`,
    ...probes.flatMap(probe => [
      ...probe.checked.map(directory => `已检查: ${directory}`),
      ...probe.errors.map(error => `读取异常: ${error}`),
    ]),
    "上述位置均未找到对应的非空、可读会话文件。目录或历史索引存在并不代表会话文件存在。",
    "请核对启动用户、CODEX_HOME 和 Codex 桌面客户端的数据目录；路径中用户名与 .codex 之间应有目录分隔符。",
    threadId ? "若历史已删除，请恢复原始文件，或在飞书使用 /new 新建会话；不会自动替换原会话或重复提交任务。"
      : "若为首次使用，请在 Codex 桌面客户端完成一次聊天；bridge 仍可启动并创建新会话。",
  ].join("\n");
}

export function resolveCodexHome({ configuredHome = "", defaultHome = path.join(homedir(), ".codex"),
  threadId, allowEmpty = false } = {}) {
  defaultHome = path.resolve(defaultHome);
  configuredHome = configuredHome ? path.resolve(configuredHome) : "";
  const homes = [...new Set([configuredHome, defaultHome].filter(Boolean))];
  const probes = [];
  for (const home of homes) {
    const probe = inspectHome(home, threadId);
    probes.push(probe);
    if (probe.file) return {
      home, file: probe.file, probes,
      warning: probes.length > 1 ? [
        `CODEX_HOME 中未找到${threadId ? `会话 ${threadId} 的` : "可用的"}会话文件，已回退默认目录。`,
        `原目录: ${configuredHome}`, `实际目录: ${home}`, `会话文件: ${probe.file}`,
        ...probes[0].errors.map(error => `读取异常: ${error}`),
        "请确保 Codex 桌面客户端也使用实际目录。",
      ].join("\n") : "",
    };
  }
  const message = diagnostic(probes, { configuredHome, defaultHome, threadId });
  // A new installation has no history yet. Report it, but let /new recover.
  if (allowEmpty && !threadId) return { home: defaultHome, file: null, probes, error: message };
  throw Object.assign(new Error(message), { code: "CODEX_SESSION_FILE_MISSING" });
}

export function resolveSessionEnv(env, homeOptions, threadId, onDiagnostic = () => {}) {
  if (!homeOptions || !threadId) return env;
  const result = resolveCodexHome({ ...homeOptions, threadId });
  if (result.warning) onDiagnostic(result.warning);
  return { ...env, CODEX_HOME: result.home };
}
