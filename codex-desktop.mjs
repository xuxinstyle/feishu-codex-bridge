import net from "node:net";
import { isModelReconnectRejection } from "./model-reconnect.mjs";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { CodexAppServer, matchingProjectId, resolveAppServerProjectId } from "./codex-app-server.mjs";
import { interruptDesktopTurn, startDesktopTurn, steerDesktopTurn } from "./codex-desktop-ipc.mjs";
import { TurnInterrupt } from "./turn-interrupt.mjs";
import { missingSteeringInputs } from "./steering-context.mjs";
import { historyProjectPath } from "./codex-history.mjs";

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

export async function steerDesktopTask({ pipePath, threadId, turnId, prompt, callTool = callDesktopTool, steerTurn = steerDesktopTurn }) {
  if (!prompt?.trim()) throw new Error("补充要求不能为空。");
  const history = await callTool(pipePath, threadId, "read_thread", { threadId, hostId: "local", turnLimit: 1 });
  const active = history.turns?.[0];
  if (!turnId || active?.id !== turnId || active.status !== "inProgress") {
    throw new Error("原任务轮次已结束或已切换，无法引导；消息仍留在队列。");
  }
  // Save a real user message through the owner before confirming steering.
  // Delegated tool output can remain queued and disappear when stopped.
  try {
    return await steerTurn(threadId, turnId, { prompt, ...(history.thread?.cwd ? { cwd: history.thread.cwd } : {}) });
  } catch (error) {
    error.steerOutcomeUnknown = true;
    throw error;
  }
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
  prompt, imagePath, model, effort, cwd, threadId: existingId, preserveThreadPlacement = false, expectedTurnId, continuationInputs = [], expectedInitialInputKind, timeoutMs = 1_200_000,
  onThread = () => {}, onTurnStarted = () => {}, onControl = () => {}, onOutput = () => {}, onProgress = () => {},
  onSubmission = () => {},
  interruptTurn = interruptDesktopTurn,
  startTurn = startDesktopTurn, steerTurn = steerDesktopTurn,
  pollIntervalMs = 1500,
  pipePath = findDesktopPipe(), prepare = prepareDesktopThread, callTool = callDesktopTool, ...options
}) {
  const resumeConflict = () => new Error("会话已有新内容或原轮次未停止，请从当前会话继续。");
  if (preserveThreadPlacement && !existingId) throw new Error("附加已有会话必须提供 threadId，不能新建会话。");
  if (expectedTurnId && !existingId) throw resumeConflict();
  if (continuationInputs.length && !expectedTurnId) throw resumeConflict();
  if (!pipePath) throw new Error("未检测到 Codex 客户端，请先打开客户端，再从飞书发送消息。");
  let finished = false;
  let interruption = new TurnInterrupt(interruptTurn);
  onControl({ canCancel: true, interrupt: () => interruption.request() });
  try {
    const threadId = await prepare({ ...options, cwd, threadId: existingId, model });
    if ((preserveThreadPlacement || expectedTurnId) && threadId !== existingId) throw resumeConflict();
    await onThread(threadId);
    const call = (tool, args, waitMs = 60_000) => callTool(pipePath, threadId, tool, args, waitMs);
    let projectId;
    if (!preserveThreadPlacement) {
      // Desktop's project operation also updates the sidebar's in-memory
      // membership. Explicitly attached threads keep their original placement.
      const catalog = await call("list_projects", {});
      projectId = matchingProjectId((catalog.projects || []).filter(p => p.projectKind === "local" && p.hostId === "local")
        .map(p => ({ id: p.projectId, roots: [{ path: p.path }] })), cwd);
    }

    let baseline;
    try { baseline = await call("read_thread", { threadId, hostId: "local", turnLimit: 1, ...(continuationInputs.length ? { maxOutputCharsPerItem: 20_000 } : {}) }); }
    catch (error) { if (expectedTurnId) throw resumeConflict(); if (existingId) throw error; baseline = {}; }
    if (expectedTurnId && (baseline?.turns?.[0]?.id !== expectedTurnId || baseline.turns[0].status !== "interrupted" || baseline.thread?.status?.type === "active")) throw resumeConflict();
    if (baseline.thread?.status?.type === "active") throw new Error("这条会话正在 Codex 客户端执行任务，请等待完成后再从飞书发送消息。");
    if (preserveThreadPlacement) {
      if (baseline.thread?.id !== threadId || historyProjectPath(baseline.thread?.cwd).key !== historyProjectPath(cwd).key) {
        throw new Error("附加会话的标识或目录已变化，请重新选择并附加。");
      }
      if (baseline.turns?.[0]?.status === "inProgress") throw new Error("这条会话正在 Codex 客户端执行任务，请等待完成后再从飞书发送消息。");
      if (!["idle", "notLoaded"].includes(baseline.thread?.status?.type)) throw new Error("附加会话的状态尚未确认，请在客户端检查。");
    }
    let previousTurnId = baseline.turns?.[0]?.id;
    const textInputs = expectedTurnId ? missingSteeringInputs(baseline.turns[0], continuationInputs, expectedInitialInputKind).map(item => item.prompt) : [];
    const desktopPrompt = imagePath ? `${prompt}\n\n用户上传的图片保存在本机：${JSON.stringify(imagePath)}。请先使用图片查看工具读取这张图片。` : prompt;
    if (!interruption.beginSubmission()) return { threadId, turn: { status: "interrupted" }, output: "任务在提交前已停止。" };
    let activeTurnId;
    if (expectedTurnId) {
      const admitted = await startTurn(threadId, { prompt, textInputs, imagePath,
        ...(model ? { model } : {}), ...(effort ? { effort } : {}), onSubmission });
      if (!admitted.turn?.id || admitted.turn.id === expectedTurnId || admitted.admissionOutcome && admitted.admissionOutcome !== "started") {
        throw Object.assign(new Error("客户端未确认独立续作轮次，请在客户端核对，避免重复提交。"), { submissionOutcomeUnknown: true });
      }
      activeTurnId = admitted.turn.id;
      onTurnStarted({ threadId, turnId: activeTurnId });
      interruption.observe(threadId, activeTurnId);
    } else {
      onSubmission("submitting");
      await call("send_message_to_thread", { threadId, hostId: "local", prompt: desktopPrompt,
        ...(model ? { model } : {}), ...(effort ? { thinking: effort } : {}) });
      onSubmission("submitted");
    }
    if (projectId) await call("move_thread_to_project", { threadId, hostId: "local", projectId });
    onProgress("Codex 客户端已开始处理任务。");
    onControl({ canCancel: true, interrupt: () => interruption.request(), steer: prompt => {
      if (finished) throw new Error("当前轮次已结束，无法引导。");
      return steerDesktopTask({ pipePath, threadId, turnId: activeTurnId, prompt, callTool, steerTurn });
    } });
    const deadline = Date.now() + timeoutMs;
    let modelReconnectRetried = false;
    while (Date.now() < deadline) {
      // wait_threads cannot wait on its own calling thread. The Desktop read
      // operation is read-only and does not acquire a second history writer.
      const history = await call("read_thread", { threadId, hostId: "local", turnLimit: 1, maxOutputCharsPerItem: 20_000 });
      const turn = history.turns?.[0];
      if (!turn || turn.id === previousTurnId) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        continue;
      }
      if (!activeTurnId) { activeTurnId = turn.id; onTurnStarted({ threadId, turnId: turn.id }); }
      if (turn.id !== activeTurnId) throw new Error("Codex 客户端已切换轮次，请在客户端查看原任务结果。");
      const messages = turn.items?.filter(i => i.type === "agentMessage") || [];
      const final = messages.filter(i => i.phase === "final_answer");
      const output = (final.length ? final : messages).map(i => i.text).join("\n\n");
      if (output) onOutput(output);
      if (["completed", "interrupted"].includes(turn.status)) return { threadId, turn, output };
      if (!existingId && !modelReconnectRetried && !interruption.requested && isModelReconnectRejection(turn)) {
        const latest = await call("read_thread", { threadId, hostId: "local", turnLimit: 1 });
        if (latest.turns?.[0]?.id !== turn.id || latest.thread?.status?.type === "active") {
          throw new Error("模型重连前会话已变化，请在客户端查看当前任务。");
        }
        if (interruption.requested) return { threadId, turn: { ...turn, status: "interrupted" }, output: "任务已停止。" };
        // The rejected request did no model work. The engine discarded that
        // connection; retry once on its new connection using the same owner.
        modelReconnectRetried = true;
        interruption.finish();
        interruption = new TurnInterrupt(interruptTurn);
        interruption.beginSubmission();
        previousTurnId = turn.id;
        activeTurnId = undefined;
        onProgress("模型连接需要重新建立，正在重试尚未执行的请求。");
        await call("send_message_to_thread", { threadId, hostId: "local", prompt: desktopPrompt,
          ...(model ? { model } : {}), ...(effort ? { thinking: effort } : {}) });
        continue;
      }
      if (turn.status === "failed") throw new Error(turn.error?.message || `Codex turn ${turn.status}`);
      interruption.observe(threadId, activeTurnId);
      if (history.thread?.status?.activeFlags?.some(flag => /waiting|approval|input/i.test(flag))) {
        throw new Error("Codex 客户端需要确认或输入，请到对应聊天中处理。");
      }
      onProgress("Codex 客户端正在执行任务。");
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error("等待 Codex 回复超时；任务可能仍在客户端执行，请在客户端查看或停止。");
  } finally { finished = true; interruption.finish(); onControl(null); }
}
