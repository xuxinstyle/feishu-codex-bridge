// Opt-in integration test. Requires an open Codex Desktop. Uses real production
// handlers and model execution with a recording messenger; no Feishu requests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callDesktopTool, findDesktopPipe } from "../codex-desktop.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "outputs");
mkdirSync(output, { recursive: true });
const work = mkdtempSync(path.join(output, "live-resume-"));
const harness = path.join(root, `.live-resume-${randomUUID()}.mjs`);
const token = randomUUID().slice(0, 8);
const checkpointPath = path.join(work, "checkpoint-audit.txt");
const checkpoint = `checkpoint-${token}`;
const gatePath = path.join(work, "proceed.gate");
const resultPath = path.join(work, "resumed-result.txt");
const originalResult = `original-${token}`;
const expectedResult = `steered-${token}`;
const forbiddenPath = path.join(work, "old-queue-ran.txt");
const configPath = path.join(work, "empty.env");
writeFileSync(configPath, "", "utf8");
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: configPath, FEISHU_APP_ID: "local-verification", FEISHU_APP_SECRET: "local-verification",
  SESSION_STATE_PATH: path.join(work, "state.json"), DEFAULT_PROJECT_PATH: root,
  CODEX_TASK_TRANSPORT: "desktop", CODEX_SANDBOX_MODE: "workspace-write", CODEX_DANGEROUS_BYPASS: "0",
  CODEX_APPROVAL_POLICY: "never", GENERATED_IMAGE_MAX_COUNT: "0", TASK_TIMEOUT: "150000", LOG_LEVEL: "warn",
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeoutMs, label) {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${label}`);
    await sleep(200);
  }
}
async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
const readText = filename => readFileSync(filename, "utf8").replace(/^\uFEFF/, "").trim();
const checkpointLines = () => existsSync(checkpointPath) ? readText(checkpointPath).split(/\r?\n/).filter(Boolean) : [];
const psLiteral = text => "'" + text.replaceAll("'", "''") + "'";
const checkpointCommand = `Add-Content -LiteralPath ${psLiteral(checkpointPath)} -Value ${psLiteral(checkpoint)} -Encoding utf8`;
const waitCommand = `& { $verificationDeadline = (Get-Date).AddSeconds(95); while (!(Test-Path -LiteralPath ${psLiteral(gatePath)})) { if ((Get-Date) -ge $verificationDeadline) { throw '等待文件条件超时' }; Start-Sleep -Milliseconds 200 } }`;
// This is a normal staged task. It deliberately contains no conditional advice
// about interruption, stopping, continuation, or how to recover from them.
const prompt = `请完成一个分阶段文件任务，只操作下面明确指定的文件，不修改项目代码。
严格按顺序使用三次独立工具调用，不能把不同阶段合并到同一个命令。
第一步：执行一次 ${checkpointCommand}，追加一行审计记录；该记录只能追加一次。
第二步：通过一次独立工具调用执行 ${waitCommand}，等待外部文件条件满足。
第三步：在 ${JSON.stringify(resultPath)} 写入纯文本 ${originalResult}，然后报告结果文件的实际内容。`;
const steeringPrompt = `调整最终成果要求：第三步的结果文件 ${JSON.stringify(resultPath)} 内容改为纯文本 ${expectedResult}，不再写 ${originalResult}。其余步骤保持原样。`;
assert.ok(!/停止|继续|中断/.test(prompt), "The original task must not teach the model how to resume");

function userText(item) {
  const texts = [];
  const visit = value => {
    if (typeof value === "string") { texts.push(value); return; }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    if (typeof value.text === "string") texts.push(value.text);
    else if (value.content !== undefined) visit(value.content);
  };
  visit(item.content ?? item.text ?? item.message);
  return texts.join("\n").replace(/\r\n/g, "\n").trim();
}
function historyInputs(history) {
  const decodeXml = value => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name) => {
    if (name.startsWith("#")) {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name.toLowerCase()];
  });
  return (history.turns || []).flatMap(turn => (turn.items || []).flatMap(item => {
    if (item.type === "userMessage") {
      const parts = Array.isArray(item.content) ? item.content.filter(part => part.type === "text").map(part => part.text) : [userText(item)];
      return parts.map(text => ({ turnId: turn.id, itemId: item.id, source: "userMessage", text: String(text).trim() }));
    }
    if (item.type !== "functionCallOutput" || item.name !== "send_message_to_thread" || item.namespace !== "codex_app") return [];
    const text = typeof item.output === "string" ? item.output : item.output?.text;
    if (typeof text !== "string" || !text.includes("<codex_delegation>")) return [];
    assert.ok(!item.output?.truncated, "The actual delegation input was truncated in history");
    const match = text.match(/<input>([\s\S]*?)<\/input>/);
    assert.ok(match, "The actual delegation is missing its input payload");
    return [{ turnId: turn.id, itemId: item.id, source: "codex_app:delegation", text: decodeXml(match[1]).replace(/\r\n/g, "\n").trim() }];
  }));
}
let runner, first, resumed, scope;
let historySnapshot;
const historySnapshotPath = path.join(output, "task-resume-history.json");
const evidence = { startedAt: new Date().toISOString(), test: "real-stop-steer-and-minimal-resume", externalFeishuMessages: 0,
  originalPrompt: prompt, steeringPrompt, transport: [], desktopSubmissions: [], checkpoints: [], cleanupErrors: [], receipts: [] };
async function captureHistory() {
  if (!first?.threadId) return;
  historySnapshot = await callDesktopTool(findDesktopPipe(), first.threadId, "read_thread", {
    threadId: first.threadId, hostId: "local", turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20_000,
  }, 15_000);
  writeFileSync(historySnapshotPath, JSON.stringify(historySnapshot, null, 2), "utf8");
  evidence.historySnapshot = { source: "desktop:read_thread", path: historySnapshotPath, capturedAt: new Date().toISOString(),
    turnIds: (historySnapshot.turns || []).map(turn => turn.id) };
  return historySnapshot;
}
try {
  let source = readFileSync(path.join(root, "bridge.mjs"), "utf8").replace(/\r\n/g, "\n");
  const desktopImport = 'import { runDesktopTask } from "./codex-desktop.mjs";';
  assert.ok(source.includes(desktopImport), "Cannot instrument the actual desktop transport import");
  source = source.replace(desktopImport, `import { runDesktopTask as actualRunDesktopTask, callDesktopTool as actualCallDesktopTool } from "./codex-desktop.mjs";
import { startDesktopTurn as actualStartDesktopTurn, steerDesktopTurn as actualSteerDesktopTurn } from "./codex-desktop-ipc.mjs";
const liveTransportRecords = [], liveDesktopSubmissions = [], liveNativeErrors = [];
const runDesktopTask = options => {
  liveTransportRecords.push({ prompt: options.prompt, threadId: options.threadId, expectedTurnId: options.expectedTurnId,
    model: options.model, effort: options.effort, imagePath: options.imagePath });
  return actualRunDesktopTask({ ...options, startTurn: async (threadId, submission) => {
    liveDesktopSubmissions.push({ ...submission, threadId, source: "native-user-start" });
    try { return await actualStartDesktopTurn(threadId, submission); }
    catch (error) { liveNativeErrors.push({ phase: "start", message: error.message }); throw error; }
  }, steerTurn: async (threadId, turnId, submission) => {
    liveDesktopSubmissions.push({ ...submission, threadId, turnId, source: "native-user-steer" });
    try { return await actualSteerDesktopTurn(threadId, turnId, submission); }
    catch (error) { liveNativeErrors.push({ phase: "steer", message: error.message }); throw error; }
  }, callTool: async (...args) => {
    if (args[2] === "send_message_to_thread") liveDesktopSubmissions.push({ ...args[3] });
    return actualCallDesktopTool(...args);
  } });
};`);
  const boundary = source.indexOf("\nconst client = new Client(");
  assert.ok(boundary > 0, "Cannot isolate the production runner from Feishu startup");
  const showPanel = source.slice(source.indexOf("async function showControlCard("), source.indexOf("\nif (pairingCode)"));
  const handlers = source.slice(source.indexOf("async function handleMessage("), source.indexOf("\nconst dispatcher ="));
  assert.ok(showPanel && handlers, "Production interaction handlers were not found");
  writeFileSync(harness, source.slice(0, boundary) + `\nexport function createLiveHarness(messenger, senderId) {
    const runner = new TaskRunner(messenger); const allowedUserIds = new Set([senderId]); let pairingCode = null;
    ${showPanel}\n${handlers}
    return { runner, handleMessage, handleCardAction, transportRecords: liveTransportRecords, desktopSubmissions: liveDesktopSubmissions, nativeErrors: liveNativeErrors };
  }\n`, "utf8");
  const { createLiveHarness } = await import(pathToFileURL(harness));
  const cards = [];
  let serial = 0;
  const recordCard = (id, card) => { cards.push({ id, card, recordedAt: Date.now() }); return id; };
  const messenger = {
    replyCard: async (_id, card) => recordCard(`local-card-${++serial}`, card),
    sendCard: async (_id, card) => recordCard(`local-card-${++serial}`, card),
    updateCard: async (id, card) => { recordCard(id, card); },
    replyText: async (_id, text) => { evidence.receipts.push(text); return `local-text-${++serial}`; },
  };
  const actor = { chatId: "local-live-resume", senderId: "local-verification", messageId: "local-input" };
  const live = createLiveHarness(messenger, actor.senderId);
  runner = live.runner;
  evidence.transport = live.transportRecords;
  evidence.desktopSubmissions = live.desktopSubmissions;
  evidence.nativeErrors = live.nativeErrors;
  runner.setActiveSession(actor.chatId, root, "真实停止继续验证");
  await live.handleMessage({ ...actor, text: prompt });
  first = [...runner.tasks.values()][0];
  scope = [...runner.queue.entries.keys()][0];
  await until(() => {
    if (["failed", "success"].includes(first.status)) throw new Error(first.error || first.output || "Original task ended before its gate");
    return first.turnId && first.status === "running" && checkpointLines().length > 0;
  }, 60_000, "real progress checkpoint and active original turn");
  assert.deepEqual(checkpointLines(), [checkpoint]);
  assert.equal(existsSync(resultPath), false, "The result must wait for the external gate");
  assert.equal(existsSync(gatePath), false);
  await until(async () => {
    if (first.status !== "running") throw new Error("Original task ended before the gate command became active");
    // read_thread reconstructs completed items and does not expose a pending
    // command. Inspect the actual unique gate process instead of inferring it
    // from a checkpoint or waiting an arbitrary number of seconds.
    const processes = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command",
      'Get-CimInstance Win32_Process -Filter "Name=\'pwsh.exe\' OR Name=\'powershell.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
      { encoding: "utf8", timeout: 8000, windowsHide: true }).trim() || "[]");
    const gateProcess = [].concat(processes).find(item => item.CommandLine?.includes(path.basename(work)) && item.CommandLine?.includes(path.basename(gatePath)));
    if (gateProcess) evidence.waitingCommand = { processId: gateProcess.ProcessId, observedActive: true };
    return Boolean(gateProcess);
  }, 35_000, "actual active command waiting on the external gate");
  evidence.checkpoints.push({ phase: "before-steering", records: checkpointLines(), status: first.status, turnId: first.turnId });
  console.log(JSON.stringify({ phase: "original-progress-confirmed", taskId: first.taskId, threadId: first.threadId, turnId: first.turnId }));

  await live.handleMessage({ ...actor, messageId: "local-queued", text: `将文本 old 写入 ${JSON.stringify(forbiddenPath)}。` });
  const queued = [...runner.tasks.values()].find(task => task !== first && task.status === "pending");
  assert.ok(queued, "Ordinary follow-up did not enter the original session queue");
  await live.handleMessage({ ...actor, messageId: "local-steer", text: `/steer ${steeringPrompt}` });
  assert.equal(first.steerCount, 1, `The real transport did not acknowledge steering: ${JSON.stringify(live.nativeErrors)}; ${evidence.receipts.at(-1)}`);
  assert.equal(live.desktopSubmissions.filter(item => item.prompt === steeringPrompt).length, 1);
  assert.equal(first.status, "running");
  const stoppedAt = Date.now();
  await live.handleMessage({ ...actor, messageId: "local-stop", text: "/stop" });
  await bounded(runner.queue.idle(scope), 45_000, "original interrupted turn settlement");
  assert.equal(first.status, "interrupted", first.error || first.output);
  assert.equal(queued.status, "pending");
  assert.equal(existsSync(resultPath), false);
  assert.equal(existsSync(forbiddenPath), false);
  assert.deepEqual(checkpointLines(), [checkpoint]);
  assert.equal(runner.queue.isPaused(scope), true);
  evidence.stop = { entry: "text:/stop", threadId: first.threadId, turnId: first.turnId, status: first.status,
    confirmationMs: Date.now() - stoppedAt, acknowledgedSteeringCount: first.steerCount };
  console.log(JSON.stringify({ phase: "interrupted-after-steering", ...evidence.stop }));

  // Change the subsequent-task defaults. Continuation must keep actual original
  // model/effort rather than inherit these changed UI settings.
  const firstTransport = live.transportRecords[0];
  assert.equal(firstTransport.prompt, prompt);
  runner.setModelOverride(actor.chatId, root, "grok-4.6");
  runner.setReasoningOverride(actor.chatId, root, firstTransport.effort === "low" ? "high" : "low");
  writeFileSync(gatePath, "ready", "utf8");
  const stoppedEntry = [...cards].reverse().find(entry => entry.id === first.statusMessageId &&
    entry.card.elements.flatMap(element => element.actions || []).some(button => button.value.action === "resume_task"));
  const resumeButton = stoppedEntry?.card.elements.flatMap(element => element.actions || []).find(button => button.value.action === "resume_task");
  assert.ok(resumeButton, "The production stopped card did not offer continuation");
  assert.equal(resumeButton.value.taskId, first.taskId);
  const acknowledgement = await live.handleCardAction({ schema: "2.0", header: { event_type: "card.action.trigger", event_id: `live-resume-${randomUUID()}` },
    event: { context: { open_message_id: stoppedEntry.id, open_chat_id: actor.chatId },
      operator: { open_id: actor.senderId }, action: { tag: "button", value: resumeButton.value } } });
  assert.ok(acknowledgement?.toast, "The real SDK card callback did not acknowledge continuation");
  await until(() => first.resumedAs, 15_000, "continuation admitted through production card callback");
  resumed = runner.tasks.get(first.resumedAs);
  assert.ok(resumed);
  await bounded(runner.queue.idle(scope), 150_000, "continuation completion");
  // Save the real history before any assertion about the model's result. A
  // failure must retain the exact inputs that were actually persisted.
  await captureHistory();
  assert.equal(resumed.status, "success", resumed.error || resumed.output);
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.model, first.model);
  assert.notEqual(resumed.turnId, first.turnId);
  assert.equal(resumed.prompt, prompt, "The card task title was replaced by control instructions");
  assert.equal(readText(resultPath), expectedResult, "Continuation lost the acknowledged steering requirement");
  assert.deepEqual(checkpointLines(), [checkpoint], "Continuation replayed completed checkpoint work");
  assert.equal(queued.status, "pending");
  assert.equal(runner.queue.isPaused(scope), true);
  assert.equal(existsSync(forbiddenPath), false);
  assert.equal(live.transportRecords.length, 2);
  const resumedTransport = live.transportRecords[1];
  assert.equal(resumedTransport.prompt, "继续", "Continuation must use the minimal user message");
  assert.equal(resumedTransport.model, firstTransport.model);
  assert.equal(resumedTransport.effort, firstTransport.effort);
  assert.equal(resumedTransport.threadId, first.threadId);
  assert.equal(resumedTransport.expectedTurnId, first.turnId);
  assert.deepEqual(live.desktopSubmissions.map(item => item.prompt), [prompt, steeringPrompt, "继续"]);
  const firstCardLine = cards.find(entry => entry.id === first.statusMessageId)?.card.elements.find(element => element.tag === "markdown")?.content;
  const resumedCardLine = cards.find(entry => entry.id === resumed.statusMessageId)?.card.elements.find(element => element.tag === "markdown")?.content;
  assert.equal(resumedCardLine, firstCardLine, "The resumed card must retain the original task title");
  assert.ok(!resumedCardLine.includes("先核对"));

  // Read the actual Desktop history after completion; recording attempted sends
  // alone would not prove that steering and continuation reached one thread.
  const history = historySnapshot;
  assert.ok(!history.page?.hasMore, "The actual history snapshot did not include every turn");
  const inputs = historyInputs(history);
  const userMessages = inputs.map(input => input.text);
  for (const expected of [prompt, steeringPrompt, "继续"]) {
    assert.equal(userMessages.filter(text => text === expected).length, 1, `Actual Desktop history missing or repeating user message: ${expected.slice(0, 80)}`);
  }
  assert.equal(userMessages.length, 3, "Unexpected synthetic user messages polluted the real thread history");
  for (const expected of [steeringPrompt, "继续"]) {
    assert.equal(inputs.find(item => item.text === expected)?.source, "userMessage", "Control inputs must be durable user messages, not delegated tool output");
  }
  assert.ok(userMessages.every(text => !text.includes("先核对已经完成的进展")));
  evidence.history = { source: "desktop:read_thread", turnIds: (history.turns || []).map(turn => turn.id), inputs, userMessages,
    originalCount: 1, steeringCount: 1, continuationCount: 1 };
  evidence.resume = { entry: "sdk-card:resume_task", threadId: resumed.threadId, turnId: resumed.turnId, model: resumedTransport.model,
    effort: resumedTransport.effort, status: resumed.status, originalCardTitlePreserved: true, minimalContinuation: true,
    artifactContent: readText(resultPath), auditCheckpointCount: checkpointLines().length, oldQueueStillPaused: true };
  evidence.passed = true;
  console.log(JSON.stringify({ phase: "resumed-original-task-with-steering", ...evidence.resume }));
} catch (error) {
  evidence.passed = false;
  evidence.error = error.stack || error.message;
  throw error;
} finally {
  // Release a surviving gate poll before removing its directory. The model's
  // wait command also has its own 95-second deadline if the harness is killed.
  writeFileSync(gatePath, "cleanup", "utf8");
  if (runner && scope) {
    for (const task of [first, resumed].filter(Boolean)) {
      if (["running", "stopping"].includes(task.status)) {
        try { runner.stopTask(task.taskId, { chatId: task.source.chatId, senderId: task.source.senderId }); }
        catch (error) { evidence.cleanupErrors.push(error.message); }
      }
    }
    await bounded(runner.queue.idle(scope), 25_000, "cleanup active turn settlement").catch(error => evidence.cleanupErrors.push(error.message));
  }
  // Also capture early failures (before result assertions or before admission)
  // after cleanup has settled the live turn, while the thread remains readable.
  if (!evidence.passed) {
    await captureHistory().catch(error => evidence.cleanupErrors.push(`history capture: ${error.message}`));
  }
  evidence.finishedAt = new Date().toISOString();
  if (first?.threadId) {
    await callDesktopTool(findDesktopPipe(), first.threadId, "set_thread_archived", { threadId: first.threadId, hostId: "local", archived: true }, 15_000)
      .catch(error => evidence.cleanupErrors.push(error.message));
  }
  writeFileSync(path.join(output, "task-resume-verification.json"), JSON.stringify(evidence, null, 2), "utf8");
  rmSync(harness, { force: true });
  assert.ok(path.resolve(work).startsWith(output + path.sep + "live-resume-"));
  rmSync(work, { recursive: true, force: true });
}
