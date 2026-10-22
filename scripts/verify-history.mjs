import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Exercise production handlers against the installed Codex engine. The Feishu
// messenger records cards locally; this test sends no external chat messages.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectPath = path.resolve(process.argv[2] || process.env.DEFAULT_PROJECT_PATH || root);
const output = path.join(root, "outputs", "history-verification");
mkdirSync(output, { recursive: true });
const harnessPath = path.join(root, `.history-live-harness-${process.pid}.mjs`);
const statePath = path.join(output, `state-${process.pid}.json`);
const savedEnv = Object.fromEntries(["FEISHU_APP_ID", "FEISHU_APP_SECRET", "SESSION_STATE_PATH", "DEFAULT_PROJECT_PATH"].map(key => [key, process.env[key]]));
Object.assign(process.env, { FEISHU_APP_ID: "local-history-test", FEISHU_APP_SECRET: "local-only",
  SESSION_STATE_PATH: statePath, DEFAULT_PROJECT_PATH: projectPath });
const evidence = { startedAt: new Date().toISOString(), projectPath, externalFeishuMessages: 0, modelTurnsStarted: 0, passed: false };
const cards = [];
const buttons = card => card.elements.flatMap(element => element.actions || []);
const waitFor = async predicate => {
  const deadline = Date.now() + 25_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("History card update timed out");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
try {
  let source = readFileSync(path.join(root, "bridge.mjs"), "utf8").replace(/\r\n/g, "\n");
  source = source.replace('import { createHistoryReader } from "./codex-history.mjs";', `import { createHistoryReader as actualCreateHistoryReader } from "./codex-history.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";
const historyRpcMethods = [];
const createHistoryReader = options => actualCreateHistoryReader({ ...options, rpcFactory: rpcOptions => {
  const rpc = new CodexAppServer(rpcOptions), request = rpc.request.bind(rpc);
  rpc.request = (method, params) => {
    historyRpcMethods.push(method);
    if (!["initialize", "thread/list", "thread/read", "thread/turns/list"].includes(method)) throw new Error("Unexpected mutation RPC: " + method);
    return request(method, params);
  };
  return rpc;
} });`);
  const boundary = source.indexOf("\nconst client = new Client(");
  const showPanel = source.slice(source.indexOf("async function showControlCard("), source.indexOf("\nif (pairingCode)"));
  const handlers = source.slice(source.indexOf("async function handleMessage("), source.indexOf("\nconst dispatcher ="));
  assert.ok(boundary > 0 && showPanel && handlers);
  writeFileSync(harnessPath, source.slice(0, boundary) + `\nexport function createHistoryHarness(messenger) {
    const runner = new TaskRunner(messenger); const allowedUserIds = new Set(["local-history-user"]); let pairingCode = null;
    ${showPanel}\n${handlers}
    return { runner, handleMessage, handleCardAction, rpcMethods: historyRpcMethods };
  }\n`, "utf8");
  const { createHistoryHarness } = await import(pathToFileURL(harnessPath));
  let serial = 0;
  const record = (id, card) => { cards.push({ id, card }); return id; };
  const live = createHistoryHarness({
    replyCard: async (_id, card) => record(`local-history-card-${++serial}`, card),
    updateCard: async (id, card) => record(id, card),
    replyText: async () => `local-history-text-${++serial}`,
  });
  const actor = { chatId: "local-history-private", senderId: "local-history-user", chatType: "p2p", messageId: "local-history-input" };
  const state = () => JSON.stringify({ sessions: [...live.runner.sessions], activeSessions: [...live.runner.activeSessions],
    activeProjects: [...live.runner.activeProjects], modelOverrides: [...live.runner.modelOverrides],
    reasoningOverrides: [...live.runner.reasoningOverrides], queue: live.runner.queue.snapshot() });
  const before = state();
  await live.handleMessage({ ...actor, text: "/threads" });
  assert.equal(cards.at(-1).card.header.title.content, "本地会话（只读）");
  let candidates = buttons(cards.at(-1).card).filter(button => button.value.action === "show_history_thread");
  evidence.listedThreads = candidates.length;
  assert.ok(candidates.length, "This project needs an existing non-Feishu Codex conversation");
  const chosen = candidates[0];
  evidence.threadId = chosen.value.threadId;
  const click = async value => {
    const count = cards.length;
    const result = await live.handleCardAction({ context: { open_message_id: cards.at(-1).id, open_chat_id: actor.chatId },
      operator: { open_id: actor.senderId }, action: { tag: "button", value } });
    assert.ok(result?.toast, "History callback must ACK immediately");
    await waitFor(() => cards.length > count);
  };
  await click(chosen.value);
  assert.equal(cards.at(-1).card.header.title.content, "聊天记录（只读）");
  evidence.renderedSegments = 1;
  while (buttons(cards.at(-1).card).some(button => button.text.content === "下一段")) {
    await click(buttons(cards.at(-1).card).find(button => button.text.content === "下一段").value);
    evidence.renderedSegments++;
    assert.ok(evidence.renderedSegments < 10_000, "Text pagination did not terminate");
  }
  const older = buttons(cards.at(-1).card).find(button => button.value.direction === "older");
  if (older) {
    await click(older.value);
    assert.equal(cards.at(-1).card.header.title.content, "聊天记录（只读）");
    evidence.olderBatchVerified = true;
  }
  await click(buttons(cards.at(-1).card).find(button => button.value.action === "show_history_refresh").value);
  evidence.refreshVerified = true;
  assert.equal(live.runner.tasks.size, 0);
  // Control-card message IDs are intentionally ephemeral; browsing must never
  // touch saved session mappings, settings or task queues.
  assert.equal(state(), before);
  const denialCount = cards.length;
  await live.handleMessage({ ...actor, chatId: "local-history-group", chatType: "group", text: "/threads" });
  assert.equal(cards.length, denialCount);
  evidence.groupDenied = true;
  evidence.sessionBindingsUnchanged = true;
  evidence.cardUpdates = cards.length;
  evidence.rpcMethods = live.rpcMethods;
  evidence.modelTurnsStarted = live.rpcMethods.filter(method => method === "turn/start").length;
  assert.ok(live.rpcMethods.includes("thread/turns/list"));
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(harnessPath, { force: true });
  rmSync(statePath, { force: true });
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2), "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}
