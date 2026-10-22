import net from "node:net";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function desktopIpcPath(env = process.env, platform = process.platform) {
  return env.CODEX_DESKTOP_IPC_PATH || (platform === "win32" ? "\\\\.\\pipe\\codex-ipc"
    : path.join(env.CODEX_HOME || path.join(homedir(), ".codex"), "ipc", "ipc.sock"));
}

// Desktop's versioned follower protocol routes requests to the process that
// owns a conversation. Do not acquire another app-server history writer.
export class DesktopSessionControl {
  constructor({ pipePath = desktopIpcPath(), timeoutMs = 8000, connect = net.createConnection } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.clientId = "initializing-client";
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.socket = connect(pipePath);
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.ready.catch(() => {});
    this.socket.on("data", chunk => this.receive(chunk));
    this.socket.on("error", error => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("Codex 桌面控制连接已断开")));
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME_BYTES) throw new Error("Desktop control frame too large");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) return this.fail(new Error("Invalid Desktop control frame"));
      if (this.buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")); }
      catch { return this.fail(new Error("Invalid Desktop control response")); }
      this.buffer = this.buffer.subarray(length + 4);
      if (message.type === "client-discovery-request") {
        this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
      } else if (message.type === "response") {
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.resultType === "success") pending.resolve(message);
        else pending.reject(new Error(`Codex 桌面控制请求失败: ${message.error || "unknown"}`));
      }
    }
  }

  async request(method, params, { version = 0, targetClientId } = {}) {
    await Promise.race([this.ready, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Codex 桌面控制连接超时")), this.timeoutMs);
      timer.unref();
      this.ready.finally(() => clearTimeout(timer)).catch(() => {});
    })]);
    if (this.closed) throw new Error("Codex 桌面控制连接已关闭");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Codex 桌面控制 ${method} 超时`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({ type: "request", requestId, sourceClientId: this.clientId, method, version, params,
          ...(targetClientId ? { targetClientId } : {}), timeoutMs: this.timeoutMs });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async initialize() {
    const response = await this.request("initialize", { clientType: "feishu-codex-bridge" });
    this.clientId = response.result.clientId;
  }

  async findOwner(threadId) {
    const result = await this.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }, { version: 1 });
    if (!result.handledByClientId) throw new Error("Codex 客户端尚未加载这条会话，请在客户端打开后重试。");
    return result.handledByClientId;
  }

  async start(threadId, { prompt, textInputs = [], imagePath, model, effort, clientUserMessageId = randomUUID(), onSubmission = () => {} } = {}) {
    if (!threadId || !prompt?.trim()) throw new Error("提交任务需要明确的会话和消息内容");
    let owner;
    try { owner = await this.findOwner(threadId); }
    catch (error) {
      if (/no-client-found/.test(error.message)) throw new Error("Codex 客户端尚未加载这条会话，请在客户端打开后重试。");
      throw error;
    }
    if (!Array.isArray(textInputs) || textInputs.some(text => typeof text !== "string" || !text.trim())) throw new Error("待恢复的补充要求格式无效");
    const input = [...textInputs, prompt].map(text => ({ type: "text", text, text_elements: [] }));
    if (imagePath) input.push({ type: "localImage", path: imagePath });
    // Local Desktop owns the history writer and starts a real user turn.
    // useUserMessageAdmission is cloud-only; local owners use turn/start.
    onSubmission("submitting");
    const response = await this.request("thread-follower-start-turn", {
      conversationId: threadId,
      turnStart: {
        request: { threadId, input, clientUserMessageId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
        context: { inheritThreadSettings: true },
      },
    }, { version: 2, targetClientId: owner });
    const result = response.result?.result;
    if (!result?.turn?.id) {
      throw Object.assign(new Error("客户端未确认用户消息已保存，请在客户端核对后再继续。"), { submissionOutcomeUnknown: true });
    }
    onSubmission("submitted");
    return result;
  }

  async steer(threadId, turnId, options) {
    const { prompt, cwd, clientUserMessageId = randomUUID() } = options || {};
    if (!threadId || !turnId || !prompt?.trim()) throw new Error("补充要求需要明确的会话、执行轮次和消息内容");
    const owner = await this.findOwner(threadId);
    // Match Desktop's own restore-message envelope; toolOutput must be absent
    // so the owner sends turn/steer rather than queues a delegated turn/start.
    const restoreMessage = { id: clientUserMessageId, text: prompt, createdAt: Date.now(), ...(cwd ? { cwd } : {}),
      context: { prompt, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: cwd ? [cwd] : [] },
    };
    const response = await this.request("thread-follower-steer-turn", {
      conversationId: threadId, clientUserMessageId,
      input: [{ type: "text", text: prompt, text_elements: [] }], restoreMessage, attachments: [],
    }, { version: 1, targetClientId: owner });
    const result = response.result?.result;
    if (result?.turnId !== turnId) {
      throw Object.assign(new Error("客户端未确认补充要求进入目标轮次，请在客户端核对。"), { steerOutcomeUnknown: true });
    }
    return { turnId, clientUserMessageId };
  }

  async interrupt(threadId, turnId) {
    if (!threadId || !turnId) throw new Error("停止任务需要明确的会话和执行轮次");
    const owner = await this.findOwner(threadId);
    const response = await this.request("thread-follower-interrupt-turn", {
      conversationId: threadId, mode: "user-stop", expectedTurnId: turnId,
    }, { version: 4, targetClientId: owner });
    if (!response.result?.ok || response.result.interruptedTurnId !== turnId) {
      throw new Error("客户端未确认中断目标轮次，请重新检查任务状态");
    }
    return response.result;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.socket.destroy();
  }

  close() { this.fail(new Error("Desktop control closed")); }
}

export async function interruptDesktopTurn(threadId, turnId, options) {
  const control = new DesktopSessionControl(options);
  try {
    await control.initialize();
    return await control.interrupt(threadId, turnId);
  } finally { control.close(); }
}

export async function startDesktopTurn(threadId, submission, options) {
  const control = new DesktopSessionControl(options);
  try {
    await control.initialize();
    return await control.start(threadId, submission);
  } finally { control.close(); }
}

export async function steerDesktopTurn(threadId, turnId, submission, options) {
  const control = new DesktopSessionControl(options);
  try {
    await control.initialize();
    return await control.steer(threadId, turnId, submission);
  } finally { control.close(); }
}
