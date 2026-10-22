import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import * as core from "../bridge-core.mjs";
import { TaskSteering, buildSteeringCard } from "../task-steering.mjs";
import { APP_SERVER_SESSION_BACKEND, canResumeAppServerSession } from "../codex-app-server.mjs";
import { SessionTaskQueue } from "../task-queue.mjs";
import { TaskInterruption } from "../task-interruption.mjs";
import { buildTaskCard, buildPanelCard } from "../feishu-cards.mjs";

// Exercise the production handlers and runner without starting the real Feishu
// WebSocket, loading credentials, or writing the user's saved session bindings.
const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const helpers = source.slice(source.indexOf("function normalizeSessionName("), source.indexOf("const CARD_BRIDGE_ID"));
const cardParser = source.slice(source.indexOf("function parseCardActionValue("), source.indexOf("function firstNonEmptyLine("));
const runnerSource = source.slice(source.indexOf("class TaskRunner {"), source.indexOf("\nconst client = new Client("));
const panelBuilder = source.slice(source.indexOf("function buildControlCard("), source.indexOf("\nclass TaskRunner"));
const showPanel = source.slice(source.indexOf("async function showControlCard("), source.indexOf("\nif (pairingCode)"));
const handlers = source.slice(source.indexOf("async function handleMessage("), source.indexOf("\nconst dispatcher ="));

function fixture({ deliveryError, initialStatusUpdateFails = false, supportsInterrupt = false } = {}) {
  const texts = [], cards = [], executions = [], deliveries = [], downloads = [], models = [];
  let serial = 0, finish;
  const messenger = {
    replyText: async (_id, text) => { texts.push(text); return `text-${++serial}`; },
    sendText: async (_id, text) => { texts.push(text); return `text-${++serial}`; },
    updateText: async (_id, text) => { texts.push(text); if (initialStatusUpdateFails && /已提交引导/.test(text)) throw new Error("Feishu update unavailable"); },
    replyCard: async (_id, card) => { cards.push(card); return `card-${++serial}`; },
    sendCard: async (_id, card) => { cards.push(card); return `card-${++serial}`; },
    updateCard: async (_id, card) => { cards.push(card); if (initialStatusUpdateFails && /已提交引导/.test(JSON.stringify(card))) throw new Error("Feishu update unavailable"); },
    downloadMessageResource: async (messageId, key) => { downloads.push({ messageId, key }); return { contentType: "image/png" }; },
  };
  const execute = async options => {
    let status = "completed";
    executions.push(options.prompt);
    models.push({ model: options.model, threadId: options.threadId });
    options.onThread("thread-a");
    options.onControl({ canCancel: supportsInterrupt, ...(supportsInterrupt ? { interrupt: async () => { status = "interrupted"; finish?.(); return { ok: true }; } } : {}), steer: async prompt => {
      deliveries.push(prompt);
      if (deliveryError) throw deliveryError;
      return { turnId: "turn-a" };
    } });
    options.onTurnStarted?.({ threadId: "thread-a", turnId: `turn-${executions.length}` });
    if (executions.length === 1) await new Promise(resolve => { finish = resolve; });
    options.onControl(null);
    return { threadId: "thread-a", turn: { id: `turn-${executions.length}`, status }, output: status === "interrupted" ? "任务已停止" : "任务完成" };
  };
  const context = vm.createContext({
    ...core, TaskSteering, buildSteeringCard, SessionTaskQueue, TaskInterruption, buildTaskCard, buildPanelCard, APP_SERVER_SESSION_BACKEND, canResumeAppServerSession,
    messenger, path, process: { env: {} }, Date: class extends Date { static now() { return 100; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    config: { codex: { transport: "desktop", configOverrides: [], defaultModel: "gpt-6.1-sol" }, bridge: {
      defaultProjectPath: "repo", projectChoices: [], streamPushInterval: 30_000, generatedImageMaxCount: 0,
    } },
    readSessionState: () => ({}), writeSessionState: () => {}, log: () => {},
    existsSync: () => true, codexLauncher: {}, codexHome: "unused", generateTaskId: () => `task-${++serial}`,
    runDesktopTask: execute, truncateText: text => text, formatDuration: () => "0s",
    compactText: text => text, resolveProjectPath: value => value, projectDisplayName: value => path.basename(value),
    tmpdir: () => "test-temp", renameSync: () => {}, rmSync: () => {},
    CARD_BRIDGE_ID: "feishu-codex-bridge", pairingCode: null, allowedUserIds: new Set(["user"]),
  });
  vm.runInContext(`${helpers}\n${cardParser}\n${panelBuilder}\n${runnerSource}\nvar runner = new TaskRunner(messenger);\n${showPanel}\n${handlers}`, context);
  const message = (text, id = "message") => context.handleMessage({
    text, messageId: id, chatId: "chat", senderId: "user", chatType: "p2p",
  });
  const drain = () => Promise.all([...context.runner.sessionQueues.values()]);
  const begin = async () => {
    await message("原任务");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(executions, ["原任务"]);
  };
  return { context, texts, cards, executions, deliveries, downloads, models, message, drain, begin, finish: () => finish?.() };
}

test("a queued message can be steered through its own card after a panel refresh", async t => {
  const f = fixture();
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  await f.message("先完成测试", "follow-up");
  const queued = [...f.context.runner.tasks.values()].find(task => task.status === "pending");
  assert.ok(JSON.stringify(f.cards.at(-1)).includes("补充给当前任务"));
  f.context.runner.setControlCardMessageId("chat", "new-panel");
  const event = { messageId: queued.steerCardMessageId, chatId: "chat", operator: { openId: "user" },
    action: { value: { bridge: "feishu-codex-bridge", action: "steer_task", taskId: queued.taskId, scopeChatId: "chat" } },
  };
  await f.context.handleNormalizedCardAction({ ...event, operator: { openId: "other-user" } });
  await f.context.handleNormalizedCardAction({ ...event, messageId: "old-card" });
  await f.context.handleNormalizedCardAction({ ...event, chatId: "other-chat" });
  assert.deepEqual(f.deliveries, []);
  await f.context.handleNormalizedCardAction(event);
  await f.context.handleNormalizedCardAction(event);
  f.finish();
  await f.drain();
  assert.deepEqual(f.deliveries, ["先完成测试"]);
  assert.deepEqual(f.executions, ["原任务"]);
  assert.equal(queued.status, "steered");
  assert.ok(f.cards.some(card => /任务完成/.test(JSON.stringify(card))));
});

test("ordinary messages stay queued while /steer appends without adding another task", async t => {
  const f = fixture();
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  await f.message("下一项任务");
  await f.message("/steer 补充要求");
  assert.equal(f.context.runner.tasks.size, 2);
  assert.deepEqual(f.deliveries, ["补充要求"]);
  assert.deepEqual(f.executions, ["原任务"]);
  f.finish();
  await f.drain();
  assert.deepEqual(f.executions, ["原任务", "下一项任务"]);
});

test("known steering errors preserve queue execution and do not cancel the original task", async t => {
  const f = fixture({ deliveryError: new Error("turn already ended") });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  await f.message("补充要求");
  const queued = [...f.context.runner.tasks.values()].find(task => task.status === "pending");
  await f.message(`/steer ${queued.taskId}`);
  assert.ok(f.texts.some(text => /引导未提交/.test(text)));
  f.finish();
  await f.drain();
  assert.deepEqual(f.executions, ["原任务", "补充要求"]);
  assert.equal(queued.status, "success");
});

test("uncertain delivery stays suspended and can be cleared with /cancel", async t => {
  const f = fixture({ deliveryError: Object.assign(new Error("lost reply"), { steerOutcomeUnknown: true }) });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  await f.message("补充要求");
  const queued = [...f.context.runner.tasks.values()].find(task => task.status === "pending");
  await f.message(`/steer ${queued.taskId}`);
  f.finish();
  await f.drain();
  assert.deepEqual(f.executions, ["原任务"]);
  assert.equal(queued.status, "steer_unknown");
  await f.message(`/cancel ${queued.taskId}`);
  assert.equal(queued.status, "cancelled");
});

test("same-millisecond /new invalidates old steering and does not restore the old binding", async t => {
  const f = fixture();
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  await f.message("/new");
  await f.message("/steer 不能投到旧任务");
  assert.deepEqual(f.deliveries, []);
  assert.ok(f.texts.some(text => /没有可引导/.test(text)));
  f.finish();
  await f.drain();
  assert.equal(f.context.runner.sessions.size, 0);
  await f.message("重置后的新任务");
  await f.drain();
  assert.equal(f.context.runner.sessions.size, 1);
  assert.deepEqual(f.executions, ["原任务", "重置后的新任务"]);
});

test("Feishu receipt failure never changes a successful steering into a failed delivery", async t => {
  const f = fixture({ initialStatusUpdateFails: true });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  await f.message("补充要求");
  const queued = [...f.context.runner.tasks.values()].find(task => task.status === "pending");
  await f.message(`/steer ${queued.taskId}`);
  assert.equal(queued.status, "steered");
  assert.ok(f.texts.some(text => /已提交引导/.test(text)));
  assert.ok(!f.texts.some(text => /引导未提交/.test(text)));
});

test("/stop interrupts the active task while keeping old queued work paused", async t => {
  const f = fixture({ supportsInterrupt: true });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin(); await f.message("旧待办"); await f.message("/stop"); await f.drain();
  const tasks = [...f.context.runner.tasks.values()];
  assert.equal(tasks[0].status, "interrupted");
  assert.equal(tasks[1].status, "pending");
  assert.deepEqual(f.executions, ["原任务"]);
  await f.message("新要求"); await f.drain();
  assert.deepEqual(f.executions, ["原任务", "新要求"]);
  assert.equal(tasks[1].status, "pending");
});

test("the task stop card stays valid after opening a panel and rejects foreign chat or stale card", async t => {
  const f = fixture({ supportsInterrupt: true });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  const task = [...f.context.runner.tasks.values()][0];
  f.context.runner.setControlCardMessageId("chat", "panel");
  const event = { chatId: "chat", messageId: task.statusMessageId, operator: { openId: "user" },
    action: { value: { bridge: "feishu-codex-bridge", action: "stop_task", scopeChatId: "chat", taskId: task.taskId, generation: task.generation } } };
  await f.context.handleNormalizedCardAction({ ...event, chatId: "other" });
  await f.context.handleNormalizedCardAction({ ...event, messageId: "old-card" });
  assert.equal(task.status, "running");
  await f.context.handleNormalizedCardAction(event); await f.drain();
  assert.equal(task.status, "interrupted");
});

test("continuing a stopped task uses the same session without replaying old queued work", async t => {
  const f = fixture({ supportsInterrupt: true });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin(); await f.message("旧待办"); await f.message("/stop"); await f.drain();
  await f.message("/resume"); await f.drain();
  assert.equal(f.executions.length, 2);
  assert.ok(f.executions[1].includes("原任务"));
  assert.ok([...f.context.runner.tasks.values()].find(task => task.prompt === "旧待办").status === "pending");
  await f.message("/resume"); await f.drain();
  assert.equal(f.executions.length, 2);
});

test("continuation retains the original model and image resource even after settings change", async t => {
  const f = fixture({ supportsInterrupt: true });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.context.runner.create({ chatId: "chat", senderId: "user", messageId: "original-image" }, "repo", "分析图片", "default", "image-key");
  await new Promise(resolve => setImmediate(resolve));
  await f.message("/stop"); await f.drain();
  await f.message("/model grok-4.6");
  await f.message("/resume"); await f.drain();
  assert.deepEqual(f.downloads, [{ messageId: "original-image", key: "image-key" }, { messageId: "original-image", key: "image-key" }]);
  assert.equal(f.models[1].model, "gpt-6.1-sol");
  assert.equal(f.models[1].threadId, "thread-a");
});

test("ordinary continue messages still reach Codex when no task was stopped", async t => {
  const f = fixture();
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin(); await f.message("继续"); f.finish(); await f.drain();
  assert.deepEqual(f.executions, ["原任务", "继续"]);
});
