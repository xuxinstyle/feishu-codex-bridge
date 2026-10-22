import net from "node:net";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { CodexAppServer, matchingProjectId, resolveAppServerProjectId } from "./codex-app-server.mjs";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function findDesktopPipe({ env = process.env, platform = process.platform, list = readdirSync } = {}) {
  if (platform !== "win32") return env.CODEX_APP_TOOLS_PIPE_PATH || null;
  let names = [];
  try { names = list("\\\\.\\pipe\\").filter(name => /^codex-app-tools-[a-f0-9-]+$/i.test(name)); } catch {}
  const configured = env.CODEX_APP_TOOLS_PIPE_PATH;
  if (configured && names.some(name => configured === `\\\\.\\pipe\\${name}`)) return configured;
  if (names.length === 1) return `\\\\.\\pipe\\${names[0]}`;
  if (names.length > 1) throw new Error("检测到多个 Codex 客户端，请配置 CODEX_APP_TOOLS_PIPE_PATH 选择要同步的客户端。");
  return null;
}

// This is the framed local pipe protocol used by the installed Codex App Tools
// plugin. Dispatching through Desktop keeps the UI and Feishu on one writer.
export function desktopRequest(pipePath, method, params, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`Codex Desktop ${method} timed out`)), timeoutMs);
    socket.on("error", error => finish(error));
    socket.on("close", () => { if (!settled) finish(new Error("Codex 客户端连接已断开，请打开客户端后重试。")); });
    socket.on("connect", () => {
      const body = Buffer.from(JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }));
      if (body.length > MAX_FRAME_BYTES) return finish(new Error("Codex Desktop request too large"));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    });
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) return finish(new Error("Codex Desktop response too large"));
      if (buffer.length < length + 4) return;
      try {
        const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        if (message.error) finish(new Error(message.error.message));
        else finish(null, message.result);
      } catch (error) { finish(error); }
    });
  });
}

export async function callDesktopTool(pipePath, callerThreadId, tool, args, timeoutMs) {
  let result;
  try { result = await desktopRequest(pipePath, "tools/call", {
    arguments: args, callerSource: "codex", callId: randomUUID(), hostId: "local",
    namespace: "codex_app", threadId: callerThreadId, tool, turnId: randomUUID(),
  }, timeoutMs); } catch (error) { throw new Error(`${tool}: ${error.message}`); }
  const text = result.contentItems?.filter(item => item.type === "inputText").map(item => item.text).join("\n") || "";
  if (!result.success) throw new Error(text || `Codex Desktop ${tool} failed`);
  try { return JSON.parse(text); } catch { throw new Error(`Codex Desktop ${tool} returned invalid JSON: ${text.slice(0, 300)}`); }
}

export async function prepareDesktopThread({ command, argsPrefix, configArgs, cwd, env, shell, threadId, model, sandbox, approvalPolicy, name }) {
  const rpc = new CodexAppServer({ command, argsPrefix, configArgs, cwd, env, shell });
  try {
    await rpc.initialize();
    if (threadId) {
      await rpc.request("thread/read", { threadId });
      return threadId;
    }
    const projectId = await resolveAppServerProjectId(rpc, cwd);
    const result = await rpc.request("thread/start", {
      cwd, ...(model ? { model } : {}), sandbox, approvalPolicy,
      ephemeral: false, threadSource: "user", ...(projectId ? { projectId } : {}),
    });
    const id = result.thread.id;
    await rpc.request("thread/name/set", { threadId: id, name });
    return id;
  } finally {
    // Wait for the temporary writer to exit before Desktop resumes a new thread.
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, 3000);
      rpc.child.once("close", done);
      rpc.close();
      if (rpc.child.exitCode !== null || rpc.child.signalCode) done();
    });
  }
}

export async function runDesktopTask({
  prompt, imagePath, model, effort, cwd, threadId: existingId, timeoutMs = 1_200_000,
  onThread = () => {}, onControl = () => {}, onOutput = () => {}, onProgress = () => {},
  pipePath = findDesktopPipe(), prepare = prepareDesktopThread, callTool = callDesktopTool, ...options
}) {
  if (!pipePath) throw new Error("未检测到 Codex 客户端，请先打开客户端，再从飞书发送消息。");
  onControl({ canCancel: false });
  try {
    const threadId = await prepare({ ...options, cwd, threadId: existingId, model });
    await onThread(threadId);
    const call = (tool, args, waitMs = 60_000) => callTool(pipePath, threadId, tool, args, waitMs);
    // Use Desktop's own project operation as well as server metadata: it updates
    // the sidebar's in-memory membership, so the user need not restart Desktop.
    const catalog = await call("list_projects", {});
    const projectId = matchingProjectId((catalog.projects || []).filter(p => p.projectKind === "local" && p.hostId === "local")
      .map(p => ({ id: p.projectId, roots: [{ path: p.path }] })), cwd);

    let baseline;
    try { baseline = await call("read_thread", { threadId, hostId: "local", turnLimit: 1 }); }
    catch (error) { if (existingId) throw error; baseline = {}; }
    if (baseline.thread?.status?.type === "active") throw new Error("这条会话正在 Codex 客户端执行任务，请等待完成后再从飞书发送消息。");
    const previousTurnId = baseline.turns?.[0]?.id;
    const desktopPrompt = imagePath ? `${prompt}\n\n用户上传的图片保存在本机：${JSON.stringify(imagePath)}。请先使用图片查看工具读取这张图片。` : prompt;
    await call("send_message_to_thread", { threadId, hostId: "local", prompt: desktopPrompt,
      ...(model ? { model } : {}), ...(effort ? { thinking: effort } : {}) });
    if (projectId) await call("move_thread_to_project", { threadId, hostId: "local", projectId });
    onProgress("Codex 客户端已开始处理任务。");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // wait_threads cannot wait on its own calling thread. The Desktop read
      // operation is read-only and does not acquire a second history writer.
      const history = await call("read_thread", { threadId, hostId: "local", turnLimit: 1, maxOutputCharsPerItem: 20_000 });
      const turn = history.turns?.[0];
      if (!turn || turn.id === previousTurnId) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }
      const messages = turn.items?.filter(i => i.type === "agentMessage") || [];
      const final = messages.filter(i => i.phase === "final_answer");
      const output = (final.length ? final : messages).map(i => i.text).join("\n\n");
      if (output) onOutput(output);
      if (turn.status === "completed") return { threadId, turn, output };
      if (["failed", "interrupted"].includes(turn.status)) throw new Error(turn.error?.message || `Codex turn ${turn.status}`);
      if (history.thread?.status?.activeFlags?.some(flag => /waiting|approval|input/i.test(flag))) {
        throw new Error("Codex 客户端需要确认或输入，请到对应聊天中处理。");
      }
      onProgress("Codex 客户端正在执行任务。");
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error("等待 Codex 回复超时；任务可能仍在客户端执行，请在客户端查看或停止。");
  } finally { onControl(null); }
}
