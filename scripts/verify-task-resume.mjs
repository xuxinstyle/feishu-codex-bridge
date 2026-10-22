// Opt-in integration test. Requires an open Codex Desktop. Runs a real model
// task through the production runner, using a local recording Feishu messenger.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callDesktopTool, findDesktopPipe } from "../codex-desktop.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "outputs");
mkdirSync(output, { recursive: true });
const work = mkdtempSync(path.join(output, "live-resume-"));
const harness = path.join(root, `.live-resume-${randomUUID()}.mjs`);
const token = `resume-${randomUUID().slice(0, 8)}`;
const resultPath = path.join(work, "resumed-result.txt");
const forbiddenPath = path.join(work, "old-queue-ran.txt");
const configPath = path.join(work, "empty.env");
writeFileSync(configPath, "", "utf8");
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: configPath, FEISHU_APP_ID: "local-verification", FEISHU_APP_SECRET: "local-verification",
  SESSION_STATE_PATH: path.join(work, "state.json"), DEFAULT_PROJECT_PATH: root,
  CODEX_TASK_TRANSPORT: "desktop", CODEX_SANDBOX_MODE: "workspace-write", CODEX_DANGEROUS_BYPASS: "0",
  CODEX_APPROVAL_POLICY: "never", GENERATED_IMAGE_MAX_COUNT: "0", TASK_TIMEOUT: "150000", LOG_LEVEL: "warn",
});

async function until(predicate, timeoutMs, label) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

let runner, first, resumed, scope;
const evidence = { startedAt: new Date().toISOString(), test: "real-stop-and-resume", externalFeishuMessages: 0 };
try {
  const source = readFileSync(path.join(root, "bridge.mjs"), "utf8");
  const boundary = source.indexOf("\nconst client = new Client(");
  assert.ok(boundary > 0, "Cannot isolate the production runner from Feishu startup");
  const showPanel = source.slice(source.indexOf("async function showControlCard("), source.indexOf("\nif (pairingCode)"));
  const handlers = source.slice(source.indexOf("async function handleMessage("), source.indexOf("\nconst dispatcher ="));
  assert.ok(showPanel && handlers, "Production interaction handlers were not found");
  writeFileSync(harness, source.slice(0, boundary) + `\nexport function createLiveHarness(messenger, senderId) {
    const runner = new TaskRunner(messenger); const allowedUserIds = new Set([senderId]); let pairingCode = null;
    ${showPanel}\n${handlers}\nreturn { runner, handleMessage, handleNormalizedCardAction };\n}\n`, "utf8");
  const { createLiveHarness } = await import(pathToFileURL(harness));
  const cards = [];
  let serial = 0;
  const messenger = {
    replyCard: async (_id, card) => { cards.push(card); return `local-card-${++serial}`; },
    sendCard: async (_id, card) => { cards.push(card); return `local-card-${++serial}`; },
    updateCard: async (_id, card) => { cards.push(card); },
    replyText: async () => `local-text-${++serial}`,
  };
  const actor = { chatId: "local-live-resume", senderId: "local-verification", messageId: "local-input" };
  const live = createLiveHarness(messenger, actor.senderId);
  runner = live.runner;
  runner.setActiveSession(actor.chatId, root, "真实停止继续验证");
  const prompt = `这是本地停止和继续验证，只在指定输出文件中写入内容，不改其他文件。
原任务分两步：先单独运行 Start-Sleep -Seconds 45；等待结束后再通过另一次工具调用将文本 ${token} 写入 ${JSON.stringify(resultPath)}，最终回复“续作验证完成 ${token}”。等待和写入不得放在同一条命令。
如果任务被停止后收到继续要求，请直接完成写入步骤，不再等待；不要重新执行等待命令。`;
  await live.handleMessage({ ...actor, text: prompt });
  first = [...runner.tasks.values()][0];
  await until(() => first.turnId || ["failed", "success"].includes(first.status), 45000, "first active turn");
  assert.equal(first.status, "running", first.error || first.output);
  scope = [...runner.queue.entries.keys()][0];
  await live.handleMessage({ ...actor, messageId: "local-queued", text: `这是一条旧待办：将 old 写入 ${JSON.stringify(forbiddenPath)}。本次验证不应执行它。` });
  const queued = [...runner.tasks.values()][1];
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.equal(first.status, "running", "The first task finished before interruption");
  assert.equal(existsSync(resultPath), false, "Task completed its objective before stop");
  const stoppedAt = Date.now();
  await live.handleMessage({ ...actor, messageId: "local-stop", text: "/stop" });
  await runner.queue.idle(scope);
  assert.equal(first.status, "interrupted", first.error || first.output);
  assert.equal(queued.status, "pending");
  assert.equal(existsSync(resultPath), false);
  assert.equal(existsSync(forbiddenPath), false);
  assert.equal(runner.queue.isPaused(scope), true);
  evidence.stop = { entry: "text:/stop", threadId: first.threadId, turnId: first.turnId, status: first.status, confirmationMs: Date.now() - stoppedAt };
  console.log(JSON.stringify({ phase: "interrupted", ...evidence.stop }));

  // Simulate selecting a different model while stopped. Continuation must keep
  // the original task's model and thread rather than start a fresh conversation.
  runner.setModelOverride(actor.chatId, root, "grok-4.6");
  const stoppedCard = [...cards].reverse().find(card => card.header.title.content === "已停止");
  const resumeButton = stoppedCard?.elements.flatMap(element => element.actions || []).find(action => action.value.action === "resume_task");
  assert.ok(resumeButton, "Stopped card did not offer continuation");
  await live.handleNormalizedCardAction({ chatId: actor.chatId, messageId: first.statusMessageId,
    operator: { openId: actor.senderId }, action: { value: resumeButton.value } });
  resumed = runner.tasks.get(first.resumedAs);
  assert.ok(resumed, "The real card handler did not create a continuation task");
  await runner.queue.idle(scope);
  assert.equal(resumed.status, "success", resumed.error || resumed.output);
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.model, first.model);
  assert.notEqual(resumed.turnId, first.turnId);
  assert.equal(readFileSync(resultPath, "utf8").replace(/^\uFEFF/, "").trim(), token);
  assert.equal(queued.status, "pending");
  assert.equal(runner.queue.isPaused(scope), true);
  assert.equal(existsSync(forbiddenPath), false);
  evidence.resume = { entry: "card:resume_task", threadId: resumed.threadId, turnId: resumed.turnId, model: resumed.model, status: resumed.status,
    artifactVerified: true, oldQueueStillPaused: true, continuationActionPresent: true };
  evidence.passed = true;
  console.log(JSON.stringify({ phase: "resumed-original-task", ...evidence.resume }));
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  throw error;
} finally {
  if (runner && scope) {
    for (const task of [first, resumed].filter(Boolean)) {
      if (["running", "stopping"].includes(task.status)) runner.stopTask(task.taskId, { chatId: task.source.chatId, senderId: task.source.senderId });
    }
    await runner.queue.idle(scope);
  }
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(output, "task-resume-verification.json"), JSON.stringify(evidence, null, 2), "utf8");
  if (first?.threadId) await callDesktopTool(findDesktopPipe(), first.threadId, "set_thread_archived", { threadId: first.threadId, hostId: "local", archived: true }).catch(() => {});
  rmSync(harness, { force: true });
  assert.ok(path.resolve(work).startsWith(output + path.sep + "live-resume-"));
  rmSync(work, { recursive: true, force: true });
}
