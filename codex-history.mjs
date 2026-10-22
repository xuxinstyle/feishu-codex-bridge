import path from "node:path";
import { CodexAppServer, desktopCodexBinary } from "./codex-app-server.mjs";

export function historyProjectPath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("projectPath must be an absolute path");
  const clean = value.trim().replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(clean);
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(clean)) throw new Error("projectPath must be an absolute path");
  let normalized = api.normalize(clean);
  while (normalized.length > api.parse(normalized).root.length && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return { path: normalized, key: windows ? normalized.toLowerCase() : normalized };
}

function rawTitle(thread) {
  const text = [thread.name, thread.preview].find(value => typeof value === "string" && value.trim());
  return text?.trim() || "未命名会话";
}

function title(thread) {
  return rawTitle(thread).split(/\r?\n/)[0].slice(0, 120);
}

function subagent(source) {
  if (typeof source === "string") return /^subagent/i.test(source);
  return source && typeof source === "object" &&
    (Object.keys(source).some(key => /^subagent/i.test(key)) || typeof source.type === "string" && /^subagent/i.test(source.type));
}

function visible(thread, project) {
  if (!thread || typeof thread.id !== "string" || !thread.id.trim() || rawTitle(thread).includes("[飞书]") ||
      thread.parentThreadId || subagent(thread.source) || subagent(thread.threadSource)) return false;
  try {
    const cwd = historyProjectPath(thread.cwd);
    return !project || cwd.key === project.key;
  } catch { return false; }
}

function status(thread) {
  return typeof thread.status === "string" ? thread.status : thread.status?.type || "unknown";
}

async function verifiedThread(request, project, threadId) {
  if (typeof threadId !== "string" || !threadId.trim()) throw new Error("threadId is required");
  const metadata = await request("thread/read", { threadId, includeTurns: false });
  const thread = metadata?.thread;
  if (thread?.id !== threadId || !visible(thread, project)) throw new Error("Thread is unavailable in this project history");
  return thread;
}

function cursorValue(cursor) {
  if (cursor == null) return null;
  if (typeof cursor !== "string" || !cursor.trim()) throw new Error("cursor must be a non-empty opaque string");
  return cursor;
}

function pageResult(result, cursor) {
  if (!Array.isArray(result?.data)) throw new Error("Invalid Codex history page");
  const nextCursor = cursorValue(result.nextCursor);
  if (nextCursor !== null && nextCursor === cursor) throw new Error("Codex history returned a repeated cursor");
  return { data: result.data, nextCursor };
}

function messagesFromTurns(turns) {
  const messages = [];
  // The server pages newest-first; display each page in conversation order.
  for (const turn of [...turns].reverse()) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === "userMessage") {
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter(part => part?.type === "text" && typeof part.text === "string")
          .map(part => part.text).join("\n");
        if (text.trim()) messages.push({ role: "user", text });
      } else if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        messages.push({ role: "assistant", text: item.text });
      }
    }
  }
  return messages;
}

/**
 * Read local persisted Codex history, without binding or resuming a session.
 * Callers must authorize the viewer and project before calling any method.
 * Text is not a secret-redaction boundary; tools, reasoning and attachments are
 * omitted, but user/assistant text and titles can still contain sensitive data.
 * list({ allProjects: true }) omits projectPath filtering; returned cwd values
 * must be bound to the selected thread by the caller. inspect and read always
 * require that explicit projectPath and recheck freshly read metadata.
 * inspect returns metadata only. Its standalone-server status (e.g. notLoaded)
 * does not establish that the thread is idle in Desktop.
 * List skips at most five filtered pages per operation. nextCursor is opaque;
 * an empty result at that bound can still have a next page.
 */
export function createHistoryReader({
  command = "codex", argsPrefix = [], shell = false, cwd = process.cwd(), env = process.env,
  timeoutMs = 15_000, rpcFactory = options => new CodexAppServer(options),
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  const rpcOptions = { command: desktopCodexBinary(command), argsPrefix, shell, cwd, env, requestTimeoutMs: timeoutMs };
  let tail = Promise.resolve();
  let queued = 0;

  function operation(callback) {
    if (queued >= 8) return Promise.reject(new Error("Codex history is busy; retry shortly"));
    const deadlineAt = Date.now() + timeoutMs;
    queued++;
    const run = tail.then(async () => {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error("Codex history operation timed out while queued");
      const rpc = rpcFactory(rpcOptions);
      let timer;
      let expired = false;
      // One deadline covers initialization and every request in this operation.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error("Codex history operation timed out")); }, remainingMs);
      });
      const request = async (method, params) => {
        if (expired || Date.now() >= deadlineAt) throw new Error("Codex history operation timed out");
        return rpc.request(method, params);
      };
      try {
        return await Promise.race([(async () => {
          await rpc.initialize();
          return callback(request);
        })(), deadline]);
      } finally {
        clearTimeout(timer);
        rpc.close();
      }
    });
    const finished = run.finally(() => { queued--; });
    tail = finished.catch(() => {});
    return finished;
  }

  return {
    list({ projectPath: input, cursor = null, allProjects = false } = {}) {
      return operation(async request => {
        if (typeof allProjects !== "boolean") throw new Error("allProjects must be a boolean");
        const project = allProjects ? null : historyProjectPath(input);
        cursor = cursorValue(cursor);
        const seen = new Set(cursor === null ? [] : [cursor]);
        for (let page = 0; page < 5; page++) {
          const result = pageResult(await request("thread/list", {
            ...(project ? { cwd: project.path } : {}), cursor, limit: 20, archived: false,
            sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true,
            modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer"],
          }), cursor);
          if (result.nextCursor !== null) {
            if (seen.has(result.nextCursor)) throw new Error("Codex history returned a repeated cursor cycle");
            seen.add(result.nextCursor);
          }
          const threads = result.data.filter(thread => visible(thread, project)).map(thread => ({
            id: thread.id, title: title(thread), cwd: historyProjectPath(thread.cwd).path,
            updatedAt: thread.updatedAt ?? null, status: status(thread),
          }));
          if (threads.length || result.nextCursor === null || page === 4) {
            return { threads, nextCursor: result.nextCursor };
          }
          cursor = result.nextCursor;
        }
      });
    },

    inspect({ projectPath: input, threadId } = {}) {
      return operation(async request => {
        const thread = await verifiedThread(request, historyProjectPath(input), threadId);
        return { id: thread.id, title: title(thread), cwd: historyProjectPath(thread.cwd).path, status: status(thread) };
      });
    },

    read({ projectPath: input, threadId, cursor = null } = {}) {
      return operation(async request => {
        const project = historyProjectPath(input);
        cursor = cursorValue(cursor);
        const thread = await verifiedThread(request, project, threadId);
        let response;
        try {
          response = await request("thread/turns/list", { threadId, cursor, limit: 3, sortDirection: "desc", itemsView: "full" });
        } catch (error) {
          // includeTurns:true is read-only but loads unbounded history. Do not
          // silently use it on old servers, or on transport/permission errors.
          if (error.rpcCode === -32601) throw new Error("Codex history pagination is unsupported; update Codex (full-history fallback is disabled)", { cause: error });
          throw error;
        }
        const page = pageResult(response, cursor);
        return {
          thread: { id: thread.id, title: title(thread), cwd: thread.cwd, status: status(thread) },
          messages: messagesFromTurns(page.data), nextCursor: page.nextCursor,
        };
      });
    },
  };
}
