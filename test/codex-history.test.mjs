import assert from "node:assert/strict";
import { test } from "node:test";
import { createHistoryReader, historyProjectPath } from "../codex-history.mjs";

const projectPath = "E:\\mycode\\repo";
const thread = (extra = {}) => ({ id: "thread-1", name: "历史会话", cwd: projectPath, updatedAt: 123,
  status: { type: "notLoaded" }, source: "vscode", ...extra });
const user = text => ({ type: "userMessage", content: [{ type: "text", text }] });
const assistant = text => ({ type: "agentMessage", text });

test("queue is bounded and its deadline includes waiting before a connection is created", async () => {
  const f = fixture(() => new Promise(() => {}), { timeoutMs: 35 });
  const pending = Array.from({ length: 8 }, () => f.reader.list({ projectPath }));
  await assert.rejects(f.reader.list({ projectPath }), /busy/);
  const results = await Promise.allSettled(pending);
  assert.ok(results.every(result => result.status === "rejected" && /timed out/.test(result.reason.message)));
  assert.ok(f.connections.length < 8, "Expired queued reads must not create one server per stale request");
  assert.ok(f.connections.every(connection => connection.closed === 1));
});

function fixture(handle, options = {}) {
  const requests = [];
  const connections = [];
  const reader = createHistoryReader({ command: "test-codex", timeoutMs: 1000, ...options, rpcFactory: opts => {
    const connection = { opts, closed: 0, async initialize() { requests.push({ method: "initialize" }); },
      async request(method, params) {
        assert.equal(connection.closed, 0);
        requests.push({ method, params });
        return handle(method, params, connection);
      }, close() { connection.closed++; } };
    connections.push(connection);
    return connection;
  } });
  return { reader, requests, connections };
}

test("list uses a bounded indexed page and forwards the opaque cursor", async () => {
  const f = fixture(() => ({ data: [thread()], nextCursor: "page-two" }));
  assert.deepEqual(await f.reader.list({ projectPath, cursor: "opaque-page" }), {
    threads: [{ id: "thread-1", title: "历史会话", cwd: projectPath, updatedAt: 123, status: "notLoaded" }], nextCursor: "page-two",
  });
  assert.deepEqual(f.requests[1], { method: "thread/list", params: { cwd: projectPath, cursor: "opaque-page", limit: 20,
    archived: false, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true,
    modelProviders: [], sourceKinds: ["cli", "vscode", "exec", "appServer"] } });
  assert.equal(f.connections[0].closed, 1);
});

test("list normalizes exact Windows paths and excludes siblings, children, missing cwd, bridge and subagents", async () => {
  const data = [thread({ cwd: "\\\\?\\E:\\MYCODE\\repo\\.\\", id: "match" }),
    thread({ cwd: `${projectPath}\\child` }), thread({ cwd: `${projectPath}-other` }), thread({ cwd: null }),
    thread({ name: "[飞书] 项目" }), thread({ name: null, preview: "[飞书] 未命名" }),
    thread({ name: `${"a".repeat(130)}[飞书]` }),
    thread({ source: "subAgentReview" }), thread({ source: { subAgent: { thread_spawn: {} } } }),
    thread({ source: { type: "subAgent" } }),
    thread({ parentThreadId: "parent" }), thread({ threadSource: "subAgent" }), null, {}];
  const f = fixture(() => ({ data, nextCursor: "more" }));
  const result = await f.reader.list({ projectPath: "E:/mycode/repo/" });
  assert.deepEqual(result.threads.map(t => t.id), ["match"]);
  assert.equal(result.nextCursor, "more");
});

test("path matching supports UNC and retains POSIX case sensitivity", async () => {
  const unc = fixture(() => ({ data: [thread({ cwd: "\\\\?\\UNC\\HOST\\share\\repo\\" })] }));
  assert.equal((await unc.reader.list({ projectPath: "\\\\host\\share\\repo" })).threads.length, 1);
  const posix = fixture(() => ({ data: [thread({ id: "ok", cwd: "/home/me/repo/" }), thread({ cwd: "/HOME/me/repo" })] }));
  assert.deepEqual((await posix.reader.list({ projectPath: "/home/me/repo/." })).threads.map(t => t.id), ["ok"]);
});

test("filtered empty final pages stop and fallback titles/status remain predictable", async () => {
  const f = fixture(() => ({ data: [thread({ name: "[飞书] hidden" })], nextCursor: null }));
  assert.deepEqual(await f.reader.list({ projectPath }), { threads: [], nextCursor: null });
  const empty = fixture(() => ({ data: [thread({ name: null, preview: "首行\n第二行", updatedAt: null, status: "idle" }),
    thread({ id: "unnamed", name: "", preview: "", status: null })], nextCursor: null }));
  assert.deepEqual((await empty.reader.list({ projectPath })).threads, [
    { id: "thread-1", title: "首行", cwd: projectPath, updatedAt: null, status: "idle" },
    { id: "unnamed", title: "未命名会话", cwd: projectPath, updatedAt: 123, status: "unknown" },
  ]);
});

test("read checks metadata first, requests three full turns descending and returns conversation order", async () => {
  const long = "完整文本".repeat(2000);
  const f = fixture(method => method === "thread/read" ? { thread: thread() } : {
    data: [{ items: [user("最新问题"), assistant(long)] }, { items: [user("之前问题"), assistant("之前回答")] }], nextCursor: "older",
  });
  assert.deepEqual(await f.reader.read({ projectPath, threadId: "thread-1", cursor: "here" }), {
    thread: { id: "thread-1", title: "历史会话", cwd: projectPath, status: "notLoaded" },
    messages: [{ role: "user", text: "之前问题" }, { role: "assistant", text: "之前回答" },
      { role: "user", text: "最新问题" }, { role: "assistant", text: long }], nextCursor: "older",
  });
  assert.deepEqual(f.requests.slice(1), [
    { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } },
    { method: "thread/turns/list", params: { threadId: "thread-1", cursor: "here", limit: 3, sortDirection: "desc", itemsView: "full" } },
  ]);
  assert.equal(f.connections[0].closed, 1);
});

test("only human-visible text is returned; reasoning, tools, files and attachments are omitted", async () => {
  const f = fixture(method => method === "thread/read" ? { thread: thread() } : { data: [{ items: [
    { type: "userMessage", content: [{ type: "text", text: "一" }, { type: "localImage", path: "private.png" },
      { type: "image", url: "secret" }, { type: "text", text: "二" }, null] },
    { type: "reasoning", text: "hidden" }, { type: "commandExecution", aggregatedOutput: "secret" },
    { type: "fileChange", changes: ["private"] }, { type: "mcpToolCall", result: "private" },
    { type: "functionCallOutput", output: "secret" }, { type: "plan", text: "private" },
    { ...assistant("进度"), phase: "commentary" }, assistant("回答"), assistant("  "), user(""),
    { type: "userMessage", content: [{ type: "image", url: "secret" }] }, null,
  ] }], nextCursor: null });
  assert.deepEqual((await f.reader.read({ projectPath, threadId: "thread-1" })).messages, [
    { role: "user", text: "一\n二" }, { role: "assistant", text: "进度" }, { role: "assistant", text: "回答" },
  ]);
});

test("direct read revalidates the cwd, id and exclusion rules before fetching any turns", async () => {
  for (const denied of [thread({ cwd: `${projectPath}\\child` }), thread({ cwd: "C:\\private" }),
    thread({ cwd: null }), thread({ id: "different" }), thread({ name: "[飞书] 任务" }),
    thread({ source: { subAgent: {} } }), thread({ parentThreadId: "parent" }), null]) {
    const f = fixture(() => ({ thread: denied }));
    await assert.rejects(f.reader.read({ projectPath, threadId: "thread-1" }), /unavailable/);
    assert.deepEqual(f.requests.map(r => r.method), ["initialize", "thread/read"]);
    assert.equal(f.connections[0].closed, 1);
  }
});

test("old servers fail explicitly instead of hydrating unbounded history", async () => {
  const f = fixture(method => {
    if (method === "thread/read") return { thread: thread() };
    throw Object.assign(new Error("method not found"), { rpcCode: -32601 });
  });
  await assert.rejects(f.reader.read({ projectPath, threadId: "thread-1" }), /pagination is unsupported.*fallback is disabled/);
  assert.equal(f.requests.filter(r => r.method === "thread/read").length, 1);
  assert.equal(f.connections[0].closed, 1);
});

test("transport and permission errors propagate without a full-history fallback", async () => {
  for (const code of [undefined, -32602, -32000]) {
    const error = Object.assign(new Error("test failure"), { rpcCode: code });
    const f = fixture(method => { if (method === "thread/read") return { thread: thread() }; throw error; });
    await assert.rejects(f.reader.read({ projectPath, threadId: "thread-1" }), e => e === error);
    assert.equal(f.connections[0].closed, 1);
  }
});

test("invalid paths, ids and cursors never issue a history RPC", async () => {
  const f = fixture(() => assert.fail("unexpected request"));
  for (const input of ["", "relative/path", "E:relative", null]) await assert.rejects(f.reader.list({ projectPath: input }), /absolute path/);
  await assert.rejects(f.reader.read({ projectPath, threadId: "" }), /threadId/);
  await assert.rejects(f.reader.list({ projectPath, cursor: {} }), /cursor/);
  assert.ok(f.connections.every(c => c.closed === 1));
  assert.ok(f.requests.every(r => r.method === "initialize"));
  for (const timeoutMs of [0, -1, NaN, Infinity]) assert.throws(() => createHistoryReader({ timeoutMs }), /positive/);
});

test("malformed pages and repeated cursors fail and close the connection", async () => {
  for (const result of [{}, { data: null }, { data: [], nextCursor: {} }, { data: [], nextCursor: "same" }]) {
    const f = fixture(() => result);
    await assert.rejects(f.reader.list({ projectPath, cursor: "same" }), /page|cursor/);
    assert.equal(f.connections[0].closed, 1);
  }
});

test("factory receives launcher/environment settings and every operation owns its connection", async () => {
  const env = { TEST: "value" };
  const f = fixture(() => ({ data: [] }), { command: "custom.exe", argsPrefix: ["arg"], shell: true, cwd: "C:\\launch", env, timeoutMs: 500 });
  await f.reader.list({ projectPath });
  await f.reader.list({ projectPath });
  assert.equal(f.connections.length, 2);
  assert.deepEqual(f.connections[0].opts, { command: "custom.exe", argsPrefix: ["arg"], shell: true, cwd: "C:\\launch", env, requestTimeoutMs: 500 });
  assert.ok(f.connections.every(c => c.closed === 1));
});

test("operations serialize, recover after failure and never send mutation methods", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async (method, params, connection) => {
    if (connection === f.connections[0]) { await blocked; throw new Error("first failed"); }
    return method === "thread/read" ? { thread: thread() } : { data: [] };
  });
  const first = f.reader.list({ projectPath });
  const failed = assert.rejects(first, /first failed/);
  const second = f.reader.read({ projectPath, threadId: "thread-1" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.connections.length, 1);
  release();
  await failed;
  await second;
  assert.ok(f.connections.every(c => c.closed === 1));
  assert.ok(f.requests.every(r => ["initialize", "thread/list", "thread/read", "thread/turns/list"].includes(r.method)));
});

test("an operation deadline closes stalled reads and releases the serial queue", async () => {
  let stall = true;
  const f = fixture(() => stall ? new Promise(() => {}) : { data: [] }, { timeoutMs: 20 });
  await assert.rejects(f.reader.list({ projectPath }), /timed out/);
  assert.equal(f.connections[0].closed, 1);
  stall = false;
  assert.deepEqual(await f.reader.list({ projectPath }), { threads: [], nextCursor: null });
  assert.equal(f.connections[1].closed, 1);
});

test("initialization failures and timeouts close without issuing a history request", async () => {
  for (const stall of [false, true]) {
    let closed = 0;
    const reader = createHistoryReader({ timeoutMs: 20, rpcFactory: () => ({
      initialize() { return stall ? new Promise(() => {}) : Promise.reject(new Error("init failed")); },
      request() { assert.fail("history requested after init failed"); }, close() { closed++; },
    }) });
    await assert.rejects(reader.list({ projectPath }), stall ? /timed out/ : /init failed/);
    assert.equal(closed, 1);
  }
});

test("a metadata reply arriving after timeout cannot trigger a turns request on the closed server", async () => {
  let reply;
  const f = fixture(() => new Promise(resolve => { reply = resolve; }), { timeoutMs: 20 });
  await assert.rejects(f.reader.read({ projectPath, threadId: "thread-1" }), /timed out/);
  reply({ thread: thread() });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests.map(r => r.method), ["initialize", "thread/read"]);
  assert.equal(f.connections[0].closed, 1);
});

test("empty read pages preserve nextCursor instead of inventing messages from unknown item shapes", async () => {
  const f = fixture(method => method === "thread/read" ? { thread: thread({ cwd: "E:/MYCODE/repo/" }) } : {
    data: [null, {}, { items: {} }, { items: [{ type: "unknown", text: "private" }] }], nextCursor: "older",
  });
  const result = await f.reader.read({ projectPath, threadId: "thread-1" });
  assert.deepEqual(result.messages, []);
  assert.equal(result.nextCursor, "older");
  assert.equal(f.connections[0].closed, 1);
});

test("global list omits the RPC cwd filter and returns canonical absolute cwd for each thread", async () => {
  const f = fixture(() => ({ data: [
    thread({ id: "windows", cwd: "\\\\?\\E:\\mycode\\repo\\.\\" }),
    thread({ id: "other", cwd: "F:/different/project/" }),
    thread({ id: "unc", cwd: "\\\\?\\UNC\\host\\share\\repo\\" }),
    thread({ id: "posix", cwd: "/home/me/../other/repo/" }),
    ...[null, "", "relative/project", "E:relative", 42, "E:\\bad\0path"].map(cwd => thread({ cwd })),
    thread({ name: "[飞书] private" }), thread({ source: "subAgent" }),
    thread({ source: { subAgent: {} } }), thread({ parentThreadId: "parent" }),
  ], nextCursor: "next" }));
  const result = await f.reader.list({ allProjects: true });
  assert.deepEqual(result.threads.map(({ id, cwd }) => ({ id, cwd })), [
    { id: "windows", cwd: projectPath }, { id: "other", cwd: "F:\\different\\project" },
    { id: "unc", cwd: "\\\\host\\share\\repo" }, { id: "posix", cwd: "/home/other/repo" },
  ]);
  assert.equal(result.nextCursor, "next");
  assert.equal(Object.hasOwn(f.requests[1].params, "cwd"), false);
  assert.equal(f.connections[0].closed, 1);
});

test("global listing ignores the browsing project while current mode stays exact", async () => {
  const f = fixture(() => ({ data: [thread(), thread({ id: "other", cwd: "F:\\different" }),
    thread({ id: "child", cwd: `${projectPath}\\child` })], nextCursor: null }));
  assert.deepEqual((await f.reader.list({ projectPath, allProjects: true })).threads.map(t => t.id), ["thread-1", "other", "child"]);
  assert.deepEqual((await f.reader.list({ projectPath, allProjects: false })).threads.map(t => t.id), ["thread-1"]);
  assert.equal(f.requests.filter(r => r.method === "thread/list")[1].params.cwd, projectPath);
  for (const allProjects of ["true", 1, null, {}]) await assert.rejects(f.reader.list({ projectPath, allProjects }), /boolean/);
});

test("global selection never authorizes read without the exact selected cwd", async () => {
  const otherPath = "F:\\different\\project";
  const f = fixture(method => {
    if (method === "thread/list") return { data: [thread({ cwd: otherPath })] };
    if (method === "thread/read") return { thread: thread({ cwd: otherPath }) };
    return { data: [{ items: [user("selected project"), assistant("reply")] }] };
  });
  const selected = (await f.reader.list({ projectPath, allProjects: true })).threads[0];
  assert.equal(selected.cwd, otherPath);
  await assert.rejects(f.reader.read({ threadId: selected.id, allProjects: true }), /absolute path/);
  await assert.rejects(f.reader.read({ projectPath, threadId: selected.id, allProjects: true }), /unavailable/);
  await assert.rejects(f.reader.read({ projectPath: `${otherPath}\\child`, threadId: selected.id }), /unavailable/);
  assert.equal(f.requests.filter(r => r.method === "thread/turns/list").length, 0);
  const result = await f.reader.read({ projectPath: selected.cwd, threadId: selected.id });
  assert.equal(result.thread.cwd, otherPath);
  assert.equal(result.messages.length, 2);
  assert.ok(f.connections.every(connection => connection.closed === 1));
});

test("both list scopes skip filtered pages, stop at the first visible page and return its next cursor", async () => {
  for (const allProjects of [false, true]) {
    const f = fixture((_method, params) => {
      if (params.cursor === "initial") return { data: [thread({ name: "[飞书] hidden" })], nextCursor: "second" };
      if (params.cursor === "second") return { data: [thread({ source: "subAgent" }), thread({ cwd: "relative" })], nextCursor: "third" };
      assert.equal(params.cursor, "third");
      return { data: [thread()], nextCursor: "fourth" };
    });
    const result = await f.reader.list({ projectPath, allProjects, cursor: "initial" });
    assert.equal(result.threads.length, 1);
    assert.equal(result.nextCursor, "fourth");
    assert.deepEqual(f.requests.filter(r => r.method === "thread/list").map(r => r.params.cursor), ["initial", "second", "third"]);
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].closed, 1);
  }
});

test("five-page bound preserves the last actual cursor and a later operation can continue", async () => {
  const f = fixture((_method, { cursor }) => {
    const page = cursor === null ? 0 : Number(cursor);
    return { data: [thread(page < 5 ? { name: "[飞书] hidden" } : {})], nextCursor: String(page + 1) };
  });
  assert.deepEqual(await f.reader.list({ allProjects: true }), { threads: [], nextCursor: "5" });
  assert.equal(f.requests.filter(r => r.method === "thread/list").length, 5);
  const next = await f.reader.list({ allProjects: true, cursor: "5" });
  assert.equal(next.threads.length, 1);
  assert.equal(next.nextCursor, "6");
  assert.equal(f.connections.length, 2);
  assert.ok(f.connections.every(connection => connection.closed === 1));
});

test("filtered pages stop when the server runs out of history", async () => {
  const f = fixture((_method, { cursor }) => ({ data: [], nextCursor: cursor ? null : "last" }));
  assert.deepEqual(await f.reader.list({ projectPath }), { threads: [], nextCursor: null });
  assert.equal(f.requests.filter(r => r.method === "thread/list").length, 2);
});

test("multi-page cursor cycles are detected even when they return to the supplied cursor", async () => {
  for (const initial of [null, "seed"]) {
    let calls = 0;
    const f = fixture(() => ({ data: [], nextCursor: ["a", "b", initial || "a"][calls++] }));
    await assert.rejects(f.reader.list({ allProjects: true, cursor: initial }), /cursor cycle/);
    assert.equal(calls, 3);
    assert.equal(f.connections[0].closed, 1);
  }
});

test("a failure on a skipped page closes the shared connection and propagates the error", async () => {
  const error = new Error("history unavailable");
  const f = fixture((_method, { cursor }) => { if (cursor) throw error; return { data: [], nextCursor: "next" }; });
  await assert.rejects(f.reader.list({ allProjects: true }), actual => actual === error);
  assert.equal(f.connections[0].closed, 1);
});

test("one operation deadline covers skipped pages and prevents late replies from issuing more reads", async () => {
  let reply;
  const f = fixture((_method, { cursor }) => cursor
    ? new Promise(resolve => { reply = resolve; })
    : { data: [], nextCursor: "second" }, { timeoutMs: 40 });
  await assert.rejects(f.reader.list({ allProjects: true }), /timed out/);
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].closed, 1);
  reply({ data: [], nextCursor: "third" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.filter(r => r.method === "thread/list").length, 2);
});

test("the shared path normalizer exports canonical paths and exact comparison keys", () => {
  assert.deepEqual(historyProjectPath("\\\\?\\E:\\MYCODE\\repo\\.\\"), { path: "E:\\MYCODE\\repo", key: "e:\\mycode\\repo" });
  assert.deepEqual(historyProjectPath("E:/mycode/../repo/"), { path: "E:\\repo", key: "e:\\repo" });
  assert.deepEqual(historyProjectPath("\\\\?\\UNC\\HOST\\share\\repo\\"), {
    path: "\\\\HOST\\share\\repo", key: "\\\\host\\share\\repo",
  });
  assert.deepEqual(historyProjectPath("C:\\"), { path: "C:\\", key: "c:\\" });
  assert.deepEqual(historyProjectPath("/home/User/repo/../repo/"), { path: "/home/User/repo", key: "/home/User/repo" });
  assert.notEqual(historyProjectPath("/home/User").key, historyProjectPath("/home/user").key);
  for (const value of [undefined, null, 42, "", "relative", "C:relative", "C:\\invalid\0path"]) {
    assert.throws(() => historyProjectPath(value), /absolute path/);
  }
});

test("inspect returns canonical metadata only and never requests turns or changes the session", async () => {
  const f = fixture(() => ({ thread: thread({ cwd: "\\\\?\\E:\\MYCODE\\repo\\.\\", model: "model", projectId: "project",
    reasoningEffort: "high", turns: [{ items: [assistant("must not leak")] }] }) }));
  assert.deepEqual(await f.reader.inspect({ projectPath: "e:/mycode/repo/", threadId: "thread-1" }), {
    id: "thread-1", title: "历史会话", cwd: "E:\\MYCODE\\repo", status: "notLoaded",
  });
  assert.deepEqual(f.requests, [{ method: "initialize" },
    { method: "thread/read", params: { threadId: "thread-1", includeTurns: false } }]);
  assert.equal(f.connections[0].closed, 1);
});

test("inspect uses fresh metadata and rejects moved, renamed, subagent and mismatched threads", async () => {
  let metadata = thread();
  const f = fixture(() => ({ thread: metadata }));
  const selected = await f.reader.inspect({ projectPath, threadId: "thread-1" });
  for (const denied of [thread({ cwd: "F:\\other" }), thread({ cwd: `${projectPath}\\child` }),
    thread({ cwd: null }), thread({ cwd: "relative" }), thread({ id: "different" }), thread({ name: "[飞书] attached" }),
    thread({ source: "subAgentReview" }), thread({ source: { subAgent: {} } }), thread({ parentThreadId: "parent" }), null]) {
    metadata = denied;
    await assert.rejects(f.reader.inspect({ projectPath: selected.cwd, threadId: selected.id }), /unavailable/);
  }
  assert.ok(f.connections.every(connection => connection.closed === 1));
  assert.ok(f.requests.every(r => ["initialize", "thread/read"].includes(r.method)));
  assert.equal(f.requests.filter(r => r.method === "thread/read").length, 11);
});

test("inspect requires the selected project path and thread id even if allProjects is supplied", async () => {
  const f = fixture(() => assert.fail("unexpected history request"));
  for (const input of [undefined, "", "relative", null]) {
    await assert.rejects(f.reader.inspect({ projectPath: input, threadId: "thread-1", allProjects: true }), /absolute path/);
  }
  for (const threadId of [undefined, "", "  ", 42]) await assert.rejects(f.reader.inspect({ projectPath, threadId }), /threadId/);
  assert.ok(f.requests.every(r => r.method === "initialize"));
  assert.ok(f.connections.every(connection => connection.closed === 1));
});

test("inspect propagates metadata failures and closes the connection", async () => {
  const failure = Object.assign(new Error("metadata failed"), { rpcCode: -32000 });
  const f = fixture(() => { throw failure; });
  await assert.rejects(f.reader.inspect({ projectPath, threadId: "thread-1" }), error => error === failure);
  assert.equal(f.connections[0].closed, 1);
  assert.equal(f.requests.length, 2);
});

test("inspect is deadline-bounded and closes stalled metadata reads", async () => {
  const f = fixture(() => new Promise(() => {}), { timeoutMs: 25 });
  await assert.rejects(f.reader.inspect({ projectPath, threadId: "thread-1" }), /timed out/);
  assert.ok(f.connections.every(connection => connection.closed === 1));
  assert.deepEqual(f.requests.map(r => r.method), ["initialize", "thread/read"]);
});

test("inspect shares the serial queue and closes before the next list starts", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(async method => {
    if (method === "thread/read") { await blocked; return { thread: thread() }; }
    assert.equal(f.connections[0].closed, 1);
    return { data: [] };
  });
  const inspection = f.reader.inspect({ projectPath, threadId: "thread-1" });
  const listing = f.reader.list({ projectPath });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.connections.length, 1);
  release();
  await inspection;
  await listing;
  assert.equal(f.connections.length, 2);
  assert.ok(f.connections.every(connection => connection.closed === 1));
});
