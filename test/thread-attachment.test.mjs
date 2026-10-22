import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectAttachmentRuntime } from "../thread-attachment.mjs";

const thread = { id: "original-thread", cwd: "E:\\repo", title: "原会话" };
const inspect = (result, options = {}) => inspectAttachmentRuntime(thread, { pipePath: "local-test", callTool: async (...args) => {
  assert.equal(args[1], thread.id);
  assert.equal(args[2], "read_thread");
  assert.deepEqual(args[3], { threadId: thread.id, hostId: "local", turnLimit: 1 });
  return result;
}, ...options });

test("attachment probes Desktop read-only and accepts only the exact local idle thread", async () => {
  const result = { thread: { id: thread.id, cwd: "\\\\?\\E:\\REPO\\", status: { type: "idle" } }, turns: [{ status: "completed" }] };
  assert.deepEqual(await inspect(result), thread);
  assert.deepEqual(await inspect({ ...result, thread: { ...result.thread, status: { type: "notLoaded" } } }), thread);
});

test("active turns, unknown runtime states, changed IDs and changed directories cannot attach", async () => {
  const idle = { ...thread, status: { type: "idle" } };
  for (const result of [
    { thread: { ...idle, status: { type: "active" } } },
    { thread: idle, turns: [{ status: "inProgress" }] },
    { thread: { ...idle, status: { type: "systemError" } } },
    { thread: { ...idle, status: null } },
    { thread: { ...idle, cwd: "E:\\repo-other" } },
    { thread: { ...idle, id: "replacement" } },
    { thread: { ...idle, cwd: undefined } },
    {},
  ]) await assert.rejects(inspect(result));
});

test("missing Desktop and failed inspection never turn into a new thread", async () => {
  let calls = 0;
  await assert.rejects(inspect({}, { pipePath: null, callTool: async () => { calls++; } }), /打开 Codex/);
  assert.equal(calls, 0);
  await assert.rejects(inspect({}, { callTool: async () => { calls++; throw new Error("read failed"); } }), /read failed/);
  assert.equal(calls, 1);
});
