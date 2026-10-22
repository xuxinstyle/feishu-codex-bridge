// Real Codex Desktop model calls and production Feishu handlers. The only
// Feishu messenger is an in-memory recorder; no external test messages are sent.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDesktopTask, callDesktopTool, findDesktopPipe } from "../codex-desktop.mjs";
import { CodexAppServer, desktopCodexBinary } from "../codex-app-server.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "outputs");
mkdirSync(output, { recursive: true });
const work = mkdtempSync(path.join(output, "live-attachment-"));
const harness = path.join(root, `.live-attachment-${randomUUID()}.mjs`);
const configPath = path.join(work, "empty.env");
writeFileSync(configPath, "", "utf8");
Object.assign(process.env, { DOTENV_CONFIG_PATH: configPath, FEISHU_APP_ID: "local-test", FEISHU_APP_SECRET: "local-test",
  SESSION_STATE_PATH: path.join(work, "state.json"), DEFAULT_PROJECT_PATH: root, CODEX_TASK_TRANSPORT: "desktop",
  CODEX_PROJECT_DISCOVERY: "off", CODEX_MODEL: "gpt-6.1-sol", CODEX_REASONING_EFFORT: "high", GENERATED_IMAGE_MAX_COUNT: "0" });
const command = desktopCodexBinary();
const pipe = findDesktopPipe();
const secret = `CONTEXT_${randomUUID().replaceAll("-", "")}`;
const title = `上下文附加验收 ${randomUUID().slice(0, 8)}`;
const actor = { chatId: "local-attachment-chat", senderId: "local-attachment-owner", chatType: "p2p", messageId: "local-attachment-input" };
const evidence = { startedAt: new Date().toISOString(), externalFeishuMessages: 0, seedModel: "gpt-5.6-sol", passed: false, cleanupErrors: [] };
let threadId, active;
async function metadata() {
  const rpc = new CodexAppServer({ command, cwd: work, requestTimeoutMs: 15_000 });
  try { await rpc.initialize(); return (await rpc.request("thread/read", { threadId, includeTurns: false })).thread; }
  finally { rpc.close(); }
}
const buttons = card => card.elements.flatMap(element => element.actions || []);
const until = async predicate => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Attachment card timed out"); await new Promise(resolve => setTimeout(resolve, 50)); }
};
try {
  assert.ok(pipe, "Open Codex Desktop before the real attachment verification");
  const seeded = await runDesktopTask({ command, cwd: work, model: evidence.seedModel, effort: "low", name: title,
    sandbox: "workspace-write", approvalPolicy: "never", timeoutMs: 120_000,
    prompt: `请记住本会话的校验口令：${secret}。不要调用工具，不要读写文件。现在只回复“已记住”，后续提问时再返回口令。` });
  threadId = seeded.threadId;
  evidence.threadId = threadId;
  assert.equal(seeded.turn.status, "completed");
  const before = await metadata();
  evidence.seedTurnId = seeded.turn.id;
  let source = readFileSync(path.join(root, "bridge.mjs"), "utf8").replace(/\r\n/g, "\n");
  source = source.replace('import { runDesktopTask } from "./codex-desktop.mjs";', `import { runDesktopTask as actualRunDesktopTask } from "./codex-desktop.mjs";
const attachmentExecutions = [];
const runDesktopTask = options => { attachmentExecutions.push({ threadId: options.threadId, model: options.model,
  effort: options.effort, preserveThreadPlacement: options.preserveThreadPlacement }); return actualRunDesktopTask(options); };`);
  const boundary = source.indexOf("\nconst client = new Client(");
  const showPanel = source.slice(source.indexOf("async function showControlCard("), source.indexOf("\nif (pairingCode)"));
  const handlers = source.slice(source.indexOf("async function handleMessage("), source.indexOf("\nconst dispatcher ="));
  assert.ok(boundary > 0 && showPanel && handlers);
  writeFileSync(harness, source.slice(0, boundary) + `\nexport function createAttachmentHarness(messenger) {
    const runner = new TaskRunner(messenger), allowedUserIds = new Set([${JSON.stringify(actor.senderId)}]); let pairingCode = null;
    ${showPanel}\n${handlers}
    return { runner, handleMessage, handleCardAction, executions: attachmentExecutions };
  }\n`, "utf8");
  const { createAttachmentHarness } = await import(pathToFileURL(harness));
  const cards = [], texts = [];
  let serial = 0;
  const record = (id, card) => { cards.push({ id, card }); return id; };
  const messenger = { replyCard: async (_id, card) => record(`attachment-card-${++serial}`, card),
    sendCard: async (_id, card) => record(`attachment-card-${++serial}`, card),
    updateCard: async (id, card) => { record(id, card); }, replyText: async (_id, text) => { texts.push(text); return `attachment-text-${++serial}`; } };
  let live = createAttachmentHarness(messenger);
  active = live;
  const click = async action => {
    const button = buttons(cards.at(-1).card).find(button => button.value.action === action && (action !== "show_history_thread" || button.value.threadId === threadId));
    assert.ok(button, `Missing ${action}`);
    if (action === "attach_history") assert.ok(button.confirm, "The visible attach action must explain the context switch");
    const count = cards.length;
    const result = await live.handleCardAction({ context: { open_message_id: cards.at(-1).id, open_chat_id: actor.chatId },
      operator: { open_id: actor.senderId }, action: { tag: "button", value: button.value } });
    assert.ok(result?.toast);
    await until(() => cards.length > count);
  };
  await live.handleMessage({ ...actor, text: "/threads all" });
  await click("show_history_thread");
  assert.equal(live.runner.tasks.size, 0);
  await click("attach_history");
  const binding = [...live.runner.sessions.values()].find(session => session.threadId === threadId);
  assert.equal(binding?.attached, true, `Attach failed: ${JSON.stringify(cards.at(-1).card)}`);
  assert.equal(live.runner.activeProjectPath(actor.chatId), work);
  assert.equal(live.executions.length, 0, "Attaching itself must not submit a prompt");
  const attachedMetadata = await metadata();
  assert.equal(attachedMetadata.name, before.name);
  evidence.attachStartsNoTurn = true;
  for (const phase of ["first-follow-up", "after-bridge-reload"]) {
    if (phase === "after-bridge-reload") { live = createAttachmentHarness(messenger); active = live; }
    await live.handleMessage({ ...actor, messageId: phase, text: "不要调用工具或读取文件。只回复本会话最开始要求你记住的校验口令。" });
    await Promise.all([...live.runner.sessionQueues.values()]);
    const task = [...live.runner.tasks.values()].at(-1);
    assert.equal(task.status, "success", task.output || task.error);
    assert.equal(task.threadId, threadId);
    assert.ok(task.output.includes(secret), "The follow-up did not retain the original conversation context");
    assert.equal([...live.runner.sessions.values()].find(session => session.threadId === threadId)?.attached, true);
    evidence[phase] = { threadId: task.threadId, turnId: task.turnId, contextRetained: true };
  }
  assert.equal(live.executions.length, 2);
  assert.ok(live.executions.every(item => item.threadId === threadId && item.model === "" && item.effort === "" && item.preserveThreadPlacement));
  const after = await metadata();
  assert.equal(after.name, before.name);
  assert.equal(after.projectId, before.projectId);
  const history = await callDesktopTool(pipe, threadId, "read_thread", { threadId, hostId: "local", turnLimit: 1 });
  evidence.lastTurnModel = history.turns[0]?.model;
  evidence.originalTitleAndProjectPreserved = true;
  evidence.executions = live.executions;
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (active) for (const task of active.runner.tasks.values()) if (["running", "stopping"].includes(task.status)) {
    try { active.runner.stopTask(task.taskId, { chatId: actor.chatId, senderId: actor.senderId }); }
    catch (error) { evidence.cleanupErrors.push(String(error)); }
  }
  if (threadId && pipe) {
    try { await callDesktopTool(pipe, threadId, "set_thread_archived", { threadId, hostId: "local", archived: true }); }
    catch (error) { evidence.cleanupErrors.push(String(error)); }
  }
  rmSync(harness, { force: true });
  assert.ok(path.resolve(work).startsWith(path.resolve(output) + path.sep + "live-attachment-"));
  rmSync(work, { recursive: true, force: true });
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(output, "thread-attachment-verification.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}
