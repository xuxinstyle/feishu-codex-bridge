import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import * as core from "../bridge-core.mjs";
import { TaskSteering, buildSteeringCard } from "../task-steering.mjs";
import { APP_SERVER_SESSION_BACKEND, canResumeAppServerSession } from "../codex-app-server.mjs";

// Exercise the production handlers and runner without starting the real Feishu
// WebSocket, loading credentials, or writing the user's saved session bindings.
const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const helpers = source.slice(source.indexOf("function normalizeSessionName("), source.indexOf("const CARD_BRIDGE_ID"));
const cardParser = source.slice(source.indexOf("function parseCardActionValue("), source.indexOf("function cardButton("));
const runnerSource = source.slice(source.indexOf("class TaskRunner {"), source.indexOf("\nconst client = new Client("));
const handlers = source.slice(source.indexOf("async function handleMessage("), source.indexOf("\nconst dispatcher ="));

function fixture({ deliveryError, initialStatusUpdateFails = false } = {}) {
  const texts = [], cards = [], executions = [], deliveries = [];
  let serial = 0, finish;
  const messenger = {
    replyText: async (_id, text) => { texts.push(text); return `text-${++serial}`; },
    sendText: async (_id, text) => { texts.push(text); return `text-${++serial}`; },
    updateText: async (_id, text) => { texts.push(text); if (initialStatusUpdateFails && /已提交引导/.test(text)) throw new Error("Feishu update unavailable"); },
    replyCard: async (_id, card) => { cards.push(card); return `card-${++serial}`; },
    updateCard: async (_id, card) => { cards.push(card); },
  };
  const execute = async options => {
    executions.push(options.prompt);
    options.onThread("thread-a");
    options.onControl({ canCancel: false, steer: async prompt => {
      deliveries.push(prompt);
      if (deliveryError) throw deliveryError;
      return { turnId: "turn-a" };
    } });
    if (executions.length === 1) await new Promise(resolve => { finish = resolve; });
    options.onControl(null);
    return { threadId: "thread-a", output: "任务完成" };
  };
  const context = vm.createContext({
    ...core, TaskSteering, buildSteeringCard, APP_SERVER_SESSION_BACKEND, canResumeAppServerSession,
    messenger, path, process: { env: {} }, Date: class extends Date { static now() { return 100; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    config: { codex: { transport: "desktop", configOverrides: [] }, bridge: {
      defaultProjectPath: "repo", projectChoices: [], streamPushInterval: 30_000, generatedImageMaxCount: 0,
    } },
    readSessionState: () => ({}), writeSessionState: () => {}, log: () => {},
    existsSync: () => true, codexLauncher: {}, codexHome: "unused", generateTaskId: () => `task-${++serial}`,
    runDesktopTask: execute, truncateText: text => text, formatDuration: () => "0s",
    compactText: text => text, resolveProjectPath: value => value,
    CARD_BRIDGE_ID: "feishu-codex-bridge", pairingCode: null, allowedUserIds: new Set(["user"]),
  });
  vm.runInContext(`${helpers}\n${cardParser}\n${runnerSource}\nvar runner = new TaskRunner(messenger);\n${handlers}`, context);
  const message = (text, id = "message") => context.handleMessage({
    text, messageId: id, chatId: "chat", senderId: "user", chatType: "p2p",
  });
  const drain = () => Promise.all([...context.runner.sessionQueues.values()]);
  const begin = async () => {
    await message("原任务");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(executions, ["原任务"]);
  };
  return { context, texts, cards, executions, deliveries, message, drain, begin, finish: () => finish?.() };
}

test("a queued message can be steered through its own card after a panel refresh", async t => {
  const f = fixture();
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  await f.message("先完成测试", "follow-up");
  const queued = [...f.context.runner.tasks.values()].find(task => task.status === "pending");
  assert.equal(f.cards.at(-1).elements.at(-1).actions[0].text.content, "引导");
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
  assert.ok(f.texts.some(text => /任务完成/.test(text)));
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
