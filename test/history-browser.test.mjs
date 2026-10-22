import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryBrowser, historyMessagePages } from "../history-browser.mjs";

const scope = { chatId: "private", ownerId: "owner", panelId: "panel", projectPath: "E:\\repo" };
const buttons = card => card.elements.flatMap(element => element.actions || []);
const value = (card, action, predicate = () => true) => {
  const button = buttons(card).find(button => button.value.action === action && predicate(button.value));
  assert.ok(button, `Missing ${action}`);
  return button.value;
};
function fixture(options = {}) {
  const calls = [];
  const reader = {
    list: async args => { calls.push(["list", args]); return { threads: [{ id: "thread", title: "本机讨论" }], nextCursor: args.cursor ? null : "opaque-list" }; },
    read: async args => { calls.push(["read", args]); return { thread: { id: "thread", title: "本机讨论" }, messages: [
      { role: "user", text: "/run 应当显示为文本" }, { role: "assistant", text: "完整回复😀".repeat(800) },
    ], nextCursor: args.cursor ? null : "opaque-turn" }; },
  };
  return { browser: new HistoryBrowser({ reader, ...options }), calls };
}

test("browse, text pagination, older/newer batches and refresh only call read methods", async () => {
  const { browser, calls } = fixture();
  const list = await browser.open(scope);
  const older = await browser.act(value(list, "show_history_batch"), scope);
  assert.equal(calls.at(-1)[1].cursor, "opaque-list");
  await browser.act(value(older, "show_history_batch"), scope);
  assert.equal(calls.at(-1)[1].cursor, null);
  let card = await browser.act(value(list, "show_history_thread"), scope);
  assert.ok(JSON.stringify(card).includes("/run 应当显示为文本"));
  let textPages = 1;
  while (buttons(card).some(button => button.text.content === "下一段")) {
    card = await browser.act(value(card, "show_history_text", entry => entry.historyPage === textPages), scope);
    textPages++;
  }
  assert.ok(textPages >= 3);
  assert.equal(calls.filter(([method]) => method === "read").length, 1);
  card = await browser.act(value(card, "show_history_batch"), scope);
  assert.equal(calls.at(-1)[1].cursor, "opaque-turn");
  await browser.act(value(card, "show_history_refresh"), scope);
  assert.equal(calls.at(-1)[1].cursor, undefined);
  assert.ok(calls.every(([method]) => ["list", "read"].includes(method)));
});

test("history tokens bind actor, private chat, panel and project; forged threads never read", async () => {
  const { browser, calls } = fixture();
  const card = await browser.open(scope), open = value(card, "show_history_thread");
  for (const key of Object.keys(scope)) await assert.rejects(browser.act(open, { ...scope, [key]: "foreign" }), /过期/);
  await assert.rejects(browser.act({ ...open, threadId: "unlisted" }, scope), /列表/);
  await assert.rejects(browser.act({ ...open, historyToken: "forged" }, scope), /过期/);
  assert.equal(calls.length, 1);
  const read = await browser.act({ ...open, cursor: "injected" }, scope);
  assert.equal(calls.at(-1)[1].cursor, undefined);
  for (const page of [-1, 0.5, 1e6, "1"]) await assert.rejects(browser.act({ ...value(read, "show_history_refresh"), action: "show_history_text", historyPage: page }, scope), /页码/);
});

test("expired, evicted and restarted snapshots cannot reveal cached contents", async () => {
  let now = 10;
  const { browser } = fixture({ ttlMs: 20, maxSnapshots: 2, now: () => now });
  const first = await browser.open(scope), open = value(first, "show_history_thread");
  now = 30;
  await assert.rejects(browser.act(open, scope), /过期/);
  now = 31;
  const second = await browser.open(scope);
  await browser.open(scope); await browser.open(scope);
  await assert.rejects(browser.act(value(second, "show_history_thread"), scope), /过期/);
  await assert.rejects(fixture().browser.act(open, scope), /过期/);
});

test("long Unicode and Markdown are escaped and preserved across bounded message pages", () => {
  const text = "😀中[点击](https://example.test) <at id=all> *** ".repeat(400);
  const pages = historyMessagePages([{ role: "assistant", text }]);
  assert.ok(pages.length > 10 && pages.every(page => page.length <= 2400));
  const restored = pages.join("").replace(/\n\n(?=\*\*Codex)/g, "").replace(/\*\*Codex(?:（续）)?\*\*\n/g, "").replace(/\\([\\`*_\[\]<>!])/g, "$1");
  assert.equal(restored, text);
  assert.ok(!pages.some(page => /[\uD800-\uDBFF]$/.test(page)));
});

test("empty filtered pages retain next navigation and expose no task controls", async () => {
  const browser = new HistoryBrowser({ reader: { list: async () => ({ threads: [], nextCursor: "next" }) } });
  const card = await browser.open(scope);
  assert.ok(buttons(card).some(button => button.value.direction === "older"));
  assert.ok(buttons(card).every(button => button.value.action.startsWith("show_")));
  assert.ok(!JSON.stringify(card).includes("nextCursor"));
});

test("global lists select only the stored source project and preserve it through reads and return navigation", async () => {
  const calls = [];
  const external = "E:\\another-repo";
  const reader = {
    list: async args => { calls.push(["list", args]); return { threads: [{ id: "outside", title: "其他项目", cwd: external }], nextCursor: "list-page" }; },
    read: async args => { calls.push(["read", args]); return { thread: { id: "outside", title: "其他项目", cwd: external },
      messages: [{ role: "assistant", text: "历史正文" }], nextCursor: args.cursor ? null : "turn-page" }; },
  };
  const browser = new HistoryBrowser({ reader });
  const initial = await browser.open(scope);
  const global = await browser.act(value(initial, "show_history_scope"), scope);
  assert.equal(calls.at(-1)[1].allProjects, true);
  const older = await browser.act(value(global, "show_history_batch"), scope);
  assert.equal(calls.at(-1)[1].cursor, "list-page");
  let card = await browser.act({ ...value(older, "show_history_thread"), cwd: "Z:\\injected", targetProjectPath: "Z:\\injected" }, scope);
  assert.equal(calls.at(-1)[1].projectPath, external);
  card = await browser.act(value(card, "show_history_batch"), scope);
  assert.equal(calls.at(-1)[1].projectPath, external);
  card = await browser.act(value(card, "show_history_refresh"), scope);
  assert.equal(calls.at(-1)[1].projectPath, external);
  const count = calls.length;
  card = await browser.act(value(card, "show_history_list"), scope);
  assert.equal(calls.length, count, "Returning should restore the saved list without resetting its cursor");
  assert.ok(JSON.stringify(card).includes("全部项目"));
  assert.ok(buttons(card).some(button => button.value.direction === "newer"));
  const restored = await browser.act(value(card, "show_history_refresh"), scope);
  assert.equal(calls.at(-1)[1].allProjects, true);
  await browser.act(value(restored, "show_history_scope"), scope);
  assert.equal(calls.at(-1)[1].allProjects, false);
});

test("global list entries need a confirmed source cwd and range actions require a boolean", async () => {
  const { browser, calls } = fixture();
  const global = await browser.open(scope, { allProjects: true });
  await assert.rejects(browser.act(value(global, "show_history_thread"), scope), /项目未确认/);
  for (const allProjects of [undefined, "true", 1, null]) {
    await assert.rejects(browser.act({ ...value(global, "show_history_scope"), allProjects }, scope), /范围无效/);
  }
  assert.equal(calls.length, 1);
});

test("attachment revalidates only the stored thread and project and never executes a model turn", async () => {
  const checks = [];
  const { browser } = fixture();
  browser.reader.inspect = async args => { checks.push(args); return { id: args.threadId, cwd: args.projectPath, title: "原会话", status: "idle" }; };
  const list = await browser.open(scope);
  await assert.rejects(browser.attachment(value(list, "show_history_thread"), scope), /过期/);
  const card = await browser.act(value(list, "show_history_thread"), scope);
  const attach = value(card, "attach_history");
  assert.ok(buttons(card).find(button => button.value.action === "attach_history").confirm);
  const selected = await browser.attachment({ ...attach, threadId: "forged", cwd: "Z:\\forged" }, scope);
  assert.equal(selected.id, "thread");
  assert.deepEqual(checks, [{ projectPath: scope.projectPath, threadId: "thread" }]);
  for (const key of Object.keys(scope)) await assert.rejects(browser.attachment(attach, { ...scope, [key]: "foreign" }), /过期/);
  assert.equal(checks.length, 1);
});

test("cache evicts by byte budget, drops duplicate message copies and proactively expires", async t => {
  let now = 1;
  const { browser } = fixture({ maxBytes: 40_000, ttlMs: 25, now: () => now });
  t.after(() => browser.close());
  let card = await browser.open(scope);
  card = await browser.act(value(card, "show_history_thread"), scope);
  for (let i = 0; i < 8; i++) card = await browser.act(value(card, "show_history_refresh"), scope);
  assert.ok(browser.cacheBytes <= 40_000);
  assert.ok([...browser.snapshots.values()].every(entry => !entry.data.messages));
  now = 26;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(browser.cacheBytes, 0);
  assert.equal(browser.snapshots.size, 0);
});
