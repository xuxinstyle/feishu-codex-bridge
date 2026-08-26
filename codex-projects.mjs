import { spawn as defaultSpawn } from "node:child_process";
import { extractThreadCwds } from "./bridge-core.mjs";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES_PER_FILTER = 100;

function protocolError(response) {
  const message = response?.error?.message || JSON.stringify(response?.error || response);
  return new Error(`Codex App Server request failed: ${message}`);
}

export async function discoverCodexProjectPaths({
  codexCommand = "codex",
  codexArgsPrefix = [],
  shell = false,
  cwd,
  timeoutMs = 15_000,
  pageSize = DEFAULT_PAGE_SIZE,
  spawnImpl = defaultSpawn,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid Codex App Server discovery timeout: ${timeoutMs}`);
  }

  const child = spawnImpl(
    codexCommand,
    [...codexArgsPrefix, "app-server", "--listen", "stdio://"],
    {
      cwd,
      shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  let nextRequestId = 1;
  let inputBuffer = "";
  let settled = false;
  let timer = null;
  const pending = new Map();
  const discoveredPaths = [];

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    child.stdout?.removeListener("data", onStdout);
    child.stderr?.removeListener("data", onStderr);
    child.removeListener("error", onChildError);
    child.removeListener("close", onChildClose);
    if (!child.killed) child.kill();
  };

  const failPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const finish = (callback) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };

  const onChildError = (error) => {
    finish(() => failPending(error));
  };

  const onChildClose = (code, signal) => {
    if (settled) return;
    const detail = signal ? `signal ${signal}` : `code ${code}`;
    finish(() => failPending(new Error(`Codex App Server exited before discovery completed (${detail})`)));
  };

  const onStderr = () => {
    // App Server diagnostics are intentionally ignored here; the caller owns logging.
  };

  const onStdout = (chunk) => {
    inputBuffer += String(chunk);
    const lines = inputBuffer.split(/\r?\n/);
    inputBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (response?.id === undefined || response?.id === null) continue;
      const resolver = pending.get(response.id);
      if (!resolver) continue;
      pending.delete(response.id);
      if (response.error) resolver.reject(protocolError(response));
      else resolver.resolve(response);
    }
  };

  const request = (method, params) => {
    const id = nextRequestId++;
    const message = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(message);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.on("error", onChildError);
  child.on("close", onChildClose);
  timer = setTimeout(() => {
    const error = new Error(`Codex App Server discovery timed out after ${timeoutMs}ms`);
    finish(() => failPending(error));
  }, timeoutMs);

  try {
    await request("initialize", {
      clientInfo: {
        name: "feishu-codex-bridge",
        title: "Feishu Codex Bridge",
        version: "1.0.0",
      },
      capabilities: null,
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

    for (const archived of [false, true]) {
      let cursor = null;
      for (let page = 0; page < MAX_PAGES_PER_FILTER; page += 1) {
        const response = await request("thread/list", {
          archived,
          cursor,
          limit: pageSize,
        });
        discoveredPaths.push(...extractThreadCwds(response));
        const nextCursor = response?.result?.nextCursor ?? null;
        if (!nextCursor) break;
        if (nextCursor === cursor) {
          throw new Error(`Codex App Server returned a repeated thread/list cursor: ${nextCursor}`);
        }
        cursor = nextCursor;
        if (page === MAX_PAGES_PER_FILTER - 1) {
          throw new Error("Codex App Server returned too many thread/list pages");
        }
      }
    }

    return [...new Set(discoveredPaths)];
  } finally {
    finish(() => failPending(new Error("Codex App Server discovery stopped")));
  }
}
