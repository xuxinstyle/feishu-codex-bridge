import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test as nodeTest } from "node:test";
import vm from "node:vm";
import { EventDispatcher, normalizeCardAction } from "@larksuiteoapi/node-sdk";
import * as core from "../bridge-core.mjs";
import { APP_SERVER_SESSION_BACKEND, canResumeAppServerSession } from "../codex-app-server.mjs";
import { buildPanelCard, buildTaskCard } from "../feishu-cards.mjs";
import { HistoryBrowser } from "../history-browser.mjs";
import { TaskInterruption } from "../task-interruption.mjs";
import { SessionTaskQueue } from "../task-queue.mjs";
import { TaskSteering, buildSteeringCard } from "../task-steering.mjs";

const test = (name, run) => nodeTest(name, { timeout: 5_000 }, run);

// Run the actual handlers, message parser, dispatcher and TaskRunner in memory.
// Never import bridge.mjs: its module body loads credentials and starts Feishu.
const source = readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing production section: ${start} .. ${end}`);
  return source.slice(first, last);
}
const production = [
  section("function stripFeishuMentions(", "function expandHome("),
  section("function parseMessageEvent(", "function getHelpMessage("),
  section("function normalizeSessionName(", "const CARD_BRIDGE_ID"),
  section("function parseCardActionValue(", "function firstNonEmptyLine("),
  section("function buildControlCard(", "class TaskRunner {"),
  section("class TaskRunner {", "\nconst client = new Client("),
  "var runner = new TaskRunner(messenger);",
  section("async function showControlCard(", "\nif (pairingCode)"),
  section("async function handleMessage(", "\nconst dispatcher ="),
  section("const dispatcher =", "\nconst wsClient ="),
  `var audit = { runner, dispatcher, handleMessage, handleCardAction,
    historyChatOwners, executeCardActionSerially };`,
].join("\n");

const PROJECT = path.resolve("history-test-repo");
const OTHER_PROJECT = path.resolve("history-test-other-repo");
const CHAT = "private-chat";
const USER = "owner";
const THREAD = "external-thread";
const PRIVATE_TITLE = "PRIVATE_HISTORY_TITLE";
const PRIVATE_TEXT = "PrivateHistoryBody";
const clone = value => JSON.parse(JSON.stringify(value));
const textOf = card => JSON.stringify(card);
const buttons = card => (card?.elements || []).flatMap(element => element.actions || []);
const listData = (extra = {}) => ({ threads: [{ id: THREAD, title: PRIVATE_TITLE, cwd: PROJECT }], nextCursor: "list-cursor", ...extra });
const threadData = (extra = {}) => ({ thread: { id: THREAD, title: PRIVATE_TITLE, cwd: PROJECT },
  messages: [{ role: "user", text: "/run this is historical data" }, { role: "assistant", text: PRIVATE_TEXT }],
  nextCursor: "thread-cursor", ...extra });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Did not observe ${label}`);
}

function fixture(t, { allowed = [USER], onList, onRead, onPatch, discoverProjects,
  onInspect, onRuntime, seedPending = true, allowTasks = false, executeTask,
  transport = "desktop", exists = () => true } = {}) {
  const texts = [], replies = [], patches = [], completedPatches = [], reads = [], lists = [];
  const factories = [], forbidden = [], saved = [], logs = [], gates = [];
  const inspections = [], runtimeChecks = [], creations = [], executions = [];
  const pending = new Set(), panels = new Set(), rendered = new Map(), browsers = new Set();
  let serial = 0, activePatches = 0;
  const track = promise => {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const reader = {
    async list(params) { lists.push(clone(params)); return onList ? onList(params, lists.length) : listData(); },
    async read(params) {
      reads.push(clone(params));
      return onRead ? onRead(params, reads.length)
        : threadData({ thread: { id: params.threadId, title: PRIVATE_TITLE, cwd: params.projectPath } });
    },
    async inspect(params) {
      inspections.push(clone(params));
      return onInspect ? onInspect(params, inspections.length)
        : { id: params.threadId, title: PRIVATE_TITLE, cwd: params.projectPath, status: "notLoaded" };
    },
  };
  class ObservedHistoryBrowser extends HistoryBrowser {
    constructor(...args) { super(...args); browsers.add(this); }
    open(...args) { return track(super.open(...args)); }
    act(...args) { return track(super.act(...args)); }
    attachment(...args) { return track(super.attachment(...args)); }
  }
  const denyWrite = operation => (...args) => {
    forbidden.push({ operation, args });
    throw new Error(`History attempted ${operation}`);
  };
  const messenger = {
    async replyText(id, text) { texts.push({ id, text }); return `text-${++serial}`; },
    async replyCard(id, card) {
      const messageId = `panel-${++serial}`;
      panels.add(messageId);
      replies.push({ id, messageId, card });
      rendered.set(messageId, card);
      return messageId;
    },
    async updateCard(id, card) {
      patches.push({ id, card });
      activePatches++;
      try {
        await onPatch?.(id, card, patches.length);
        rendered.set(id, card);
        completedPatches.push({ id, card });
      } finally { activePatches--; }
    },
    sendText: denyWrite("messenger.sendText"), sendCard: denyWrite("messenger.sendCard"),
    updateText: denyWrite("messenger.updateText"), downloadMessageResource: denyWrite("downloadMessageResource"),
  };
  if (allowTasks) {
    messenger.sendText = (id, text) => messenger.replyText(id, text);
    messenger.sendCard = (id, card) => messenger.replyCard(id, card);
    messenger.updateText = async (id, text) => { texts.push({ id, text }); };
  }
  const execute = async options => {
    executions.push(options);
    if (executeTask) return executeTask(options, executions.length);
    assert.ok(options.threadId, "An attached task must have an explicit existing thread");
    await options.onThread(options.threadId);
    options.onSubmission?.("submitting");
    options.onSubmission?.("submitted");
    const turn = { id: `attached-turn-${executions.length}`, status: "completed" };
    options.onTurnStarted?.({ threadId: options.threadId, turnId: turn.id });
    return { threadId: options.threadId, turn, output: "附加会话内的测试回复" };
  };
  const scopeKey = `${CHAT}::${PROJECT}`;
  const sessionKey = `${scopeKey}::default`;
  const initialState = {
    sessions: [[sessionKey, { name: "default", threadId: "feishu-owned-thread", backend: APP_SERVER_SESSION_BACKEND,
      model: "gpt-6.1-sol", projectPath: PROJECT, turns: 4, updatedAt: "2026-10-22T00:00:00Z" }]],
    activeSessions: [[scopeKey, "default"]], activeProjects: [[CHAT, PROJECT]], knownSessions: [sessionKey],
    modelOverrides: [[scopeKey, "gpt-6.1-sol"]], reasoningOverrides: [[scopeKey, "high"]], pausedQueues: seedPending ? [sessionKey] : [],
  };
  const context = vm.createContext({
    ...core, path, EventDispatcher, normalizeCardAction, HistoryBrowser: ObservedHistoryBrowser,
    TaskSteering, buildSteeringCard, SessionTaskQueue, TaskInterruption, buildPanelCard, buildTaskCard,
    APP_SERVER_SESSION_BACKEND, canResumeAppServerSession, messenger,
    createHistoryReader: options => { factories.push(options); return reader; },
    inspectAttachmentRuntime: thread => {
      runtimeChecks.push(clone(thread));
      return track(Promise.resolve().then(() => onRuntime ? onRuntime(thread, runtimeChecks.length) : thread));
    },
    process: { env: {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    config: { codex: { transport, configOverrides: [], defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "high",
      modelGroups: { codex: ["gpt-6.1-sol"], grok: [] }, reasoningEffortChoices: ["low", "high"] }, bridge: {
      defaultProjectPath: PROJECT, projectChoices: [{ alias: "repo", path: PROJECT }, { alias: "other", path: OTHER_PROJECT }],
      generatedImageMaxCount: 0, streamPushInterval: 30_000,
    } },
    readSessionState: () => clone(initialState), writeSessionState: state => saved.push(clone(state)),
    log: (level, message, data) => logs.push({ level, message, data }),
    refreshProjectChoices: reason => Promise.resolve(discoverProjects?.(reason)),
    getHelpMessage: () => "命令帮助", existsSync: exists,
    codexLauncher: { command: "never-spawn-codex", argsPrefix: [], shell: false }, codexHome: "never-read-codex-home",
    generateTaskId: () => `task-${++serial}`, runDesktopTask: allowTasks ? execute : denyWrite("runDesktopTask"),
    runAppServerTask: denyWrite("runAppServerTask"), uploadAndSendFeishuImage: denyWrite("uploadAndSendFeishuImage"),
    truncateText: text => text, formatDuration: () => "0s", compactText: text => text,
    resolveProjectPath: value => path.resolve(value), projectDisplayName: value => path.basename(value),
    tmpdir: () => "unused", renameSync: denyWrite("renameSync"), rmSync: denyWrite("rmSync"),
    CARD_BRIDGE_ID: "feishu-codex-bridge", pairingCode: null, allowedUserIds: new Set(allowed),
    saveAllowedUserId: denyWrite("saveAllowedUserId"),
  });
  vm.runInContext(production, context, { filename: "bridge-history-production.vm.mjs" });
  const { audit } = context;
  // Observe attempted task creation even if it fails before reaching a backend.
  const realCreate = audit.runner.create.bind(audit.runner);
  audit.runner.create = async (...args) => {
    creations.push(args);
    if (allowTasks) return realCreate(...args);
    forbidden.push({ operation: "runner.create", args });
    return { taskId: "unexpected-task", sessionName: "default" };
  };
  const queued = { taskId: "task-existing", source: { chatId: CHAT, senderId: USER }, projectPath: PROJECT,
    sessionName: "default", status: "pending", prompt: "existing Feishu queued task", createdAt: 1, generation: "existing" };
  if (seedPending) {
    audit.runner.tasks.set(queued.taskId, queued);
    audit.runner.queue.enqueue(sessionKey, queued);
  }

  const inbound = (text, options = {}) => {
    const actor = { chatId: CHAT, senderId: USER, chatType: "p2p", ...options };
    const id = actor.messageId || `inbound-${++serial}`;
    return { schema: "2.0", header: { event_type: "im.message.receive_v1", event_id: `event-${id}` }, event: {
      sender: { sender_id: { open_id: actor.senderId } },
      message: { message_id: id, chat_id: actor.chatId, chat_type: actor.chatType,
        message_type: "text", content: JSON.stringify({ text }) },
    } };
  };
  const message = (text, options) => track(audit.dispatcher.invoke(inbound(text, options), { needCheck: false }));
  const currentPanel = (chatId = CHAT) => audit.runner.controlCardMessageId(chatId);
  const currentCard = (chatId = CHAT) => rendered.get(currentPanel(chatId));
  const valueFor = (action, card = currentCard()) => {
    const result = buttons(card).find(button => button.value?.action === action);
    assert.ok(result, `Missing ${action} in ${textOf(card)}`);
    return clone(result.value);
  };
  const rawAction = (value, options = {}) => {
    const actor = { chatId: CHAT, operatorId: USER, messageId: currentPanel(), ...options };
    return { operator: { open_id: actor.operatorId }, action: { tag: "button", value },
      ...(actor.topLevel ? { open_message_id: actor.messageId, open_chat_id: actor.chatId }
        : { context: { open_message_id: actor.messageId, open_chat_id: actor.chatId } }) };
  };
  const recordCallback = (response, messageId) => {
    // Feishu applies raw callback cards immediately, independently of PATCH.
    if (response?.card?.type === "raw") rendered.set(messageId, response.card.data);
    return response;
  };
  const card = (value, options) => {
    const messageId = options?.messageId || currentPanel(options?.chatId);
    return track(audit.handleCardAction(rawAction(value, options)).then(response => recordCallback(response, messageId)));
  };
  const sdkCard = (value, options) => {
    const messageId = options?.messageId || currentPanel(options?.chatId);
    return track(audit.dispatcher.invoke({ schema: "2.0",
      header: { event_type: "card.action.trigger", event_id: `card-event-${++serial}` }, event: rawAction(value, options),
    }, { needCheck: false }).then(response => recordCallback(response, messageId)));
  };
  const flush = async () => {
    // Browser calls are detached by the production ACK path. Follow their actual
    // promises, then put barriers on the same per-panel delivery queues.
    for (let round = 0; round < 8; round++) {
      await Promise.allSettled([...pending]);
      await Promise.all([...panels].map(id => audit.executeCardActionSerially(`${id}:attach`, async () => {})));
      await Promise.all([...audit.runner.sessionQueues.values()]);
      await Promise.all([...panels].map(id => audit.executeCardActionSerially(`${id}:patch`, async () => {})));
      await new Promise(resolve => setImmediate(resolve));
      if (!pending.size && !activePatches) return;
    }
    assert.fail("History handlers did not settle");
  };
  const gate = fallback => { const item = deferred(); gates.push({ ...item, fallback }); return item; };
  const snapshot = () => clone({
    // Panel IDs and message deduplication are allowed UI/transport bookkeeping.
    // All task/session/configuration state must remain byte-for-byte equivalent.
    sessions: [...audit.runner.sessions], activeSessions: [...audit.runner.activeSessions],
    activeProjects: [...audit.runner.activeProjects], knownSessions: [...audit.runner.knownSessions],
    modelOverrides: [...audit.runner.modelOverrides], reasoningOverrides: [...audit.runner.reasoningOverrides],
    tasks: [...audit.runner.tasks], activeTasks: [...audit.runner.activeTasks.keys()],
    sessionQueues: [...audit.runner.sessionQueues.keys()], sessionGenerations: [...audit.runner.sessionGenerations],
    sessionResetAt: [...audit.runner.sessionResetAt], paused: audit.runner.queue.snapshot(),
    queue: [...audit.runner.queue.entries].map(([key, entry]) => ({ key, active: entry.active,
      pending: entry.pending.map(item => ({ id: item.task.taskId, priority: item.priority })) })),
  });
  t.after(async () => {
    try {
      for (const item of gates) item.resolve(item.fallback);
      await flush();
      assert.deepEqual(forbidden.map(item => item.operation), [], "History must never create, execute or steer a task");
      const unexpected = logs.filter(entry => /message handler failed|card action handler failed|local history delivery failed/.test(entry.message));
      assert.deepEqual(unexpected, [], "The dispatcher must not silently swallow a handler/fixture failure");
    } finally {
      for (const browser of browsers) browser.close();
    }
  });
  return { context, audit, lists, reads, factories, texts, replies, patches, completedPatches, rendered, pending, saved,
    inspections, runtimeChecks, creations, executions,
    message, card, sdkCard, rawAction, currentPanel, currentCard, valueFor, flush, gate, snapshot,
    allowed: context.allowedUserIds, hasOwner: (chatId = CHAT) => audit.historyChatOwners.has(chatId),
    owner: (chatId = CHAT) => audit.historyChatOwners.get(chatId),
  };
}

test("the real inbound dispatcher registers private owners and creates the reader lazily", async t => {
  const f = fixture(t);
  await f.message("/help");
  assert.equal(f.owner(), USER);
  assert.equal(f.factories.length, 0);
  await f.message("/threads");
  assert.equal(f.factories.length, 1);
  assert.equal(f.lists.length, 1);
  assert.equal(f.lists[0].projectPath, PROJECT);
  assert.match(textOf(f.currentCard()), /PRIVATE_HISTORY_TITLE/);
  await f.message("/history");
  assert.equal(f.factories.length, 1, "The lazy reader should be reused");
});

for (const input of ["/threads", "/history", "/THREADS", "本地会话", "聊天记录", "/threads current", "/threads 当前"]) {
  test(`authorized private history entry: ${input}`, async t => {
    const f = fixture(t);
    const before = f.snapshot();
    await f.message(input);
    assert.equal(f.lists.length, 1);
    assert.equal(f.lists[0].allProjects, false);
    assert.match(textOf(f.currentCard()), /只读/);
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const input of ["/threads accidental task", "/history external-thread", "/THREADS ../other", "/threads\n/run do-not-run", "/history\tanything",
  "/threads all extra", "/threads all\n/run do-not-run", "/threads true", "/threads false", "/threads --all"]) {
  test(`history arguments are rejected without creating a task: ${JSON.stringify(input)}`, async t => {
    const f = fixture(t);
    const before = f.snapshot();
    await f.message(input);
    assert.equal(f.factories.length, 0);
    assert.equal(f.lists.length, 0);
    assert.match(f.texts.at(-1)?.text || "", /\/threads/);
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const allowed of [[], ["another-user"]]) {
  test(`history requires explicit allowlist membership (allowlist size ${allowed.length})`, async t => {
    const f = fixture(t, { allowed });
    await f.message("/threads");
    assert.equal(f.hasOwner(), false);
    assert.equal(f.factories.length, 0);
    assert.equal(f.patches.length, 0);
  });
}

for (const chatType of ["group", undefined]) {
  for (const remembered of [false, true]) {
    test(`history rejects ${chatType || "missing chatType"} even with remembered owner=${remembered}`, async t => {
      const f = fixture(t);
      if (remembered) await f.message("/help");
      await f.message("/threads", { chatType });
      assert.equal(f.hasOwner(), remembered);
      assert.equal(f.factories.length, 0);
      assert.equal(f.patches.length, 0);
      assert.match(f.texts.at(-1)?.text || "", /私聊/);
    });
  }
}

test("a card scope cannot bootstrap a private owner without a real inbound private message", async t => {
  const f = fixture(t);
  f.audit.runner.setControlCardMessageId(CHAT, "orphan-panel");
  const response = await f.card({ bridge: "feishu-codex-bridge", action: "show_history", scopeChatId: CHAT });
  await f.flush();
  assert.equal(response?.toast?.type, "error");
  assert.equal(f.hasOwner(), false);
  assert.equal(f.factories.length, 0);
});

test("a group panel cannot gain history access by changing its button scope", async t => {
  const f = fixture(t);
  await f.message("/panel", { chatId: "group-chat", chatType: "group" });
  await f.flush();
  const groupPanel = f.currentPanel("group-chat");
  const value = f.valueFor("show_history", f.currentCard("group-chat"));
  await f.sdkCard(value, { chatId: "group-chat", messageId: groupPanel });
  await f.sdkCard({ ...value, scopeChatId: CHAT }, { chatId: "group-chat", messageId: groupPanel });
  await f.flush();
  assert.equal(f.hasOwner("group-chat"), false);
  assert.equal(f.factories.length, 0);
});

test("history callbacks reject other actors, chats, bridges, missing context and stale panels", async t => {
  const f = fixture(t, { allowed: [USER, "second-owner"] });
  await f.message("/threads");
  const value = f.valueFor("show_history_thread");
  const before = f.snapshot();
  const patchCount = f.patches.length;
  const cases = [
    [value, { operatorId: "outsider" }], [value, { operatorId: "second-owner" }],
    [value, { chatId: "foreign-chat" }], [{ ...value, scopeChatId: "foreign-chat" }, { chatId: "foreign-chat" }],
    [{ ...value, bridge: "another-bridge" }, {}], [{ ...value, scopeChatId: "foreign-chat" }, {}],
    [value, { chatId: undefined }], [value, { messageId: undefined }], [value, { messageId: "old-panel" }],
  ];
  for (const [payload, options] of cases) {
    const response = await f.card(payload, options);
    assert.ok(response == null || ["error", "warning"].includes(response?.toast?.type),
      `Expected rejection for ${JSON.stringify(options)}`);
  }
  await f.flush();
  assert.equal(f.reads.length, 0);
  assert.equal(f.patches.length, patchCount);
  assert.equal(f.owner(), USER);
  assert.deepEqual(f.snapshot(), before);
});

test("SDK callbacks accept both context forms and the exact rendered history actions", async t => {
  const f = fixture(t);
  await f.message("/panel");
  await f.flush();
  await f.sdkCard(f.valueFor("show_history"), { topLevel: true });
  await f.flush();
  assert.equal(f.lists.length, 1);
  await f.sdkCard(f.valueFor("show_history_thread"));
  await f.flush();
  assert.equal(f.reads.length, 1);
  assert.ok(textOf(f.currentCard()).includes(PRIVATE_TEXT));
});

test("history titles remain bounded plain-text labels and historical commands are display data", async t => {
  const unsafeTitle = "<at id=all>**[untrusted](https://example.invalid)**</at>".repeat(4);
  const f = fixture(t, { onList: () => listData({ threads: [{ id: THREAD, title: unsafeTitle }] }),
    onRead: () => threadData({ thread: { id: THREAD, title: unsafeTitle, cwd: PROJECT }, messages: [
      { role: "user", text: "/run DO_NOT_EXECUTE\n<at id=all>notify</at>\n[link](https://example.invalid)" },
      { role: "assistant", text: "```\n/resume\n```\n" + "中文😀".repeat(1000) },
    ] }) });
  const before = f.snapshot();
  await f.message("/threads");
  const label = buttons(f.currentCard()).find(button => button.value.action === "show_history_thread").text;
  assert.equal(label.tag, "plain_text");
  assert.ok(label.content.length <= 70);
  await f.card(f.valueFor("show_history_thread"));
  await f.flush();
  const title = f.currentCard().elements.find(element => element.tag === "note" && element.elements[0].content === unsafeTitle);
  assert.equal(title?.elements[0].tag, "plain_text");
  const body = f.currentCard().elements.find(element => element.tag === "markdown").content;
  assert.ok(body.includes("/run DO"), "Historical command text remains visible as data");
  assert.ok(!body.includes("<at id=all>"), "Historical mentions are escaped");
  assert.ok(buttons(f.currentCard()).every(button => ["show_history_text", "show_history_batch", "show_history_refresh", "show_history_scope", "show_history_list", "show_home", "attach_history"].includes(button.value.action)));
  const attach = buttons(f.currentCard()).find(button => button.value.action === "attach_history");
  assert.equal(attach?.text.content, "附加到飞书");
  assert.ok(attach.confirm?.title?.content && attach.confirm?.text?.content, "Attaching requires an explicit confirmation");
  assert.equal(f.inspections.length, 0, "Displaying the attach button must not inspect or bind a thread");
  assert.deepEqual(f.snapshot(), before);
});

for (const throughSdk of [false, true]) {
  test(`${throughSdk ? "the real SDK dispatcher" : "the card handler"} returns a history ACK before a slow reader resolves`, async t => {
    let block;
    const f = fixture(t, { onRead: () => block.promise });
    block = f.gate(threadData());
    await f.message("/threads");
    const patchCount = f.patches.length;
    let acknowledged = false;
    const operation = (throughSdk ? f.sdkCard : f.card)(f.valueFor("show_history_thread"))
      .then(response => { acknowledged = true; return response; });
    await until(() => f.reads.length === 1, "the still-blocked thread query");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acknowledged, true, "The callback must not await the history query or PATCH");
    const response = await operation;
    assert.equal(response?.toast?.type, "info", "The actual callback response must preserve the handler's ACK");
    assert.equal(f.patches.length, patchCount, "The reader is still blocked when the ACK is returned");
    block.resolve(threadData());
    await f.flush();
  });
}

test("history-like unknown action names never reach the reader", async t => {
  const f = fixture(t);
  await f.message("/threads");
  const value = f.valueFor("show_history_thread");
  for (const action of ["show_history_untrusted", "show_history_thread_suffix", "show_history_thread/../resume_task"]) {
    await f.card({ ...value, action });
  }
  await f.flush();
  assert.equal(f.lists.length, 1);
  assert.equal(f.reads.length, 0);
});

test("history tokens cannot be replayed on another panel, project or unlisted thread", async t => {
  const f = fixture(t);
  await f.message("/threads");
  const original = f.valueFor("show_history_thread");
  await f.card({ ...original, threadId: "unlisted-thread" });
  await f.flush();
  assert.equal(f.reads.length, 0);
  await f.message("/threads");
  await f.card(original);
  await f.flush();
  assert.equal(f.reads.length, 0);
  const current = f.valueFor("show_history", f.currentCard());
  await f.card(current);
  await f.flush();
  const listValue = f.valueFor("show_history_thread");
  f.audit.runner.setActiveProject(CHAT, OTHER_PROJECT);
  await f.card(listValue);
  await f.flush();
  assert.equal(f.reads.length, 0);
});

test("cursor and thread pagination come from server memory rather than callback fields", async t => {
  const f = fixture(t);
  await f.message("/threads");
  await f.card({ ...f.valueFor("show_history_batch"), cursor: "attacker-cursor", projectPath: OTHER_PROJECT });
  await f.flush();
  assert.equal(f.lists.at(-1).cursor, "list-cursor");
  assert.equal(f.lists.at(-1).projectPath, PROJECT);
  await f.card(f.valueFor("show_history_thread"));
  await f.flush();
  await f.card({ ...f.valueFor("show_history_batch"), cursor: "attacker-thread-cursor", threadId: "another-thread" });
  await f.flush();
  assert.equal(f.reads.at(-1).cursor, "thread-cursor");
  assert.equal(f.reads.at(-1).threadId, THREAD);
  assert.equal(f.reads.at(-1).projectPath, PROJECT);
});

test("browsing, text pages, refresh and navigation preserve task/session/configuration state", async t => {
  const f = fixture(t, { onRead: () => threadData({ messages: [{ role: "assistant", text: PRIVATE_TEXT.repeat(400) }] }) });
  const before = f.snapshot();
  await f.message("/threads");
  for (const action of ["show_history_thread", "show_history_text", "show_history_batch", "show_history_refresh", "show_history_list", "show_home"]) {
    await f.card(f.valueFor(action));
    await f.flush();
    assert.deepEqual(f.snapshot(), before, `${action} must not mutate execution state`);
  }
  assert.ok(f.saved.length > 0, "Inspect real in-memory persistence, including message deduplication");
  for (const state of f.saved) assert.ok(!state.sessions.some(([, binding]) => binding.threadId === THREAD));
});

for (const entry of ["message", "card"]) {
  test(`revoking access during a ${entry} history read suppresses the result`, async t => {
    let block;
    const f = fixture(t, { onList: () => block ? block.promise : listData() });
    if (entry === "card") await f.message("/threads");
    block = f.gate(listData());
    const count = f.lists.length;
    const patches = f.patches.length;
    const operation = entry === "message" ? f.message("/threads") : f.card(f.valueFor("show_history_refresh"));
    await until(() => f.lists.length > count, "blocked list read");
    f.allowed.clear();
    block.resolve(listData());
    await operation;
    await f.flush();
    assert.equal(f.patches.length, patches, "No content may be patched after revocation");
  });
}

test("revoking access while a thread read is pending suppresses its private text", async t => {
  let block;
  const f = fixture(t, { onRead: () => block.promise });
  block = f.gate(threadData());
  await f.message("/threads");
  const patchCount = f.patches.length;
  await f.card(f.valueFor("show_history_thread"));
  await until(() => f.reads.length === 1, "thread read");
  f.allowed.delete(USER);
  block.resolve(threadData());
  await f.flush();
  assert.equal(f.patches.length, patchCount);
  assert.ok(!f.patches.some(patch => textOf(patch.card).includes(PRIVATE_TEXT)));
});

test("delivery rechecks authorization after waiting in the actual per-panel PATCH queue", async t => {
  const f = fixture(t);
  await f.message("/threads");
  const gate = f.gate();
  const entered = deferred();
  const blocker = f.audit.executeCardActionSerially(`${f.currentPanel()}:patch`, async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  const patchCount = f.patches.length;
  await f.card(f.valueFor("show_history_thread"));
  await until(() => f.reads.length === 1 && f.pending.size === 0, "completed read waiting for PATCH queue");
  f.allowed.clear();
  gate.resolve();
  await blocker;
  await f.flush();
  assert.equal(f.patches.length, patchCount, "Authorization must be checked at dequeue time");
});

test("a new real private owner invalidates an earlier owner's pending history delivery", async t => {
  let block;
  const f = fixture(t, { allowed: [USER, "new-owner"], onRead: () => block.promise });
  block = f.gate(threadData());
  await f.message("/threads");
  const patchCount = f.patches.length;
  await f.card(f.valueFor("show_history_thread"));
  await f.message("/help", { senderId: "new-owner" });
  assert.equal(f.owner(), "new-owner");
  block.resolve(threadData());
  await f.flush();
  assert.equal(f.patches.length, patchCount);
});

test("a late first /threads read cannot overwrite newer navigation", async t => {
  let block;
  const f = fixture(t, { onList: () => block.promise });
  block = f.gate(listData());
  const operation = f.message("/threads");
  await until(() => f.lists.length === 1, "initial list read");
  await f.card(f.valueFor("show_projects"));
  const navigated = textOf(f.currentCard());
  block.resolve(listData());
  await operation;
  await f.flush();
  assert.equal(textOf(f.currentCard()), navigated);
  assert.ok(!textOf(f.currentCard()).includes(PRIVATE_TITLE));
});

test("a late thread read cannot overwrite returning to the home panel", async t => {
  let block;
  const f = fixture(t, { onRead: () => block.promise });
  block = f.gate(threadData());
  await f.message("/threads");
  await f.card(f.valueFor("show_history_thread"));
  await f.card(f.valueFor("show_home"));
  const navigated = textOf(f.currentCard());
  block.resolve(threadData());
  await f.flush();
  assert.equal(textOf(f.currentCard()), navigated);
  assert.ok(!textOf(f.currentCard()).includes(PRIVATE_TEXT));
});

test("an in-flight first history PATCH restores newer callback navigation when it lands late", async t => {
  let gate;
  const entered = deferred();
  const f = fixture(t, { onPatch: async (_id, card) => {
    if (textOf(card).includes(PRIVATE_TITLE)) { entered.resolve(); await gate.promise; }
  } });
  gate = f.gate();
  const operation = f.message("/threads");
  await entered.promise;
  const navigation = await f.card(f.valueFor("show_projects"));
  assert.equal(navigation?.card?.type, "raw", "Navigation ACK must not wait for an in-flight HTTP request");
  assert.ok(!textOf(f.currentCard()).includes(PRIVATE_TITLE));
  assert.equal(f.patches.length, 1, "The old HTTP request is still blocked");
  gate.resolve();
  await operation;
  await f.flush();
  assert.ok(!textOf(f.currentCard()).includes(PRIVATE_TITLE));
  assert.ok(f.valueFor("show_home"));
});

test("a newer history read wins even when the older read completes last", async t => {
  let old;
  const f = fixture(t, { onList: (_params, count) => count === 2 ? old.promise
    : listData({ threads: [{ id: THREAD, title: count >= 3 ? "NEWEST_RESULT" : PRIVATE_TITLE }] }) });
  old = f.gate(listData());
  await f.message("/threads");
  const refresh = f.valueFor("show_history_refresh");
  await f.card(refresh);
  await f.card(refresh);
  await until(() => textOf(f.currentCard()).includes("NEWEST_RESULT"), "newer history result");
  old.resolve(listData());
  await f.flush();
  assert.match(textOf(f.currentCard()), /NEWEST_RESULT/);
});

test("switching the active project while reading prevents delivery for the old project", async t => {
  let block;
  const f = fixture(t, { onRead: () => block.promise });
  block = f.gate(threadData());
  await f.message("/threads");
  const patchCount = f.patches.length;
  await f.card(f.valueFor("show_history_thread"));
  f.audit.runner.setActiveProject(CHAT, OTHER_PROJECT);
  block.resolve(threadData());
  await f.flush();
  assert.equal(f.patches.length, patchCount);
});

test("opening a new panel invalidates a pending read belonging to the old panel", async t => {
  let block;
  const f = fixture(t, { onList: (_params, count) => count === 1 ? block.promise : listData() });
  block = f.gate(listData());
  const oldRead = f.message("/threads");
  await until(() => f.lists.length === 1, "old panel read");
  const oldPanel = f.currentPanel();
  await f.message("/threads");
  const newPanel = f.currentPanel();
  assert.notEqual(newPanel, oldPanel);
  block.resolve(listData());
  await oldRead;
  await f.flush();
  assert.equal(f.currentPanel(), newPanel);
  assert.equal(f.patches.filter(patch => patch.id === oldPanel).length, 0);
});

test("reader failures show a safe retry notice without creating a task or disclosing error text", async t => {
  const f = fixture(t, { onRead: () => { throw new Error("PRIVATE_ERROR_DETAILS"); } });
  await f.message("/threads");
  const before = f.snapshot();
  await f.card(f.valueFor("show_history_thread"));
  await f.flush();
  assert.match(textOf(f.currentCard()), /读取未完成/);
  assert.ok(!textOf(f.currentCard()).includes("PRIVATE_ERROR_DETAILS"));
  assert.deepEqual(f.snapshot(), before);
});

for (const operatorId of ["outsider", "second-owner"]) {
  test(`a rejected callback from ${operatorId} cannot invalidate the private owner's pending history read`, async t => {
    let block;
    const f = fixture(t, { allowed: [USER, "second-owner"], onList: () => block.promise });
    block = f.gate(listData());
    const operation = f.message("/threads");
    await until(() => f.lists.length === 1, "authorized pending read");
    const denied = await f.card(f.valueFor("show_history"), { operatorId });
    assert.equal(denied?.toast?.type, "error");
    block.resolve(listData());
    await operation;
    await f.flush();
    assert.match(textOf(f.currentCard()), /PRIVATE_HISTORY_TITLE/, "Denied callbacks must have no effect on authorized navigation revisions");
  });
}

for (const input of ["/threads all", "/threads 全部", "/threads 所有", "/history all", "/THREADS ALL"]) {
  test(`global history is an explicit read-only entry: ${input}`, async t => {
    const f = fixture(t);
    const before = f.snapshot();
    await f.message(input);
    assert.equal(f.lists.length, 1);
    assert.equal(f.lists[0].allProjects, true);
    assert.equal(f.lists[0].projectPath, PROJECT, "The active project remains the panel anchor");
    assert.match(textOf(f.currentCard()), /全部项目/);
    assert.equal(f.valueFor("show_history_scope").allProjects, false);
    assert.deepEqual(f.snapshot(), before);
  });
}

test("rendered scope buttons explicitly toggle true and false and reset list cursors", async t => {
  const f = fixture(t);
  const before = f.snapshot();
  await f.message("/threads");
  assert.equal(f.valueFor("show_history_scope").allProjects, true);
  await f.sdkCard(f.valueFor("show_history_scope"));
  await f.flush();
  assert.equal(f.lists.at(-1).allProjects, true);
  await f.sdkCard(f.valueFor("show_history_batch"));
  await f.flush();
  assert.equal(f.lists.at(-1).cursor, "list-cursor");
  assert.equal(f.lists.at(-1).allProjects, true);
  assert.equal(f.valueFor("show_history_scope").allProjects, false);
  await f.sdkCard(f.valueFor("show_history_scope"));
  await f.flush();
  assert.equal(f.lists.at(-1).allProjects, false);
  assert.equal(f.lists.at(-1).cursor ?? null, null);
  assert.equal(f.valueFor("show_history_scope").allProjects, true);
  assert.deepEqual(f.snapshot(), before);
});

test("global selection ignores callback cwd fields and reads the thread's server-snapshot project", async t => {
  const f = fixture(t, { onList: () => listData({ threads: [{ id: THREAD, title: PRIVATE_TITLE, cwd: OTHER_PROJECT }] }) });
  const before = f.snapshot();
  await f.message("/threads all");
  const value = f.valueFor("show_history_thread");
  assert.equal(value.projectPath, PROJECT);
  await f.sdkCard({ ...value, cwd: PROJECT, projectPath: "Z:\\untrusted", targetProjectPath: PROJECT,
    threadProjectPath: PROJECT, allProjects: false });
  await f.flush();
  assert.deepEqual(f.reads, [{ projectPath: OTHER_PROJECT, threadId: THREAD }]);
  assert.ok(textOf(f.currentCard()).includes(PRIVATE_TEXT));
  assert.ok(textOf(f.currentCard()).includes(path.basename(OTHER_PROJECT)));
  assert.ok(buttons(f.currentCard()).every(button => button.value.projectPath === PROJECT));
  assert.deepEqual(f.snapshot(), before);
  for (const state of f.saved) assert.ok(!state.sessions.some(([, binding]) => binding.threadId === THREAD));
});

for (const allProjects of [undefined, "true", "false", 0, 1, null, {}, []]) {
  test(`scope actions reject missing or non-boolean allProjects=${JSON.stringify(allProjects)}`, async t => {
    const f = fixture(t);
    const before = f.snapshot();
    await f.message("/threads");
    const value = { ...f.valueFor("show_history_scope"), allProjects };
    if (allProjects === undefined) delete value.allProjects;
    const response = await f.sdkCard(value);
    await f.flush();
    assert.equal(response?.toast?.type, "info", "Validation can finish after the immediate ACK");
    assert.equal(f.lists.length, 1);
    assert.equal(f.reads.length, 0);
    assert.match(textOf(f.currentCard()), /读取未完成/);
    assert.deepEqual(f.snapshot(), before);
  });
}

test("a scope switch cannot bootstrap a global list without a valid panel token", async t => {
  const f = fixture(t);
  await f.message("/panel");
  await f.flush();
  const before = f.snapshot();
  await f.sdkCard({ ...f.valueFor("show_history"), action: "show_history_scope", allProjects: true });
  await f.flush();
  assert.equal(f.lists.length, 0);
  assert.equal(f.reads.length, 0);
  assert.match(textOf(f.currentCard()), /读取未完成/);
  assert.deepEqual(f.snapshot(), before);
});

test("a global thread without a stored source cwd never reaches the reader", async t => {
  const f = fixture(t, { onList: () => listData({ threads: [{ id: THREAD, title: PRIVATE_TITLE }] }) });
  const before = f.snapshot();
  await f.message("/threads all");
  await f.sdkCard({ ...f.valueFor("show_history_thread"), cwd: OTHER_PROJECT });
  await f.flush();
  assert.equal(f.reads.length, 0);
  assert.match(textOf(f.currentCard()), /读取未完成/);
  assert.deepEqual(f.snapshot(), before);
});

test("global older/refresh and return-list preserve source cwd, global mode and original list page", async t => {
  const f = fixture(t, { onList: params => listData({
    threads: [{ id: THREAD, title: params.cursor ? "GLOBAL_SECOND_PAGE" : "GLOBAL_FIRST_PAGE", cwd: OTHER_PROJECT }],
    nextCursor: params.cursor ? null : "list-cursor",
  }) });
  const before = f.snapshot();
  await f.message("/threads all");
  await f.sdkCard(f.valueFor("show_history_batch"));
  await f.flush();
  assert.deepEqual(f.lists.at(-1), { projectPath: PROJECT, allProjects: true, cursor: "list-cursor" });
  await f.sdkCard(f.valueFor("show_history_thread"));
  await f.flush();
  await f.sdkCard({ ...f.valueFor("show_history_batch"), cwd: PROJECT, threadId: "injected-thread", cursor: "injected-cursor" });
  await f.flush();
  assert.deepEqual(f.reads.at(-1), { projectPath: OTHER_PROJECT, threadId: THREAD, cursor: "thread-cursor" });
  await f.sdkCard({ ...f.valueFor("show_history_refresh"), projectPath: OTHER_PROJECT, cwd: PROJECT });
  await f.flush();
  assert.deepEqual(f.reads.at(-1), { projectPath: OTHER_PROJECT, threadId: THREAD });
  const listCalls = f.lists.length;
  await f.sdkCard(f.valueFor("show_history_list"));
  await f.flush();
  assert.equal(f.lists.length, listCalls, "Returning restores the original list snapshot without an extra query");
  assert.match(textOf(f.currentCard()), /GLOBAL_SECOND_PAGE/);
  assert.match(textOf(f.currentCard()), /全部项目/);
  assert.equal(f.valueFor("show_history_scope").allProjects, false);
  assert.ok(buttons(f.currentCard()).some(button => button.value.direction === "newer"));
  assert.ok(!buttons(f.currentCard()).some(button => button.value.direction === "older"));
  await f.sdkCard(f.valueFor("show_history_thread"));
  await f.flush();
  assert.equal(f.reads.at(-1).projectPath, OTHER_PROJECT);
  assert.deepEqual(f.snapshot(), before);
});

test("refreshing a global list retains global mode even when callback fields request current mode", async t => {
  const f = fixture(t);
  const before = f.snapshot();
  await f.message("/threads all");
  await f.sdkCard({ ...f.valueFor("show_history_refresh"), allProjects: false, projectPath: OTHER_PROJECT });
  await f.flush();
  assert.deepEqual(f.lists.at(-1), { projectPath: PROJECT, allProjects: true });
  assert.deepEqual(f.snapshot(), before);
});

test("the Feishu session-selection page opens Codex history without selecting or binding a thread", async t => {
  const f = fixture(t);
  const before = f.snapshot();
  await f.message("/panel");
  await f.flush();
  await f.sdkCard(f.valueFor("show_sessions"));
  await f.flush();
  const entry = buttons(f.currentCard()).find(button => button.value.action === "show_history");
  assert.match(entry?.text.content || "", /Codex.*会话/);
  await f.sdkCard({ ...entry.value, allProjects: true, cwd: OTHER_PROJECT });
  await f.flush();
  assert.deepEqual(f.lists.at(-1), { projectPath: PROJECT, allProjects: false });
  assert.deepEqual(f.snapshot(), before);
});

for (const chatType of ["group", undefined]) {
  test(`global commands reject ${chatType || "missing chatType"} without reading or changing execution state`, async t => {
    const f = fixture(t);
    await f.message("/help");
    const before = f.snapshot();
    await f.message("/threads all", { chatType });
    assert.equal(f.lists.length, 0);
    assert.equal(f.reads.length, 0);
    assert.match(f.texts.at(-1)?.text || "", /私聊/);
    assert.deepEqual(f.snapshot(), before);
  });
}

test("new global scope/list/thread actions reject other actors, groups and copied panels", async t => {
  const f = fixture(t, { allowed: [USER, "second-owner"] });
  await f.message("/threads all");
  const values = ["show_history_scope", "show_history_list", "show_history_thread"].map(action => f.valueFor(action));
  const panelId = f.currentPanel();
  const before = f.snapshot();
  const count = f.patches.length;
  for (const value of values) {
    for (const options of [{ operatorId: "second-owner" }, { operatorId: "outsider" }, { chatId: "group-chat" }]) {
      const response = await f.sdkCard(value, { messageId: panelId, ...options });
      assert.equal(response?.toast?.type, "error");
    }
    const denied = await f.sdkCard({ ...value, scopeChatId: "group-chat" }, { chatId: "group-chat", messageId: panelId });
    assert.equal(denied?.toast?.type, "error");
    const copied = await f.sdkCard(value, { messageId: "copied-history-panel" });
    assert.equal(copied?.toast?.type, "warning");
  }
  await f.flush();
  assert.equal(f.lists.length, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(f.patches.length, count);
  assert.deepEqual(f.snapshot(), before);
});

test("global tokens copied to another genuine private panel cannot reveal the original snapshot", async t => {
  const f = fixture(t);
  await f.message("/threads all");
  const values = ["show_history_scope", "show_history_list", "show_history_thread"].map(action => f.valueFor(action));
  await f.message("/panel", { chatId: "another-private-chat" });
  await f.flush();
  const before = f.snapshot();
  for (const value of values) {
    await f.sdkCard({ ...value, scopeChatId: "another-private-chat" },
      { chatId: "another-private-chat", messageId: f.currentPanel("another-private-chat") });
    await f.flush();
    assert.ok(!textOf(f.currentCard("another-private-chat")).includes(PRIVATE_TITLE));
    assert.ok(!textOf(f.currentCard("another-private-chat")).includes(PRIVATE_TEXT));
  }
  assert.equal(f.lists.length, 1);
  assert.equal(f.reads.length, 0);
  assert.deepEqual(f.snapshot(), before);
});

test("a global scope switch ACKs through the SDK before its slow list query completes", async t => {
  let block;
  const f = fixture(t, { onList: (_params, count) => count === 2 ? block.promise : listData() });
  block = f.gate(listData());
  await f.message("/threads");
  const before = f.snapshot();
  const response = await f.sdkCard(f.valueFor("show_history_scope"));
  assert.equal(response?.toast?.type, "info");
  assert.equal(f.lists.length, 2);
  assert.equal(f.lists[1].allProjects, true);
  block.resolve(listData());
  await f.flush();
  assert.match(textOf(f.currentCard()), /全部项目/);
  assert.deepEqual(f.snapshot(), before);
});

test("a late global scope query cannot overwrite switching back to current-project history", async t => {
  let block;
  const f = fixture(t, { onList: (_params, count) => count === 2 ? block.promise : listData() });
  block = f.gate(listData());
  await f.message("/threads");
  const before = f.snapshot();
  const scopeValue = f.valueFor("show_history_scope");
  await f.sdkCard(scopeValue);
  await f.sdkCard({ ...scopeValue, allProjects: false });
  await until(() => f.lists.length === 3 && f.valueFor("show_history_scope").allProjects === true, "newer current-project list");
  block.resolve(listData());
  await f.flush();
  assert.deepEqual(f.lists.map(params => params.allProjects), [false, true, false]);
  assert.equal(f.valueFor("show_history_scope").allProjects, true);
  assert.match(textOf(f.currentCard()), /当前项目/);
  assert.deepEqual(f.snapshot(), before);
});

const attachedBindings = f => [...f.audit.runner.sessions.values()].filter(binding => binding.attached);
const originalBindingKey = `${CHAT}::${PROJECT}::default`;
const crossProjectList = () => listData({ threads: [{ id: THREAD, title: PRIVATE_TITLE, cwd: OTHER_PROJECT }] });
async function attachmentButton(f, { global = false } = {}) {
  await f.message(global ? "/threads all" : "/threads");
  await f.sdkCard(f.valueFor("show_history_thread"));
  await f.flush();
  const button = buttons(f.currentCard()).find(item => item.value.action === "attach_history");
  assert.equal(button?.text.content, "附加到飞书");
  assert.ok(button.confirm?.title?.content && button.confirm?.text?.content);
  return clone(button.value);
}
function assertNoAttachment(f, before) {
  assert.deepEqual(f.snapshot(), before);
  assert.equal(attachedBindings(f).length, 0);
  assert.equal(f.creations.length, 0);
  assert.equal(f.executions.length, 0);
}

test("confirmed cross-project attachment binds the snapshot thread and cwd without sending a model turn", async t => {
  const f = fixture(t, { seedPending: false, onList: crossProjectList });
  assert.equal(f.audit.runner.tasks.size, 0);
  assert.equal(f.audit.runner.queue.entries.size, 0);
  const original = clone(f.audit.runner.sessions.get(originalBindingKey));
  const value = await attachmentButton(f, { global: true });
  assert.equal(f.inspections.length, 0, "Viewing the confirmation button does not attach");
  const response = await f.sdkCard({ ...value, threadId: "forged-thread", cwd: PROJECT, targetProjectPath: PROJECT });
  assert.equal(response?.toast?.type, "info");
  await f.flush();
  assert.deepEqual(f.inspections, [{ threadId: THREAD, projectPath: OTHER_PROJECT }]);
  assert.equal(f.runtimeChecks[0].id, THREAD);
  assert.equal(f.runtimeChecks[0].cwd, OTHER_PROJECT);
  assert.equal(attachedBindings(f).length, 1);
  const [binding] = attachedBindings(f);
  assert.equal(binding.threadId, THREAD);
  assert.equal(binding.attached, true);
  assert.equal(binding.projectPath, OTHER_PROJECT);
  assert.equal(f.audit.runner.activeProjectPath(CHAT), OTHER_PROJECT);
  assert.equal(f.audit.runner.activeSessionName(CHAT, OTHER_PROJECT), binding.name);
  assert.deepEqual(clone(f.audit.runner.sessions.get(originalBindingKey)), original);
  assert.equal(f.creations.length, 0);
  assert.equal(f.executions.length, 0);
  assert.match(textOf(f.currentCard()), /已附加/);
});

test("attachment returns its SDK ACK while Desktop runtime inspection is still blocked", async t => {
  let block;
  const f = fixture(t, { seedPending: false, onRuntime: () => block.promise });
  block = f.gate({ id: THREAD, cwd: PROJECT, title: PRIVATE_TITLE });
  const value = await attachmentButton(f);
  const before = f.snapshot();
  let acknowledged = false;
  const operation = f.sdkCard(value).then(response => { acknowledged = true; return response; });
  await until(() => f.runtimeChecks.length === 1, "blocked Desktop attachment check");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, true);
  assert.equal((await operation)?.toast?.type, "info");
  assertNoAttachment(f, before);
  block.resolve();
  await f.flush();
  assert.equal(attachedBindings(f).length, 1);
  assert.equal(f.creations.length, 0);
});

test("re-attaching the same cross-project thread reuses its named session and preserves the original session", async t => {
  const f = fixture(t, { seedPending: false, onList: crossProjectList });
  const original = clone(f.audit.runner.sessions.get(originalBindingKey));
  await f.sdkCard(await attachmentButton(f, { global: true }));
  await f.flush();
  const first = clone(attachedBindings(f)[0]);
  await f.sdkCard(await attachmentButton(f, { global: true }));
  await f.flush();
  assert.equal(attachedBindings(f).length, 1);
  assert.equal(attachedBindings(f)[0].name, first.name);
  assert.equal(attachedBindings(f)[0].threadId, THREAD);
  assert.equal(f.audit.runner.sessions.size, 2);
  assert.deepEqual(clone(f.audit.runner.sessions.get(originalBindingKey)), original);
  assert.equal(f.creations.length, 0);
});

test("attached create/run/save pins the same thread and inherits blank model and effort", async t => {
  const f = fixture(t, { seedPending: false, allowTasks: true });
  await f.sdkCard(await attachmentButton(f));
  await f.flush();
  assert.equal(f.creations.length, 0);
  await f.message("在原会话内继续这个测试");
  await f.flush();
  assert.equal(f.creations.length, 1);
  assert.equal(f.executions.length, 1);
  const [options] = f.executions;
  assert.equal(options.threadId, THREAD);
  assert.equal(options.model, "");
  assert.equal(options.effort, "");
  assert.equal(options.preserveThreadPlacement, true);
  assert.equal(options.name, PRIVATE_TITLE);
  assert.ok(!options.configArgs.some(value => /model_reasoning_effort/.test(value)));
  const task = [...f.audit.runner.tasks.values()][0];
  assert.equal(task.attachedThreadId, THREAD);
  assert.equal(task.status, "success");
  assert.equal(task.model, "");
  assert.equal(task.effort, "");
  const [binding] = attachedBindings(f);
  assert.equal(binding.threadId, THREAD);
  assert.equal(binding.attached, true);
  assert.equal(binding.turns, 1);
  const persisted = f.saved.at(-1).sessions.find(([, item]) => item.threadId === THREAD)?.[1];
  assert.equal(persisted?.attached, true);
  assert.equal(f.audit.runner.sessions.get(originalBindingKey).threadId, "feishu-owned-thread");
});

test("explicit attached model/effort overrides stay on that session and never create a replacement thread", async t => {
  const f = fixture(t, { seedPending: false, allowTasks: true });
  await f.sdkCard(await attachmentButton(f));
  await f.flush();
  const sourceOverrides = { model: [...f.audit.runner.modelOverrides], reasoning: [...f.audit.runner.reasoningOverrides] };
  await f.message("/model grok-4.6 low");
  assert.equal(f.creations.length, 0);
  assert.equal(f.audit.runner.effectiveModel(CHAT, PROJECT), "grok-4.6");
  assert.equal(f.audit.runner.effectiveReasoning(CHAT, PROJECT), "low");
  assert.deepEqual(clone([...f.audit.runner.modelOverrides]), clone(sourceOverrides.model));
  assert.deepEqual(clone([...f.audit.runner.reasoningOverrides]), clone(sourceOverrides.reasoning));
  await f.message("使用显式模型继续原会话");
  await f.flush();
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].threadId, THREAD);
  assert.equal(f.executions[0].model, "grok-4.6");
  assert.equal(f.executions[0].effort, "low");
  assert.equal(attachedBindings(f)[0].attachedModelOverride, "grok-4.6");
  assert.equal(attachedBindings(f)[0].attachedReasoningOverride, "low");
  await f.message("/model default");
  await f.message("/reasoning default");
  await f.message("恢复原模型继承设置");
  await f.flush();
  assert.equal(f.executions[1].threadId, THREAD);
  assert.equal(f.executions[1].model, "");
  assert.equal(f.executions[1].effort, "");
  assert.equal(attachedBindings(f).length, 1);
  assert.equal(f.audit.runner.sessions.size, 2);
});

for (const kind of ["forged-token", "list-token"]) {
  test(`attachment rejects ${kind} before inspection or mapping changes`, async t => {
    const f = fixture(t, { seedPending: false });
    let value;
    if (kind === "forged-token") value = { ...await attachmentButton(f), historyToken: "forged-token" };
    else {
      await f.message("/threads");
      value = { ...f.valueFor("show_history_list"), action: "attach_history" };
    }
    const before = f.snapshot();
    await f.sdkCard(value);
    await f.flush();
    assertNoAttachment(f, before);
    assert.equal(f.inspections.length, 0);
    assert.equal(f.runtimeChecks.length, 0);
    assert.match(textOf(f.currentCard()), /附加未完成/);
  });
}

for (const actor of ["outsider", "second-owner", "group", "old-panel"]) {
  test(`attachment rejects ${actor} callbacks without inspecting the target`, async t => {
    const f = fixture(t, { seedPending: false, allowed: [USER, "second-owner"] });
    const value = await attachmentButton(f);
    const before = f.snapshot();
    const options = actor === "group" ? { chatId: "group-chat" }
      : actor === "old-panel" ? { messageId: "old-panel" } : { operatorId: actor };
    const response = await f.sdkCard(actor === "group" ? { ...value, scopeChatId: "group-chat" } : value, options);
    await f.flush();
    assert.ok(["error", "warning"].includes(response?.toast?.type));
    assertNoAttachment(f, before);
    assert.equal(f.inspections.length, 0);
    assert.equal(f.runtimeChecks.length, 0);
  });
}

for (const status of ["pending", "running", "stopping"]) {
  test(`attachment refuses a ${status} source session, including paused pending work`, async t => {
    const f = fixture(t);
    f.audit.runner.tasks.get("task-existing").status = status;
    const value = await attachmentButton(f);
    const before = f.snapshot();
    await f.sdkCard(value);
    await f.flush();
    assertNoAttachment(f, before);
    assert.match(textOf(f.currentCard()), /附加未完成.*当前飞书会话/);
  });
}

for (const status of ["pending", "running", "stopping"]) {
  test(`attachment refuses an already-bound ${status} target session`, async t => {
    const f = fixture(t, { seedPending: false, onList: crossProjectList });
    f.audit.runner.sessions.set(`${CHAT}::${OTHER_PROJECT}::target-session`, { name: "target-session", threadId: THREAD,
      projectPath: OTHER_PROJECT, backend: APP_SERVER_SESSION_BACKEND });
    f.audit.runner.tasks.set("target-task", { taskId: "target-task", source: { chatId: CHAT, senderId: USER },
      projectPath: OTHER_PROJECT, sessionName: "target-session", status, createdAt: 1 });
    const value = await attachmentButton(f, { global: true });
    const before = f.snapshot();
    await f.sdkCard(value);
    await f.flush();
    assertNoAttachment(f, before);
    assert.match(textOf(f.currentCard()), /附加未完成.*目标会话/);
  });
}

test("changed metadata reported by reader.inspect cannot bind or fall back to another thread", async t => {
  const f = fixture(t, { seedPending: false, onInspect: () => { throw new Error("Thread metadata changed"); } });
  const value = await attachmentButton(f);
  const before = f.snapshot();
  await f.sdkCard(value);
  await f.flush();
  assertNoAttachment(f, before);
  assert.equal(f.inspections.length, 1);
  assert.equal(f.runtimeChecks.length, 0);
  assert.match(textOf(f.currentCard()), /附加未完成/);
});

for (const reason of ["missing target", "read failed", "target active", "cwd changed"]) {
  test(`Desktop attachment inspection failure (${reason}) never creates a new thread`, async t => {
    const f = fixture(t, { seedPending: false, onRuntime: () => { throw new Error(reason); } });
    const value = await attachmentButton(f);
    const before = f.snapshot();
    await f.sdkCard(value);
    await f.flush();
    assertNoAttachment(f, before);
    assert.equal(f.inspections.length, 1);
    assert.equal(f.runtimeChecks.length, 1);
    assert.match(textOf(f.currentCard()), /附加未完成/);
  });
}

for (const stage of ["metadata", "runtime"]) {
  for (const change of ["revoke", "navigate"]) {
    test(`attachment revalidates after ${change} during asynchronous ${stage} inspection`, async t => {
      let block;
      const f = fixture(t, { seedPending: false,
        ...(stage === "metadata" ? { onInspect: () => block.promise } : { onRuntime: () => block.promise }),
      });
      block = f.gate({ id: THREAD, cwd: PROJECT, title: PRIVATE_TITLE, status: "notLoaded" });
      const value = await attachmentButton(f);
      const before = f.snapshot();
      await f.sdkCard(value);
      await until(() => stage === "metadata" ? f.inspections.length === 1 : f.runtimeChecks.length === 1, "pending attachment inspection");
      if (change === "revoke") f.allowed.clear();
      else await f.sdkCard(f.valueFor("show_home"));
      const visible = textOf(f.currentCard());
      block.resolve({ id: THREAD, cwd: PROJECT, title: PRIVATE_TITLE, status: "notLoaded" });
      await f.flush();
      assertNoAttachment(f, before);
      assert.equal(textOf(f.currentCard()), visible, "A stale attachment receipt must not replace newer navigation");
    });
  }
}

test("a task arriving during runtime inspection prevents attachment at commit time", async t => {
  let block;
  const f = fixture(t, { seedPending: false, onRuntime: () => block.promise });
  block = f.gate();
  const value = await attachmentButton(f);
  await f.sdkCard(value);
  await until(() => f.runtimeChecks.length === 1, "runtime check");
  f.audit.runner.tasks.set("new-pending", { taskId: "new-pending", source: { chatId: CHAT, senderId: USER },
    projectPath: PROJECT, sessionName: "default", status: "pending", createdAt: 1 });
  const before = f.snapshot();
  block.resolve();
  await f.flush();
  assertNoAttachment(f, before);
  assert.match(textOf(f.currentCard()), /附加未完成/);
});

test("attachment rejects the independent app-server transport without changing mappings", async t => {
  const f = fixture(t, { seedPending: false, transport: "app-server" });
  const value = await attachmentButton(f);
  const before = f.snapshot();
  await f.sdkCard(value);
  await f.flush();
  assertNoAttachment(f, before);
  assert.match(textOf(f.currentCard()), /附加未完成.*桌面通道/);
});

test("a missing original cwd prevents cross-project attachment rather than using the default project", async t => {
  let available = true;
  const f = fixture(t, { seedPending: false, onList: crossProjectList, exists: value => value !== OTHER_PROJECT || available });
  const value = await attachmentButton(f, { global: true });
  const before = f.snapshot();
  available = false;
  await f.sdkCard(value);
  await f.flush();
  assertNoAttachment(f, before);
  assert.match(textOf(f.currentCard()), /附加未完成.*目录/);
});

test("switching transport after attachment fails without calling any replacement backend", async t => {
  const f = fixture(t, { seedPending: false, allowTasks: true });
  await f.sdkCard(await attachmentButton(f));
  await f.flush();
  f.context.config.codex.transport = "app-server";
  await f.message("仍然只能使用原附加会话");
  await f.flush();
  assert.equal(f.executions.length, 0);
  assert.equal(attachedBindings(f)[0].threadId, THREAD);
  assert.equal(f.audit.runner.sessions.size, 2);
  const task = [...f.audit.runner.tasks.values()][0];
  assert.equal(task.status, "failed");
  assert.match(task.error, /桌面通道/);
});

test("a failed attached target run retains its binding and never retries with an empty thread ID", async t => {
  const f = fixture(t, { seedPending: false, allowTasks: true,
    executeTask: async () => { throw new Error("Original target is unavailable"); },
  });
  await f.sdkCard(await attachmentButton(f));
  await f.flush();
  await f.message("原目标不可用时明确失败");
  await f.flush();
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].threadId, THREAD);
  assert.equal(attachedBindings(f)[0].threadId, THREAD);
  assert.equal(f.audit.runner.sessions.size, 2);
  assert.equal([...f.audit.runner.tasks.values()][0].status, "failed");
});

for (const stage of ["metadata", "runtime"]) {
  for (const input of ["附加完成前请先等待，不要投到旧会话", "继续"]) {
    test(`task input ${JSON.stringify(input)} waits while attachment ${stage} inspection is pending`, async t => {
      let block;
      const f = fixture(t, { seedPending: false, allowTasks: true,
        ...(stage === "metadata" ? { onInspect: () => block.promise } : { onRuntime: () => block.promise }),
      });
      block = f.gate({ id: THREAD, cwd: PROJECT, title: PRIVATE_TITLE, status: "notLoaded" });
      const value = await attachmentButton(f);
      const before = f.snapshot();
      await f.sdkCard(value);
      await until(() => stage === "metadata" ? f.inspections.length === 1 : f.runtimeChecks.length === 1, "pending attachment");
      await f.message(input);
      assert.equal(f.creations.length, 0, "Input must not be submitted to the old active session");
      assert.equal(f.executions.length, 0);
      assert.deepEqual(f.snapshot(), before);
      assert.match(f.texts.at(-1)?.text || "", /附加|等待/);
      block.resolve({ id: THREAD, cwd: PROJECT, title: PRIVATE_TITLE, status: "notLoaded" });
      await f.flush();
      assert.equal(attachedBindings(f).length, 1);
      await f.message("附加完成后才发送这条新任务");
      await f.flush();
      assert.equal(f.executions.length, 1);
      assert.equal(f.executions[0].threadId, THREAD);
    });
  }
}

test("an attached cwd disappearing later never redirects a message to the old default project", async t => {
  let available = true;
  const f = fixture(t, { seedPending: false, allowTasks: true, onList: crossProjectList,
    exists: value => value !== OTHER_PROJECT || available });
  await f.sdkCard(await attachmentButton(f, { global: true }));
  await f.flush();
  assert.equal(f.audit.runner.activeProjectPath(CHAT), OTHER_PROJECT);
  available = false;
  await f.message("原附加目录失效后应当明确拒绝这条消息");
  await f.flush();
  assert.equal(f.executions.length, 0, "Missing attached cwd must not fall back to the original default session");
  assert.equal(f.audit.runner.activeProjectPath(CHAT), OTHER_PROJECT);
  assert.match(f.texts.at(-1)?.text || "", /路径不存在/);
  assert.equal(attachedBindings(f)[0].threadId, THREAD);
  assert.equal(f.audit.runner.sessions.get(originalBindingKey).threadId, "feishu-owned-thread");
});

for (const stage of ["metadata", "runtime"]) {
  for (const input of ["继续", "/resume", "/resume task-stopped"]) {
    test(`pending attachment ${stage} inspection blocks ${input} from resuming an old interrupted task`, async t => {
      let block;
      const f = fixture(t, { seedPending: false, allowTasks: true,
        ...(stage === "metadata" ? { onInspect: () => block.promise } : { onRuntime: () => block.promise }),
      });
      block = f.gate({ id: THREAD, cwd: PROJECT, title: PRIVATE_TITLE, status: "notLoaded" });
      const stopped = { taskId: "task-stopped", source: { chatId: CHAT, senderId: USER, chatType: "p2p", messageId: "old-task-input" },
        projectPath: PROJECT, sessionName: "default", status: "interrupted", prompt: "旧会话已停止的任务", executionPrompt: "旧任务", createdAt: 1,
        threadId: "feishu-owned-thread", turnId: "old-interrupted-turn", model: "gpt-6.1-sol", effort: "high", reasoningOverride: "high",
        sessionGeneration: 0, submissionState: "submitted" };
      f.audit.runner.tasks.set(stopped.taskId, stopped);
      const value = await attachmentButton(f);
      const before = f.snapshot();
      await f.sdkCard(value);
      await until(() => stage === "metadata" ? f.inspections.length === 1 : f.runtimeChecks.length === 1, "pending inspection with an old interrupted task");
      await f.message(input);
      assert.equal(f.creations.length, 0, "An existing interrupted task must not bypass the pending-attachment guard");
      assert.equal(f.executions.length, 0);
      assert.equal(stopped.resumedAs, undefined);
      assert.equal(stopped.resumeOperation, undefined);
      assert.deepEqual(f.snapshot(), before);
      assert.match(f.texts.at(-1)?.text || "", /正在附加.*成功后再发送/);
      block.resolve({ id: THREAD, cwd: PROJECT, title: PRIVATE_TITLE, status: "notLoaded" });
      await f.flush();
      assert.equal(attachedBindings(f).length, 1);
      assert.equal(attachedBindings(f)[0].threadId, THREAD);
      assert.equal(stopped.status, "interrupted");
      assert.equal(f.creations.length, 0);
      assert.equal(f.executions.length, 0);
    });
  }
}
