import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { EventDispatcher, normalizeCardAction } from "@larksuiteoapi/node-sdk";
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
const dispatcherSource = source.slice(source.indexOf("const dispatcher ="), source.indexOf("\nconst wsClient ="));

function fixture({ deliveryError, initialStatusUpdateFails = false, supportsInterrupt = false, onUpdateCard, discoverProjects, blockExecutions = 1, executionFailures = {}, steerDelivery } = {}) {
  const texts = [], cards = [], executions = [], deliveries = [], downloads = [], models = [];
  const updates = [], discoveries = [], saved = [], executionOptions = [], removedFiles = [];
  const runningExecutions = new Map();
  let serial = 0;
  const messenger = {
    replyText: async (_id, text) => { texts.push(text); return `text-${++serial}`; },
    sendText: async (_id, text) => { texts.push(text); return `text-${++serial}`; },
    updateText: async (_id, text) => { texts.push(text); if (initialStatusUpdateFails && /已提交引导/.test(text)) throw new Error("Feishu update unavailable"); },
    replyCard: async (_id, card) => { cards.push(card); return `card-${++serial}`; },
    sendCard: async (_id, card) => { cards.push(card); return `card-${++serial}`; },
    updateCard: async (id, card) => { cards.push(card); updates.push({ id, card }); if (initialStatusUpdateFails && /已提交引导/.test(JSON.stringify(card))) throw new Error("Feishu update unavailable"); await onUpdateCard?.(id, card); },
    downloadMessageResource: async (messageId, key) => { downloads.push({ messageId, key }); return { contentType: "image/png" }; },
  };
  const execute = async options => {
    let status = "completed";
    executions.push(options.prompt);
    const executionNumber = executions.length;
    executionOptions.push(options);
    models.push({ model: options.model, threadId: options.threadId });
    let finish;
    options.onThread("thread-a");
    const failure = executionFailures[executionNumber];
    if (failure) {
      if (failure.submissionState) options.onSubmission?.(failure.submissionState);
      throw failure.error || new Error("Injected backend failure");
    }
    options.onSubmission?.("submitting");
    options.onSubmission?.("submitted");
    options.onControl({ canCancel: supportsInterrupt, ...(supportsInterrupt ? { interrupt: async () => { status = "interrupted"; finish?.(); return { ok: true }; } } : {}), steer: async prompt => {
      deliveries.push(prompt);
      if (deliveryError) throw deliveryError;
      return steerDelivery ? await steerDelivery(prompt) : { turnId: "turn-a" };
    } });
    options.onTurnStarted?.({ threadId: "thread-a", turnId: `turn-${executionNumber}` });
    if (executionNumber <= blockExecutions) await new Promise(resolve => { finish = resolve; runningExecutions.set(executionNumber, resolve); });
    runningExecutions.delete(executionNumber);
    options.onControl(null);
    return { threadId: "thread-a", turn: { id: `turn-${executionNumber}`, status }, output: status === "interrupted" ? "任务已停止" : "任务完成" };
  };
  const context = vm.createContext({
    ...core, TaskSteering, buildSteeringCard, SessionTaskQueue, TaskInterruption, buildTaskCard, buildPanelCard, APP_SERVER_SESSION_BACKEND, canResumeAppServerSession,
    EventDispatcher, normalizeCardAction,
    messenger, path, process: { env: {} }, Date: class extends Date { static now() { return 100; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    config: { codex: { transport: "desktop", configOverrides: [], defaultModel: "gpt-6.1-sol", modelGroups: { codex: ["gpt-6.1-sol"], grok: ["grok-4.6"] }, reasoningEffortChoices: ["low", "high"] }, bridge: {
      defaultProjectPath: "repo", projectChoices: [{ alias: "repo", path: "repo" }, { alias: "other", path: "other" }], streamPushInterval: 30_000, generatedImageMaxCount: 0,
    } },
    readSessionState: () => ({}), writeSessionState: state => saved.push(state), log: () => {},
    refreshProjectChoices: async reason => { discoveries.push(reason); await discoverProjects?.(reason); },
    getHelpMessage: () => "命令帮助",
    existsSync: () => true, codexLauncher: {}, codexHome: "unused", generateTaskId: () => `task-${++serial}`,
    runDesktopTask: execute, truncateText: text => text, formatDuration: () => "0s",
    compactText: text => text, resolveProjectPath: value => value, projectDisplayName: value => path.basename(value),
    tmpdir: () => "test-temp", renameSync: () => {}, rmSync: file => removedFiles.push(file),
    CARD_BRIDGE_ID: "feishu-codex-bridge", pairingCode: null, allowedUserIds: new Set(["user"]),
  });
  vm.runInContext(`${helpers}\n${cardParser}\n${panelBuilder}\n${runnerSource}\nvar runner = new TaskRunner(messenger);\n${showPanel}\n${handlers}\n${dispatcherSource}\nvar testDispatcher = dispatcher;`, context);
  const message = (text, id = "message") => context.handleMessage({
    text, messageId: id, chatId: "chat", senderId: "user", chatType: "p2p",
  });
  const drain = () => Promise.all([...context.runner.sessionQueues.values()]);
  const begin = async () => {
    await message("原任务");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(executions, ["原任务"]);
  };
  const responses = [];
  const dispatch = async (value, { messageId = context.runner.controlCardMessageId("chat"), chatId = "chat", operatorId = "user", topLevel = false, eventId = `event-${++serial}` } = {}) => {
    const response = await context.testDispatcher.invoke({
      schema: "2.0", header: { event_type: "card.action.trigger", event_id: eventId },
      event: { ...(topLevel ? { open_message_id: messageId, open_chat_id: chatId } : { context: { open_message_id: messageId, open_chat_id: chatId } }),
        operator: { open_id: operatorId }, action: { tag: "button", value } },
    }, { needCheck: false });
    responses.push(response);
    if (response?.card?.type === "raw") cards.push(response.card.data);
    return response;
  };
  const flushActions = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const click = async (action, options = {}) => {
    const button = cards.at(-1)?.elements.flatMap(e => e.actions || []).find(b => b.value.action === action && (!options.match || options.match(b.value)));
    assert.ok(button, `Missing ${action} button in ${JSON.stringify(cards.at(-1))}`);
    const response = await dispatch(button.value, options);
    await flushActions();
    return response;
  };
  return { context, texts, cards, updates, responses, discoveries, saved, executions, executionOptions, removedFiles, deliveries, downloads, models, message, drain, begin, dispatch, click, flushActions,
    finish: number => { if (number) runningExecutions.get(number)?.(); else for (const finish of runningExecutions.values()) finish(); } };
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
  assert.deepEqual(f.executions, ["原任务", "继续"]);
  const original = [...f.context.runner.tasks.values()][0];
  const continued = f.context.runner.tasks.get(original.resumedAs);
  assert.equal(continued.prompt, "原任务");
  assert.equal(continued.executionPrompt, "继续");
  assert.equal(continued.resumeFromTaskId, original.taskId);
  assert.equal(continued.rootTaskId, original.taskId);
  assert.equal(f.executionOptions[1].expectedTurnId, original.turnId);
  assert.ok([...f.context.runner.tasks.values()].find(task => task.prompt === "旧待办").status === "pending");
  await f.message("/resume"); await f.drain();
  assert.equal(f.executions.length, 2);
});

test("continuation preserves the original model, effort and image context without attaching the image again", async t => {
  const f = fixture({ supportsInterrupt: true });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.message("/reasoning high");
  await f.context.runner.create({ chatId: "chat", senderId: "user", messageId: "original-image" }, "repo", "分析图片", "default", "image-key");
  await new Promise(resolve => setImmediate(resolve));
  await f.message("/stop"); await f.drain();
  const original = [...f.context.runner.tasks.values()][0];
  const originalImage = f.executionOptions[0].imagePath;
  assert.ok(originalImage);
  assert.equal(original.contextImagePath, originalImage);
  assert.ok(!f.removedFiles.includes(originalImage), "Interrupted tasks must retain their local context image until the continuation finishes");
  await f.message("/model grok-4.6");
  await f.message("/reasoning low");
  await f.message("/resume"); await f.drain();
  assert.deepEqual(f.downloads, [{ messageId: "original-image", key: "image-key" }]);
  assert.deepEqual(f.executions, ["分析图片", "继续"]);
  assert.equal(f.models[1].model, "gpt-6.1-sol");
  assert.equal(f.models[1].threadId, "thread-a");
  assert.equal(f.executionOptions[0].effort, "high");
  assert.equal(f.executionOptions[1].effort, "high");
  assert.equal(f.executionOptions[1].imagePath, undefined);
  assert.equal(f.executionOptions[1].expectedTurnId, original.turnId);
  const continued = f.context.runner.tasks.get(original.resumedAs);
  assert.equal(continued.prompt, "分析图片");
  assert.equal(continued.imagePath, null);
  assert.equal(continued.contextImagePath, null);
  assert.ok(f.removedFiles.includes(originalImage), "Successful completion should finally remove the retained temporary image");
});

test("repeated stop and resume keeps the original title and submits only a minimal continuation without replaying steering", async t => {
  const f = fixture({ supportsInterrupt: true, blockExecutions: 2 });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  const original = [...f.context.runner.tasks.values()][0];
  await f.message("/steer 最终只修改指定的输出文件");
  await f.message("旧待办");
  await f.message("/stop"); await f.drain();
  await f.message("/resume"); await f.flushActions();
  const second = f.context.runner.tasks.get(original.resumedAs);
  assert.equal(second.status, "running");
  assert.equal(second.prompt, original.prompt);
  assert.equal(second.executionPrompt, "继续");
  assert.equal(second.resumeFromTaskId, original.taskId);
  assert.equal(second.rootTaskId, original.taskId);
  assert.equal(f.executionOptions[1].expectedTurnId, original.turnId);
  assert.deepEqual(Array.from(f.executionOptions[1].continuationInputs), [{ id: `${original.taskId}:steer:1`, prompt: "最终只修改指定的输出文件" }]);
  await f.message("/stop"); await f.drain();
  await f.message("/resume"); await f.drain();
  const third = f.context.runner.tasks.get(second.resumedAs);
  assert.equal(third.status, "success");
  assert.equal(third.prompt, original.prompt);
  assert.equal(third.executionPrompt, "继续");
  assert.equal(third.resumeFromTaskId, second.taskId);
  assert.equal(third.rootTaskId, original.taskId);
  assert.equal(f.executionOptions[2].expectedTurnId, second.turnId);
  assert.deepEqual(Array.from(f.executionOptions[2].continuationInputs), [], "Accepted steering inputs must not be carried into the third turn again");
  assert.deepEqual(f.executions, ["原任务", "继续", "继续"]);
  assert.deepEqual(f.deliveries, ["最终只修改指定的输出文件"]);
  assert.deepEqual(f.executionOptions.map(options => options.threadId), [null, "thread-a", "thread-a"]);
  assert.equal([...f.context.runner.tasks.values()].find(task => task.prompt === "旧待办").status, "pending");
  const continuedCards = f.cards.filter(card => JSON.stringify(card).includes("原任务"));
  assert.ok(continuedCards.length > 0);
  assert.ok(continuedCards.every(card => !JSON.stringify(card).includes("请继续刚才被停止的任务")));
});

test("continuation waits for a steering receipt beaten by stop and snapshots the acknowledged requirement", async t => {
  let acknowledgeSteer;
  const steeringGate = new Promise(resolve => { acknowledgeSteer = resolve; });
  const f = fixture({ supportsInterrupt: true, steerDelivery: () => steeringGate });
  t.after(async () => { acknowledgeSteer({ turnId: "turn-a", clientUserMessageId: "late-input" }); f.finish(); await f.drain(); });
  await f.begin();
  const original = [...f.context.runner.tasks.values()][0];
  const steeringMessage = f.message("/steer 必须保留停止前刚刚提交的要求");
  await f.flushActions();
  assert.equal(original.steeringOperations.size, 1);
  await f.message("/stop"); await f.drain();
  assert.equal(original.status, "interrupted");
  let resumed = false;
  const continuation = f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "resume-during-steering" })
    .then(task => { resumed = true; return task; });
  await f.flushActions();
  assert.equal(resumed, false);
  assert.equal(f.context.runner.tasks.size, 1, "A continuation cannot be created before steering delivery settles");
  assert.deepEqual(f.executions, ["原任务"]);
  acknowledgeSteer({ turnId: "turn-a", clientUserMessageId: "late-input" });
  await steeringMessage;
  const next = await continuation; await f.drain();
  assert.equal(next.status, "success");
  assert.deepEqual(f.executions, ["原任务", "继续"]);
  assert.deepEqual(Array.from(f.executionOptions[1].continuationInputs), [{ id: "late-input", prompt: "必须保留停止前刚刚提交的要求" }]);
  assert.deepEqual(Array.from(next.resumeSteeringInputs), [], "Starting the admitted turn clears the carried-input backlog");
  assert.equal(original.steeringOperations.size, 0);
});

test("a stopped task waits for rejected steering, then blocks uncertain outcomes while allowing known rejection", async t => {
  for (const unknown of [false, true]) {
    let rejectSteer;
    const steeringGate = new Promise((_, reject) => { rejectSteer = reject; });
    const f = fixture({ supportsInterrupt: true, steerDelivery: () => steeringGate });
    t.after(async () => { rejectSteer(new Error("test cleanup")); f.finish(); await f.drain(); });
    await f.begin();
    const original = [...f.context.runner.tasks.values()][0];
    const steeringMessage = f.message("/steer 一条尚未拿到回执的补充要求");
    await f.flushActions();
    await f.message("/stop"); await f.drain();
    const continuation = f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "resume" })
      .then(task => ({ task }), error => ({ error }));
    await f.flushActions();
    assert.equal(f.context.runner.tasks.size, 1);
    rejectSteer(Object.assign(new Error(unknown ? "Steering outcome unknown" : "Steering rejected before delivery"), unknown ? { steerOutcomeUnknown: true } : {}));
    await steeringMessage;
    const result = await continuation;
    if (unknown) {
      assert.ok(result.error);
      assert.equal(original.steeringUncertain, true);
      assert.equal(f.context.runner.tasks.size, 1);
      assert.deepEqual(f.executions, ["原任务"]);
      await assert.rejects(f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "retry" }));
    } else {
      assert.ok(result.task);
      await f.drain();
      assert.equal(result.task.status, "success");
      assert.deepEqual(f.executions, ["原任务", "继续"]);
      assert.deepEqual(Array.from(f.executionOptions[1].continuationInputs), []);
      assert.ok(!original.steeringUncertain);
    }
  }
});

test("a task stopped before submission submits its original request once instead of a context-free continuation", async t => {
  let releasePreparation, updateCount = 0;
  const preparationGate = new Promise(resolve => { releasePreparation = resolve; });
  const f = fixture({ supportsInterrupt: true, blockExecutions: 0, onUpdateCard: () => ++updateCount === 1 ? preparationGate : undefined });
  t.after(async () => { releasePreparation(); await f.drain(); });
  await f.message("尚未提交的原任务"); await f.flushActions();
  const original = [...f.context.runner.tasks.values()][0];
  assert.equal(original.status, "running");
  assert.equal(f.executions.length, 0, "Preparation must still be blocked before any model request");
  await f.message("/stop");
  releasePreparation(); await f.drain();
  assert.equal(original.status, "interrupted");
  assert.equal(f.executions.length, 0);
  await f.message("/resume"); await f.drain();
  assert.deepEqual(f.executions, ["尚未提交的原任务"]);
  const continued = f.context.runner.tasks.get(original.resumedAs);
  assert.equal(continued.prompt, original.prompt);
  assert.equal(continued.executionPrompt, original.prompt);
  assert.ok(!f.executionOptions[0].expectedTurnId);
});

test("missing thread or uncertain submission without a turn is rejected without submitting another task", async t => {
  const f = fixture({ supportsInterrupt: true });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin(); await f.message("/stop"); await f.drain();
  const original = [...f.context.runner.tasks.values()][0];
  const snapshot = { threadId: original.threadId, turnId: original.turnId, resumeTurnId: original.resumeTurnId, submissionState: original.submissionState };
  for (const state of [
    { threadId: null, turnId: snapshot.turnId, submissionState: "submitted" },
    { threadId: snapshot.threadId, turnId: null, resumeTurnId: null, submissionState: "submitting" },
    { threadId: snapshot.threadId, turnId: null, resumeTurnId: null, submissionState: "submitted" },
  ]) {
    Object.assign(original, snapshot, state);
    await assert.rejects(f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "resume" }));
    assert.equal(f.context.runner.tasks.size, 1);
    assert.equal(original.resumedAs, undefined);
    assert.deepEqual(f.executions, ["原任务"]);
  }
});

test("continuing an original session is independent of a different currently selected running session", async t => {
  const f = fixture({ supportsInterrupt: true, blockExecutions: 2 });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  const original = [...f.context.runner.tasks.values()][0];
  await f.message("/stop"); await f.drain();
  await f.message("/use other-session");
  await f.message("另一会话独立任务"); await f.flushActions();
  const other = [...f.context.runner.tasks.values()].find(task => task.prompt === "另一会话独立任务");
  assert.equal(other.status, "running");
  const continued = await f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "resume-original" });
  await f.flushActions();
  assert.equal(continued.sessionName, original.sessionName);
  assert.equal(continued.status, "success");
  assert.equal(other.status, "running");
  assert.equal(f.context.runner.activeSessionName("chat", "repo"), "other-session");
  assert.deepEqual(f.executions, ["原任务", "另一会话独立任务", "继续"]);
  f.finish(); await f.drain();
});

test("continuation refuses an active original session even when a different idle session is selected", async t => {
  const f = fixture({ supportsInterrupt: true, blockExecutions: 2 });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin();
  const original = [...f.context.runner.tasks.values()][0];
  await f.message("/stop"); await f.drain();
  await f.message("原会话的新任务"); await f.flushActions();
  await f.message("/use idle-session");
  await assert.rejects(f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "resume-original" }));
  assert.equal(f.context.runner.tasks.size, 2);
  assert.deepEqual(f.executions, ["原任务", "原会话的新任务"]);
  f.finish(); await f.drain();
});

test("a continuation that clearly fails before submission can retry without losing its original image", async t => {
  const f = fixture({ supportsInterrupt: true, executionFailures: { 2: { error: new Error("Desktop closed before submission") } } });
  t.after(async () => { f.finish(); await f.drain(); });
  await f.context.runner.create({ chatId: "chat", senderId: "user", messageId: "image-input" }, "repo", "继续分析同一图片", "default", "image-key");
  await f.flushActions();
  const original = [...f.context.runner.tasks.values()][0];
  const imagePath = f.executionOptions[0].imagePath;
  await f.message("/stop"); await f.drain();
  const failed = await f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "first-resume" });
  await f.drain();
  assert.equal(failed.status, "failed");
  assert.equal(failed.submissionState, "not-started");
  assert.ok(!original.resumedAs, "An unsubmitted continuation must release the original card's retry lock");
  assert.equal(original.resumeOperation, null);
  assert.equal(original.contextImagePath, imagePath);
  assert.ok(!f.removedFiles.includes(imagePath), "The original image is still needed for a safe retry");
  const retry = await f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "retry-resume" });
  await f.drain();
  assert.equal(retry.status, "success");
  assert.equal(retry.resumeFromTaskId, original.taskId);
  assert.deepEqual(f.executions, ["继续分析同一图片", "继续", "继续"]);
  assert.deepEqual(f.downloads, [{ messageId: "image-input", key: "image-key" }]);
  assert.ok(f.executionOptions.slice(1).every(options => options.threadId === original.threadId && options.expectedTurnId === original.turnId && options.imagePath === undefined));
  assert.ok(f.removedFiles.includes(imagePath), "The image is removed only after a successful retry");
});

test("continuations with unknown submission outcomes never unlock the old task for an automatic retry", async t => {
  for (const submissionState of ["submitting", "submitted"]) {
    const f = fixture({ supportsInterrupt: true, executionFailures: { 2: { submissionState, error: new Error("Submission acknowledgement lost") } } });
    t.after(async () => { f.finish(); await f.drain(); });
    await f.begin(); await f.message("/stop"); await f.drain();
    const original = [...f.context.runner.tasks.values()][0];
    const failed = await f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "unknown-resume" });
    await f.drain();
    assert.equal(failed.status, "failed");
    assert.equal(failed.submissionState, submissionState);
    assert.equal(original.resumedAs, failed.taskId);
    await assert.rejects(f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "retry" }));
    assert.deepEqual(f.executions, ["原任务", "继续"]);
  }
});

test("resetting while an image continuation is pending releases its shared file after generation cancellation", async t => {
  let releaseStoppedReceipt;
  const stoppedReceiptGate = new Promise(resolve => { releaseStoppedReceipt = resolve; });
  const f = fixture({ supportsInterrupt: true, onUpdateCard: (_id, card) => card.header.title.content === "已停止" ? stoppedReceiptGate : undefined });
  t.after(async () => { releaseStoppedReceipt(); f.finish(); await f.drain(); });
  await f.context.runner.create({ chatId: "chat", senderId: "user", messageId: "image-input" }, "repo", "分析待继续的图片", "default", "image-key");
  await f.flushActions();
  const original = [...f.context.runner.tasks.values()][0];
  const imagePath = f.executionOptions[0].imagePath;
  await f.message("/stop"); await f.flushActions();
  assert.equal(original.status, "interrupted");
  assert.equal(original.contextImagePath, imagePath);
  const pending = await f.context.runner.resumeTask(original.taskId, { chatId: "chat", senderId: "user", messageId: "resume-before-reset" });
  assert.equal(pending.status, "pending", "The original final receipt must keep the session queue genuinely busy");
  assert.equal(pending.contextImagePath, imagePath);
  await f.message("/new");
  assert.ok(!f.removedFiles.includes(imagePath), "The pending continuation still owns the image before cancellation runs");
  releaseStoppedReceipt(); await f.drain();
  assert.equal(pending.status, "cancelled");
  assert.deepEqual(f.executions, ["分析待继续的图片"]);
  assert.equal(f.removedFiles.filter(file => file === imagePath).length, 1, "Generation cancellation must release the shared image exactly once");
  assert.equal(pending.contextImagePath, null);
  assert.equal(pending.imagePath, null);
});

test("ordinary continue messages still reach Codex when no task was stopped", async t => {
  const f = fixture();
  t.after(async () => { f.finish(); await f.drain(); });
  await f.begin(); await f.message("继续"); f.finish(); await f.drain();
  assert.deepEqual(f.executions, ["原任务", "继续"]);
});

test("real SDK callbacks navigate projects, sessions, settings and help using rendered buttons", async () => {
  const f = fixture();
  await f.message("/panel");
  await f.flushActions();
  const response = await f.click("show_projects");
  assert.equal(response?.card?.type, "raw", "The dispatcher must return the updated card in its callback acknowledgement");
  assert.ok(f.cards.at(-1).elements.flatMap(e => e.actions || []).some(b => b.value.action === "set_project"));
  await f.click("set_project", { match: value => value.targetProjectPath === "other" });
  assert.equal(f.context.runner.activeProjectPath("chat"), "other");
  assert.ok(JSON.stringify(f.cards.at(-1)).includes("other"));
  f.context.runner.setActiveSession("chat", "other", "已保存的会话");
  f.context.runner.setActiveSession("chat", "other", "default");
  await f.click("show_sessions");
  await f.click("use_session", { match: value => value.sessionName === "已保存的会话" });
  assert.equal(f.context.runner.activeSessionName("chat", "other"), "已保存的会话");
  assert.ok(JSON.stringify(f.cards.at(-1)).includes("已保存的会话"));
  await f.click("show_sessions");
  await f.click("new_session");
  assert.notEqual(f.context.runner.activeSessionName("chat", "other"), "已保存的会话");
  await f.click("show_settings");
  await f.click("show_models");
  await f.click("set_model", { match: value => value.model === "grok-4.6" });
  assert.equal(f.context.runner.effectiveModel("chat", "other"), "grok-4.6");
  await f.click("show_reasoning");
  await f.click("set_reasoning", { match: value => value.reasoningEffort === "high" });
  assert.equal(f.context.runner.effectiveReasoning("chat", "other"), "high");
  await f.click("show_home");
  await f.click("show_help");
  assert.ok(JSON.stringify(f.cards.at(-1)).includes("/stop"));
  await f.click("show_home");
  assert.ok(f.saved.some(state => state.activeProjects.some(([chat, project]) => chat === "chat" && project === "other")));
  assert.deepEqual(f.discoveries, ["panel"], "Navigation must use cached choices without project discovery");
});

test("SDK navigation callback returns cards without waiting for or issuing Feishu PATCH requests", async t => {
  let releasePatch;
  const patchGate = new Promise(resolve => { releasePatch = resolve; });
  const f = fixture({ onUpdateCard: () => patchGate });
  t.after(async () => { releasePatch(); await f.flushActions(); });
  await f.message("/panel");
  const scope = { bridge: "feishu-codex-bridge", scopeChatId: "chat", projectPath: "repo" };
  const acknowledge = value => Promise.race([
    f.dispatch({ ...scope, ...value }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Callback waited for PATCH instead of acknowledging")), 500); timer.unref(); }),
  ]);
  assert.equal((await acknowledge({ action: "show_projects" }))?.card?.type, "raw");
  await f.flushActions();
  assert.equal(f.updates.length, 0, "Callback navigation should avoid the additional PATCH round trip");
  assert.equal((await acknowledge({ action: "show_sessions" }))?.card?.type, "raw");
  releasePatch();
  await f.flushActions();
  assert.ok(f.cards.at(-1).elements.flatMap(e => e.actions || []).some(b => b.value.action === "new_session"));
});

test("a real SDK stop callback acknowledges even while the task receipt PATCH is stalled", async t => {
  let blockUpdates = false, releasePatch;
  const patchGate = new Promise(resolve => { releasePatch = resolve; });
  const f = fixture({ supportsInterrupt: true, onUpdateCard: () => blockUpdates ? patchGate : undefined });
  t.after(async () => { releasePatch(); f.finish(); await f.flushActions(); await f.drain(); });
  await f.begin();
  const task = [...f.context.runner.tasks.values()][0];
  const stop = f.cards.at(-1).elements.flatMap(e => e.actions || []).find(b => b.value.action === "stop_task");
  assert.ok(stop);
  blockUpdates = true;
  const acknowledgement = await Promise.race([
    f.dispatch(stop.value, { messageId: task.statusMessageId }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Stop acknowledgement waited for the task receipt PATCH")), 500); timer.unref(); }),
  ]);
  assert.equal(acknowledgement?.toast?.type, "info");
  releasePatch();
  await f.flushActions();
  await f.drain();
  assert.equal(task.status, "interrupted");
});

test("an older navigation card becomes usable again while foreign-chat clicks never change scope", async () => {
  const f = fixture();
  await f.message("/panel", "panel-one");
  const oldCard = f.context.runner.controlCardMessageId("chat");
  const action = f.cards.at(-1).elements.flatMap(e => e.actions || []).find(b => b.value.action === "show_projects").value;
  await f.message("/panel", "panel-two");
  assert.notEqual(f.context.runner.controlCardMessageId("chat"), oldCard);
  const response = await f.dispatch(action, { messageId: oldCard, topLevel: true });
  await f.flushActions();
  assert.equal(f.context.runner.controlCardMessageId("chat"), oldCard);
  assert.equal(response?.card?.type, "raw");
  const updatesBefore = f.updates.length;
  const foreignResponse = await f.dispatch({ ...action, action: "set_project", targetProjectPath: "other" }, { messageId: oldCard, chatId: "foreign-chat" });
  await f.flushActions();
  assert.equal(f.context.runner.activeProjectPath("chat"), "repo");
  assert.equal(f.updates.length, updatesBefore);
  assert.equal(foreignResponse?.toast?.type, "error");
});

test("background panel discovery cannot overwrite navigation and slow discovery never blocks sessions", async t => {
  let finishDiscovery;
  const discoveryGate = new Promise(resolve => { finishDiscovery = resolve; });
  const f = fixture({ discoverProjects: () => discoveryGate });
  t.after(async () => { finishDiscovery(); await f.flushActions(); });
  await f.message("/panel");
  await f.click("show_projects");
  await f.click("show_home");
  await f.click("show_sessions");
  assert.ok(f.cards.at(-1).elements.flatMap(e => e.actions || []).some(b => b.value.action === "new_session"));
  const updatesBefore = f.updates.length;
  finishDiscovery();
  await f.flushActions();
  assert.equal(f.updates.length, updatesBefore, "Background discovery must not redraw the user's current view");
  assert.deepEqual(f.discoveries, ["panel"]);
});

test("real SDK event redelivery creates a session only once without deduplicating different clicks", async () => {
  const f = fixture();
  await f.message("/panel");
  await f.click("show_sessions");
  const newSession = f.cards.at(-1).elements.flatMap(e => e.actions || []).find(b => b.value.action === "new_session");
  assert.ok(newSession);
  const first = await f.dispatch(newSession.value, { eventId: "same-delivery" });
  assert.equal(first?.card?.type, "raw");
  const session = f.context.runner.activeSessionName("chat", "repo");
  const count = f.context.runner.sessionStates("chat", "repo").length;
  const duplicate = await f.dispatch(newSession.value, { eventId: "same-delivery" });
  assert.ok(duplicate?.toast, "A duplicate callback must receive an acknowledgement");
  assert.equal(f.context.runner.activeSessionName("chat", "repo"), session);
  assert.equal(f.context.runner.sessionStates("chat", "repo").length, count);
  const nextClick = await f.dispatch(JSON.stringify(newSession.value), { eventId: "different-click" });
  assert.equal(nextClick?.card?.type, "raw");
  assert.notEqual(f.context.runner.activeSessionName("chat", "repo"), session);
  assert.equal(f.context.runner.sessionStates("chat", "repo").length, count + 1);
});

test("an explicit slow refresh acknowledges immediately and cannot overwrite a later navigation", async t => {
  let finishRefresh;
  const refreshGate = new Promise(resolve => { finishRefresh = resolve; });
  const f = fixture({ discoverProjects: reason => reason === "card:refresh" ? refreshGate : undefined });
  t.after(async () => { finishRefresh(); await f.flushActions(); });
  await f.message("/panel");
  await f.click("show_projects");
  const response = await f.click("refresh");
  assert.equal(response?.toast?.type, "info");
  assert.ok(f.discoveries.includes("card:refresh"));
  await f.click("show_home");
  const sessions = await f.click("show_sessions");
  assert.equal(sessions?.card?.type, "raw");
  const visibleCard = f.cards.at(-1), updatesBefore = f.updates.length;
  finishRefresh();
  await f.flushActions();
  assert.equal(f.updates.length, updatesBefore);
  assert.equal(f.cards.at(-1), visibleCard);
});

test("a mutation from an older panel returns a visible warning and does not switch project", async () => {
  const f = fixture();
  await f.message("/panel");
  await f.click("show_projects");
  const oldCard = f.context.runner.controlCardMessageId("chat");
  const choice = f.cards.at(-1).elements.flatMap(e => e.actions || []).find(b => b.value.action === "set_project" && b.value.targetProjectPath === "other");
  assert.ok(choice);
  await f.message("/panel", "new-panel");
  const current = f.context.runner.controlCardMessageId("chat");
  const response = await f.dispatch(choice.value, { messageId: oldCard });
  assert.equal(response?.toast?.type, "warning");
  assert.equal(f.context.runner.activeProjectPath("chat"), "repo");
  assert.equal(f.context.runner.controlCardMessageId("chat"), current);
});

test("returning home from an old queue reflects the project used by the next plain message", async () => {
  const f = fixture();
  await f.message("/panel");
  await f.click("show_queue");
  const home = f.cards.at(-1).elements.flatMap(e => e.actions || []).find(b => b.value.action === "show_home");
  assert.ok(home);
  await f.message("/project other");
  assert.equal(f.context.runner.activeProjectPath("chat"), "other");
  const response = await f.dispatch(home.value);
  assert.equal(response?.card?.type, "raw");
  const buttons = f.cards.at(-1).elements.flatMap(e => e.actions || []);
  assert.ok(buttons.length > 0);
  assert.ok(buttons.every(button => button.value.projectPath === "other"), "Home context must match the active project instead of retaining the queue's old project");
});

test("a refresh PATCH already in flight is repaired to the latest callback navigation when it lands late", async t => {
  let releaseFirstPatch;
  const firstPatchGate = new Promise(resolve => { releaseFirstPatch = resolve; });
  const applied = [];
  let patchCount = 0;
  const f = fixture({ onUpdateCard: async (_id, card) => {
    if (++patchCount === 1) await firstPatchGate;
    applied.push(card);
  } });
  t.after(async () => { releaseFirstPatch(); await f.flushActions(); });
  await f.message("/panel");
  await f.click("show_projects");
  assert.equal((await f.click("refresh"))?.toast?.type, "info");
  assert.equal(patchCount, 1, "The refresh must have issued its PATCH before the subsequent navigation");
  assert.equal(applied.length, 0, "The first PATCH must remain genuinely in flight");
  assert.equal((await f.click("show_home"))?.card?.type, "raw");
  assert.equal((await f.click("show_sessions"))?.card?.type, "raw");
  const sessions = f.cards.at(-1);
  assert.equal(sessions.header.title.content, "切换会话");
  assert.equal(applied.length, 0, "Navigation must acknowledge without waiting for the old PATCH");
  releaseFirstPatch();
  await f.flushActions();
  assert.equal(applied[0]?.header.title.content, "切换项目", "The delayed old PATCH must actually land to exercise the race");
  assert.equal(applied.at(-1)?.header.title.content, "切换会话", "A late refresh must be repaired to the latest callback-rendered page");
  assert.deepEqual(applied.at(-1), sessions);
});

test("a pending refresh on the same card does not delay stopping the running task", async t => {
  let finishRefresh;
  const refreshGate = new Promise(resolve => { finishRefresh = resolve; });
  const f = fixture({ supportsInterrupt: true, discoverProjects: reason => reason === "card:refresh" ? refreshGate : undefined });
  t.after(async () => { finishRefresh(); f.finish(); await f.flushActions(); await f.drain(); });
  await f.begin();
  const task = [...f.context.runner.tasks.values()][0];
  const stop = f.cards.at(-1).elements.flatMap(e => e.actions || []).find(b => b.value.action === "stop_task");
  assert.ok(stop);
  f.context.runner.setControlCardMessageId("chat", task.statusMessageId);
  const refresh = await f.dispatch({ bridge: "feishu-codex-bridge", scopeChatId: "chat", projectPath: "repo", action: "refresh", view: "projects" }, { messageId: task.statusMessageId });
  assert.equal(refresh?.toast?.type, "info");
  await f.flushActions();
  assert.ok(f.discoveries.includes("card:refresh"));
  const stopAck = await f.dispatch(stop.value, { messageId: task.statusMessageId });
  assert.equal(stopAck?.toast?.type, "info");
  await f.flushActions();
  assert.equal(task.status, "interrupted", "The stop side effect must reach Codex before project discovery is released");
  finishRefresh();
  await f.flushActions();
  await f.drain();
});
