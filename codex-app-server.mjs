import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const APP_SERVER_SESSION_BACKEND = "app-server-v1";

// Match Desktop's history format when its bundled engine is installed. An
// explicitly configured path still takes precedence over this default.
export function desktopCodexBinary(bin = "codex", { platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  if (platform !== "win32" || !["codex", "codex.cmd", "codex.ps1"].includes(bin.toLowerCase())) return bin;
  const bundled = path.join(home, "AppData", "Local", "OpenAI", "Codex", "bin", "current", "codex.exe");
  return exists(bundled) ? bundled : bin;
}

export function canResumeAppServerSession(session, model) {
  return session?.backend === APP_SERVER_SESSION_BACKEND && Boolean(session.threadId) &&
    (session.model || "") === (model || "");
}

function projectPathKey(value) {
  if (!value || typeof value !== "string") return "";
  let clean = value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(clean);
  clean = (windows ? path.win32 : path.posix).normalize(clean).replace(/[\\/]+$/, "");
  return windows ? clean.toLowerCase() : clean;
}

export function matchingProjectId(projects, cwd) {
  const target = projectPathKey(cwd);
  let best = null;
  let longest = -1;
  for (const project of projects) {
    for (const root of project.roots || []) {
      const key = projectPathKey(root.path);
      if (!key || !project.id) continue;
      if ((target === key || target.startsWith(`${key}\\`) || target.startsWith(`${key}/`)) && key.length > longest) {
        best = project.id;
        longest = key.length;
      }
    }
  }
  return best;
}

export async function resolveAppServerProjectId(rpc, cwd) {
  const projects = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const result = await rpc.request("project/list", { cursor, limit: 100 });
    projects.push(...(result.data || []));
    cursor = result.nextCursor;
    if (!cursor) return matchingProjectId(projects, cwd);
    if (seen.has(cursor)) throw new Error("Codex project/list returned a repeated cursor");
    seen.add(cursor);
  }
  throw new Error("Codex project/list returned too many pages");
}

export class CodexAppServer extends EventEmitter {
  constructor({ command, argsPrefix = [], configArgs = [], cwd, env = process.env, shell = false, spawnImpl = spawn, requestTimeoutMs = 60_000 }) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = spawnImpl(command, [...argsPrefix, ...configArgs, "app-server", "--listen", "stdio://"], {
      cwd, env, shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) this.receive(line);
    });
    this.child.stderr.on("data", (chunk) => this.emit("diagnostic", String(chunk)));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      buffer += decoder.end();
      if (buffer.trim()) this.receive(buffer);
      this.fail(new Error(`Codex App Server exited (${signal || code})`));
    });
  }

  receive(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      // This bridge has no interactive approval UI. Never approve an unknown
      // server request automatically or leave it hanging indefinitely.
      this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: `Feishu bridge cannot handle interactive request: ${message.method}` } }) + "\n");
      this.emit("interactiveRequest", message.method);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || "request failed"}`));
      else pending.resolve(message.result);
    } else if (message.method) {
      this.emit("notification", message.method, message.params || {});
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("Codex App Server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "feishu-codex-bridge", title: "Feishu Codex Bridge", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  }

  close() {
    this.fail(new Error("Codex App Server connection closed"));
    if (!this.child.killed) this.child.kill();
  }
}

export async function runAppServerTask({
  command, argsPrefix, configArgs, cwd, env, shell, spawnImpl,
  threadId: resumeId = null, model = "", effort = "", sandbox = "workspace-write", approvalPolicy = "never",
  prompt, imagePath = "", name, timeoutMs = 1_200_000,
  onControl = () => {}, onThread = () => {}, onOutput = () => {}, onProgress = () => {}, onDiagnostic = () => {},
}) {
  const rpc = new CodexAppServer({ command, argsPrefix, configArgs, cwd, env, shell, spawnImpl });
  let threadId = resumeId;
  let turnId;
  let settled = false;
  let stopping = false;
  let resolveDone;
  let rejectDone;
  const messages = new Map();
  const completedTurns = new Map();
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // A process can fail while initialize/thread/start is still pending.
  done.catch(() => {});
  const finish = (error, turn) => {
    if (settled) return;
    settled = true;
    if (error) rejectDone(error);
    else resolveDone({ threadId, turn, output: [...messages.values()].join("\n\n") });
  };
  const stop = (reason) => {
    if (settled || stopping) return;
    stopping = true;
    // Give the engine a chance to stop its tools before terminating transport.
    const fallback = setTimeout(() => { finish(reason); rpc.close(); }, 1500);
    if (threadId && turnId) {
      rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {}).finally(() => {
        clearTimeout(fallback);
        finish(reason);
        rpc.close();
      });
    } else {
      clearTimeout(fallback);
      finish(reason);
      rpc.close();
    }
  };
  const control = { cancel: () => stop(new Error("Codex task cancelled")) };
  rpc.on("diagnostic", onDiagnostic);
  rpc.on("disconnect", (error) => finish(error));
  rpc.on("interactiveRequest", (method) => stop(new Error(`飞书暂不支持交互请求 ${method}，请在 Codex 客户端处理后重试。`)));
  const complete = (turn) => {
    if (turn.status === "completed") finish(null, turn);
    else finish(new Error(turn.error?.message || `Codex turn ${turn.status || "failed"}`));
  };
  rpc.on("notification", (method, params) => {
    if (params.threadId !== threadId || settled) return;
    if (method === "turn/started") {
      turnId ||= params.turn?.id;
      onProgress("Codex 已开始处理任务。");
    }
    if (turnId && params.turnId && params.turnId !== turnId) return;
    if (method === "item/agentMessage/delta") {
      messages.set(params.itemId, (messages.get(params.itemId) || "") + params.delta);
      onOutput([...messages.values()].join("\n\n"));
    } else if (method === "item/completed" && params.item?.type === "agentMessage") {
      messages.set(params.item.id, params.item.text || "");
      onOutput([...messages.values()].join("\n\n"));
    } else if (method === "item/started") {
      onProgress(`Codex 正在处理: ${params.item?.type || "任务"}`);
    } else if (method === "turn/completed") {
      completedTurns.set(params.turn.id, params.turn);
      if (params.turn.id === turnId) complete(params.turn);
    } else if (method === "error" && !params.willRetry) {
      finish(new Error(params.error?.message || "Codex execution failed"));
    }
  });
  onControl(control);
  const timeout = setTimeout(() => stop(new Error(`Codex task timeout after ${timeoutMs / 1000}s`)), timeoutMs);
  try {
    await rpc.initialize();
    const params = { cwd, approvalPolicy, sandbox, ...(model ? { model } : {}) };
    let result;
    if (threadId) {
      result = await rpc.request("thread/resume", { ...params, threadId, excludeTurns: true });
      if (result.thread?.status?.type === "active") {
        throw new Error("这条会话正在 Codex 客户端执行任务，请等待完成后再从飞书发送消息。");
      }
      // Repair sessions created before explicit Desktop project membership was
      // supported. Preserve any project the user has already chosen in Desktop.
      if (!result.thread.projectId) {
        const projectId = await resolveAppServerProjectId(rpc, cwd);
        if (projectId) await rpc.request("thread/metadata/update", { threadId, projectId });
      }
    } else {
      const projectId = await resolveAppServerProjectId(rpc, cwd);
      result = await rpc.request("thread/start", {
        ...params, ephemeral: false, threadSource: "user", ...(projectId ? { projectId } : {}),
      });
    }
    threadId = result.thread.id;
    await onThread(threadId);
    onProgress(`Codex 会话已就绪: ${threadId}`);
    if (!resumeId && name) await rpc.request("thread/name/set", { threadId, name });
    const input = [{ type: "text", text: prompt, text_elements: [] }];
    if (imagePath) input.push({ type: "localImage", path: imagePath });
    const started = await rpc.request("turn/start", { threadId, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    turnId = started.turn.id;
    if (completedTurns.has(turnId)) complete(completedTurns.get(turnId));
    return await done;
  } catch (error) {
    if (settled) return await done;
    throw error;
  } finally {
    clearTimeout(timeout);
    // Remove disconnect listener before intentional shutdown after a request error.
    settled = true;
    rpc.close();
    onControl(null);
  }
}
