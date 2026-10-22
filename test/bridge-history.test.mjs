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
const listData = (extra = {}) => ({ threads: [{ id: THREAD, title: PRIVATE_TITLE }], nextCursor: "list-cursor", ...extra });
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

function fixture(t, { allowed = [USER], onList, onRead, onPatch, discoverProjects } = {}) {
  const texts = [], replies = [], patches = [], completedPatches = [], reads = [], lists = [];
  const factories = [], forbidden = [], saved = [], logs = [], gates = [];
  const pending = new Set(), panels = new Set(), rendered = new Map(), browsers = new Set();
  let serial = 0, activePatches = 0;
  const track = promise => {
    pending.add(promise);
    promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const reader = {
    async list(params) { lists.push(clone(params)); return onList ? onList(params, lists.length) : listData(); },
    async read(params) { reads.push(clone(params)); return onRead ? onRead(params, reads.length) : threadData(); },
  };
  class ObservedHistoryBrowser extends HistoryBrowser {
    constructor(...args) { super(...args); browsers.add(this); }
    open(...args) { return track(super.open(...args)); }
    act(...args) { return track(super.act(...args)); }
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
  const scopeKey = `${CHAT}::${PROJECT}`;
  const sessionKey = `${scopeKey}::default`;
  const initialState = {
    sessions: [[sessionKey, { name: "default", threadId: "feishu-owned-thread", backend: APP_SERVER_SESSION_BACKEND,
      model: "gpt-6.1-sol", projectPath: PROJECT, turns: 4, updatedAt: "2026-10-22T00:00:00Z" }]],
    activeSessions: [[scopeKey, "default"]], activeProjects: [[CHAT, PROJECT]], knownSessions: [sessionKey],
    modelOverrides: [[scopeKey, "gpt-6.1-sol"]], reasoningOverrides: [[scopeKey, "high"]], pausedQueues: [sessionKey],
  };
  const context = vm.createContext({
    ...core, path, EventDispatcher, normalizeCardAction, HistoryBrowser: ObservedHistoryBrowser,
    TaskSteering, buildSteeringCard, SessionTaskQueue, TaskInterruption, buildPanelCard, buildTaskCard,
    APP_SERVER_SESSION_BACKEND, canResumeAppServerSession, messenger,
    createHistoryReader: options => { factories.push(options); return reader; },
    process: { env: {} }, setTimeout, clearTimeout, setInterval, clearInterval,
    config: { codex: { transport: "desktop", configOverrides: [], defaultModel: "gpt-6.1-sol",
      modelGroups: { codex: ["gpt-6.1-sol"], grok: [] }, reasoningEffortChoices: ["low", "high"] }, bridge: {
      defaultProjectPath: PROJECT, projectChoices: [{ alias: "repo", path: PROJECT }, { alias: "other", path: OTHER_PROJECT }],
      generatedImageMaxCount: 0, streamPushInterval: 30_000,
    } },
    readSessionState: () => clone(initialState), writeSessionState: state => saved.push(clone(state)),
    log: (level, message, data) => logs.push({ level, message, data }),
    refreshProjectChoices: reason => Promise.resolve(discoverProjects?.(reason)),
    getHelpMessage: () => "命令帮助", existsSync: () => true,
    codexLauncher: { command: "never-spawn-codex", argsPrefix: [], shell: false }, codexHome: "never-read-codex-home",
    generateTaskId: () => `task-${++serial}`, runDesktopTask: denyWrite("runDesktopTask"),
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
  audit.runner.create = async (...args) => {
    forbidden.push({ operation: "runner.create", args });
    return { taskId: "unexpected-task", sessionName: "default" };
  };
  const queued = { taskId: "task-existing", source: { chatId: CHAT, senderId: USER }, projectPath: PROJECT,
    sessionName: "default", status: "pending", prompt: "existing Feishu queued task", createdAt: 1, generation: "existing" };
  audit.runner.tasks.set(queued.taskId, queued);
  audit.runner.queue.enqueue(sessionKey, queued);

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
  const card = (value, options) => track(audit.handleCardAction(rawAction(value, options)));
  const sdkCard = (value, options) => track(audit.dispatcher.invoke({ schema: "2.0",
    header: { event_type: "card.action.trigger", event_id: `card-event-${++serial}` }, event: rawAction(value, options),
  }, { needCheck: false }));
  const flush = async () => {
    // Browser calls are detached by the production ACK path. Follow their actual
    // promises, then put barriers on the same per-panel delivery queues.
    for (let round = 0; round < 8; round++) {
      await Promise.allSettled([...pending]);
      await Promise.all([...panels].map(id => audit.executeCardActionSerially(id, async () => {})));
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

for (const input of ["/threads", "/history", "/THREADS", "本地会话", "聊天记录"]) {
  test(`authorized private history entry: ${input}`, async t => {
    const f = fixture(t);
    const before = f.snapshot();
    await f.message(input);
    assert.equal(f.lists.length, 1);
    assert.match(textOf(f.currentCard()), /只读/);
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const input of ["/threads accidental task", "/history external-thread", "/THREADS ../other", "/threads\n/run do-not-run", "/history\tanything"]) {
  test(`history arguments are rejected without creating a task: ${JSON.stringify(input)}`, async t => {
    const f = fixture(t);
    const before = f.snapshot();
    await f.message(input);
    assert.equal(f.factories.length, 0);
    assert.equal(f.lists.length, 0);
    assert.match(f.texts.at(-1)?.text || "", /直接发送 \/threads/);
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
  assert.ok(buttons(f.currentCard()).every(button => ["show_history_text", "show_history_batch", "show_history_refresh", "show_history", "show_home"].includes(button.value.action)));
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
  for (const action of ["show_history_thread", "show_history_text", "show_history_batch", "show_history_refresh", "show_history", "show_home"]) {
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
  const blocker = f.audit.executeCardActionSerially(f.currentPanel(), async () => { entered.resolve(); await gate.promise; });
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

test("an already in-flight first history PATCH and ordinary navigation share delivery ordering", async t => {
  let gate;
  const entered = deferred();
  const f = fixture(t, { onPatch: async (_id, card) => {
    if (textOf(card).includes(PRIVATE_TITLE)) { entered.resolve(); await gate.promise; }
  } });
  gate = f.gate();
  const operation = f.message("/threads");
  await entered.promise;
  const navigation = f.card(f.valueFor("show_projects"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.patches.length, 1, "Navigation must queue behind the PATCH already in flight");
  gate.resolve();
  await Promise.all([operation, navigation]);
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
