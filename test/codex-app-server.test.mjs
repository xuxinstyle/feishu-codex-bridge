import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  APP_SERVER_SESSION_BACKEND, canResumeAppServerSession, desktopCodexBinary, matchingProjectId, resolveAppServerProjectId, runAppServerTask,
} from "../codex-app-server.mjs";

class FakeChild extends EventEmitter {
  constructor(handle) {
    super();
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        queueMicrotask(() => handle(JSON.parse(line), this));
      }
      callback();
    } });
  }
  send(message) { this.stdout.write(JSON.stringify(message) + "\n"); }
  reply(request, result) { this.send({ id: request.id, result }); }
  notify(method, params) { this.send({ method, params: { threadId: "thread-a", ...params } }); }
  kill() { this.killed = true; this.emit("close", 0); }
}

function setup({ onTurn, onRequest, onSpawn } = {}) {
  const requests = [];
  let child;
  const options = { command: "test-codex", cwd: process.cwd(), prompt: "你好", timeoutMs: 1000,
    spawnImpl: (command, args, opts) => {
      onSpawn?.(command, args, opts);
      child = new FakeChild((request, proc) => {
        requests.push(request);
        if (onRequest?.(request, proc)) return;
        if (request.method === "initialize") proc.reply(request, {});
        else if (request.method === "project/list") proc.reply(request, { data: [{ id: "project-a", roots: [{ path: process.cwd() }] }], nextCursor: null });
        else if (request.method === "thread/metadata/update") proc.reply(request, {});
        else if (["thread/start", "thread/resume"].includes(request.method)) {
          proc.reply(request, { thread: { id: "thread-a", projectId: "project-a", status: { type: "idle" } } });
        } else if (request.method === "thread/name/set") proc.reply(request, {});
        else if (request.method === "turn/start") {
          proc.reply(request, { turn: { id: "turn-a" } });
          onTurn?.(proc);
        }
      });
      return child;
    } };
  return { options, requests, get child() { return child; } };
}

function complete(proc, text = "你好", status = "completed", error = null) {
  proc.notify("item/completed", { turnId: "turn-a", item: { type: "agentMessage", id: "message-a", text } });
  proc.notify("turn/completed", { turn: { id: "turn-a", status, error } });
}

test("new tasks create durable user threads and persist the binding before starting input", async () => {
  let bound = false;
  const f = setup({ onRequest: (r) => { if (r.method === "turn/start") assert.ok(bound); }, onTurn: (p) => {
    // Split a multibyte Chinese character across stdout chunks.
    const data = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "message-a", delta: "你好" } }) + "\n");
    const split = data.indexOf(Buffer.from("你好")) + 1;
    p.stdout.write(data.subarray(0, split)); p.stdout.write(data.subarray(split));
    complete(p);
  } });
  const outputs = [];
  const result = await runAppServerTask({ ...f.options, name: "[飞书] 项目", imagePath: "C:\\图片.png", onThread: () => { bound = true; }, onOutput: x => outputs.push(x) });
  assert.equal(result.output, "你好");
  assert.deepEqual(outputs, ["你好", "你好"]);
  const start = f.requests.find(r => r.method === "thread/start").params;
  assert.equal(start.ephemeral, false);
  assert.equal(start.threadSource, "user");
  assert.equal(start.projectId, "project-a");
  const input = f.requests.find(r => r.method === "turn/start").params.input;
  assert.deepEqual(input, [{ type: "text", text: "你好", text_elements: [] }, { type: "localImage", path: "C:\\图片.png" }]);
  assert.ok(f.child.killed);
});

test("only new backend bindings with matching models resume; old exec bindings start fresh", () => {
  assert.equal(canResumeAppServerSession({ threadId: "old", model: "m" }, "m"), false);
  assert.equal(canResumeAppServerSession({ threadId: "new", model: "m", backend: APP_SERVER_SESSION_BACKEND }, "m"), true);
  assert.equal(canResumeAppServerSession({ threadId: "new", model: "m", backend: APP_SERVER_SESSION_BACKEND }, "other"), false);
});

test("follow-up tasks resume the same thread and ignore notifications from other threads", async () => {
  const f = setup({ onTurn: p => {
    p.notify("item/completed", { threadId: "another", item: { type: "agentMessage", id: "wrong", text: "wrong" } });
    complete(p, "延续上下文");
  } });
  const result = await runAppServerTask({ ...f.options, threadId: "thread-a", model: "m", effort: "high" });
  assert.equal(result.output, "延续上下文");
  assert.ok(!f.requests.some(r => r.method === "thread/start" || r.method === "thread/name/set"));
  assert.equal(f.requests.find(r => r.method === "thread/resume").params.excludeTurns, true);
  assert.equal(f.requests.find(r => r.method === "turn/start").params.effort, "high");
});

test("turn failure rejects even when partial output was emitted", async () => {
  const f = setup({ onTurn: p => complete(p, "部分内容", "failed", { message: "provider unavailable" }) });
  await assert.rejects(runAppServerTask(f.options), /provider unavailable/);
  assert.ok(f.child.killed);
});

test("active desktop threads are refused instead of adding input to their running turn", async () => {
  const f = setup({ onRequest: (r, p) => {
    if (r.method !== "thread/resume") return false;
    p.reply(r, { thread: { id: "thread-a", status: { type: "active" } } }); return true;
  } });
  await assert.rejects(runAppServerTask({ ...f.options, threadId: "thread-a" }), /正在 Codex 客户端执行/);
  assert.ok(!f.requests.some(r => r.method === "turn/start"));
});

test("cancel interrupts the engine before closing transport", async () => {
  let control;
  const f = setup({ onTurn: () => setTimeout(() => control.cancel(), 0), onRequest: (r, p) => {
    if (r.method !== "turn/interrupt") return false;
    assert.ok(!p.killed);
    p.reply(r, {}); return true;
  } });
  await assert.rejects(runAppServerTask({ ...f.options, onControl: c => { control = c; } }), /cancelled/);
  assert.ok(f.requests.some(r => r.method === "turn/interrupt"));
  assert.equal(control, null);
  assert.ok(f.child.killed);
});

test("steering appends requirements to the same turn without interrupting or starting a second turn", async () => {
  let control, delivered;
  const f = setup({ onTurn: () => { setImmediate(() => { delivered = control.steer("请先测试"); }); }, onRequest: (r, p) => {
    if (r.method !== "turn/steer") return false;
    assert.equal(r.params.expectedTurnId, "turn-a");
    assert.equal(r.params.threadId, "thread-a");
    assert.equal(r.params.input[0].text, "请先测试");
    assert.equal(r.params.model, undefined);
    p.reply(r, { turnId: "turn-a" });
    complete(p, "已结合补充要求完成");
    return true;
  } });
  const result = await runAppServerTask({ ...f.options, onControl: c => { control = c; } });
  assert.equal((await delivered).turnId, result.turn.id);
  assert.equal(f.requests.filter(r => r.method === "turn/start").length, 1);
  assert.ok(!f.requests.some(r => r.method === "turn/interrupt"));
});

test("a steering rejection leaves the original turn running", async () => {
  let control, rejected;
  const f = setup({ onTurn: () => { setImmediate(() => { rejected = assert.rejects(control.steer("补充"), error => error.steerOutcomeUnknown === false); }); }, onRequest: (r, p) => {
    if (r.method !== "turn/steer") return false;
    p.send({ id: r.id, error: { code: -32602, message: "turn mismatch" } });
    complete(p);
    return true;
  } });
  await runAppServerTask({ ...f.options, onControl: c => { control = c; } });
  await rejected;
  assert.ok(!f.requests.some(r => r.method === "turn/interrupt"));
});

test("timeout during initialize stops the process with a useful timeout error", async () => {
  const f = setup({ onRequest: r => r.method === "initialize" });
  await assert.rejects(runAppServerTask({ ...f.options, timeoutMs: 20 }), /timeout after/);
  assert.ok(f.child.killed);
});

test("interactive server requests fail clearly without automatic approval", async () => {
  const f = setup({ onTurn: p => p.send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} }), onRequest: (r, p) => {
    if (r.method === "turn/interrupt") { p.reply(r, {}); return true; }
  } });
  await assert.rejects(runAppServerTask(f.options), /飞书暂不支持交互请求/);
  const response = f.requests.find(r => r.id === "approval-1");
  assert.ok(response.error);
  assert.equal(response.result, undefined);
});

test("bundled engine is preferred on Windows while explicit paths are preserved", () => {
  const opts = { platform: "win32", home: "C:\\Users\\test", exists: () => true };
  assert.match(desktopCodexBinary("codex", opts), /current[\\/]codex\.exe$/);
  assert.equal(desktopCodexBinary("E:\\custom\\codex.exe", opts), "E:\\custom\\codex.exe");
  assert.equal(desktopCodexBinary("codex", { ...opts, exists: () => false }), "codex");
});

test("project membership uses the closest root and normalizes Windows path prefixes and case", () => {
  const projects = [
    { id: "parent", roots: [{ path: "D:\\token_hub" }] },
    { id: "nested", roots: [{ path: "D:\\token_hub\\token_hub" }] },
  ];
  assert.equal(matchingProjectId(projects, "\\\\?\\d:\\TOKEN_HUB\\"), "parent");
  assert.equal(matchingProjectId(projects, "D:/token_hub/token_hub/src"), "nested");
  assert.equal(matchingProjectId(projects, "D:\\token_hub_other"), null);
  assert.equal(matchingProjectId(projects, "E:\\elsewhere"), null);
});

test("project lookup searches every page before choosing a root", async () => {
  let calls = 0;
  const rpc = { request: async (method, params) => {
    assert.equal(method, "project/list");
    calls++;
    return params.cursor ? { data: [{ id: "match", roots: [{ path: "D:\\repo" }] }], nextCursor: null }
      : { data: [], nextCursor: "page-2" };
  } };
  assert.equal(await resolveAppServerProjectId(rpc, "D:\\repo"), "match");
  assert.equal(calls, 2);
});

test("existing unassigned sessions get project membership before the next turn", async () => {
  const f = setup({ onRequest: (r, p) => {
    if (r.method !== "thread/resume") return false;
    p.reply(r, { thread: { id: "thread-a", projectId: null, status: { type: "idle" } } }); return true;
  }, onTurn: p => complete(p) });
  await runAppServerTask({ ...f.options, threadId: "thread-a" });
  const update = f.requests.findIndex(r => r.method === "thread/metadata/update");
  const start = f.requests.findIndex(r => r.method === "turn/start");
  assert.ok(update >= 0 && update < start);
  assert.equal(f.requests[update].params.projectId, "project-a");
});

test("existing user-selected project assignments are preserved", async () => {
  const f = setup({ onTurn: p => complete(p) });
  await runAppServerTask({ ...f.options, threadId: "thread-a" });
  assert.ok(!f.requests.some(r => ["project/list", "thread/metadata/update"].includes(r.method)));
});
