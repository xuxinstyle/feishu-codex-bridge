import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnInterrupt } from "../turn-interrupt.mjs";
import { TaskInterruption } from "../task-interruption.mjs";
import { SessionTaskQueue } from "../task-queue.mjs";

test("a stop before submission prevents a new model turn", async () => {
  const control = new TurnInterrupt(() => { throw new Error("must not send"); });
  assert.deepEqual(await control.request(), { beforeSubmission: true });
  assert.equal(control.beginSubmission(), false);
});

test("stop during submission waits for the exact turn and repeated requests share delivery", async () => {
  const calls = [];
  const control = new TurnInterrupt(async (...args) => { calls.push(args); return { ok: true }; });
  control.beginSubmission();
  const one = control.request(), two = control.request();
  assert.equal(one, two);
  assert.equal(calls.length, 0);
  control.observe("thread-a", "turn-a");
  control.observe("thread-a", "turn-b");
  await one;
  assert.deepEqual(calls, [["thread-a", "turn-a"]]);
});

test("a completed turn is not interrupted by an earlier stop intent", async () => {
  let calls = 0;
  const control = new TurnInterrupt(() => { calls++; });
  control.beginSubmission();
  const request = control.request();
  control.finish();
  control.observe("thread", "old-turn");
  assert.deepEqual(await request, { alreadyFinished: true });
  assert.equal(calls, 0);
});

test("stop errors can be retried without changing the target turn", async () => {
  let calls = 0;
  const control = new TurnInterrupt(async (_thread, turn) => { assert.equal(turn, "turn-a"); if (!calls++) throw new Error("offline"); return {}; });
  control.beginSubmission(); control.observe("thread", "turn-a");
  await assert.rejects(control.request(), /offline/);
  await control.request();
  assert.equal(calls, 2);
});

function taskFixture() {
  const task = { taskId: "task-a", source: { chatId: "chat", senderId: "user" }, generation: "attempt-a", status: "running", statusMessageId: "card" };
  const tasks = new Map([[task.taskId, task]]), controls = new Map();
  let paused = 0;
  const control = new TaskInterruption({ tasks, controls, pause: () => paused++, isCurrent: () => true });
  return { task, tasks, controls, control, get paused() { return paused; } };
}

test("stop pauses its queue immediately but does not claim success before engine confirmation", async () => {
  const f = taskFixture();
  let finish;
  f.controls.set("task-a", { interrupt: () => new Promise(resolve => { finish = resolve; }) });
  const actor = { chatId: "chat", senderId: "user", generation: "attempt-a", messageId: "card" };
  f.control.stop("task-a", actor);
  f.control.stop("task-a", actor);
  assert.equal(f.task.status, "stopping");
  assert.equal(f.paused, 1);
  await Promise.resolve();
  finish({ ok: true });
  await f.task.stopOperation;
  assert.equal(f.task.status, "stopping");
});

test("old cards, other chats and other senders cannot stop a task", () => {
  const f = taskFixture();
  for (const actor of [{ chatId: "other" }, { chatId: "chat", senderId: "other" }, { chatId: "chat", generation: "old" }, { chatId: "chat", messageId: "old-card" }]) {
    assert.throws(() => f.control.stop("task-a", actor), /不属于|失效/);
  }
  assert.equal(f.task.status, "running");
});

test("a failed interruption leaves the queue paused and the task available to retry", async () => {
  const f = taskFixture();
  f.controls.set("task-a", { interrupt: async () => { throw new Error("no owner"); } });
  f.control.stop("task-a", { chatId: "chat" });
  await f.task.stopOperation;
  assert.equal(f.task.status, "running");
  assert.equal(f.task.stopRequested, false);
  assert.equal(f.task.stopError, "no owner");
  assert.equal(f.paused, 1);
});

test("cancelling a queued or uncertain steering message never interrupts the running task", () => {
  for (const status of ["pending", "steer_unknown"]) {
    const f = taskFixture(); f.task.status = status;
    f.control.stop("task-a", { chatId: "chat" });
    assert.equal(f.task.status, "cancelled");
    assert.equal(f.paused, 0);
  }
});

test("an accepted stop that never reaches a terminal state offers retry without claiming completion", async () => {
  const task = { taskId: "task", source: { chatId: "chat" }, status: "running" };
  const control = new TaskInterruption({ tasks: new Map([[task.taskId, task]]), controls: new Map([[task.taskId, { interrupt: async () => ({ ok: true }) }]]),
    pause: () => {}, confirmationTimeoutMs: 10 });
  control.stop("task", { chatId: "chat" }); await task.stopOperation;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(task.status, "stopping");
  assert.ok(task.stopError);
  control.finish(task);
});

test("a normal completion wins a race with an unsuccessful stop reply", async () => {
  const f = taskFixture(); let reject;
  f.controls.set("task-a", { interrupt: () => new Promise((_resolve, fail) => { reject = fail; }) });
  f.control.stop("task-a", { chatId: "chat" }); await Promise.resolve();
  f.task.status = "success"; reject(new Error("turn ended")); await f.task.stopOperation;
  assert.equal(f.task.status, "success");
  assert.equal(f.task.stopError, "");
});

test("stopping one session pauses old work while allowing explicit new work and other sessions", async () => {
  const events = [];
  let finish;
  const queue = new SessionTaskQueue({ run: async task => {
    events.push(task);
    if (task === "active") await new Promise(resolve => { finish = resolve; });
  } });
  queue.enqueue("a", "active");
  queue.enqueue("a", "old-next");
  await Promise.resolve();
  queue.pause("a"); finish();
  await queue.idle("a");
  assert.deepEqual(events, ["active"]);
  queue.enqueue("a", "explicit-new", { priority: true });
  queue.enqueue("b", "independent");
  await Promise.all([queue.idle("a"), queue.idle("b")]);
  assert.ok(events.includes("explicit-new") && events.includes("independent"));
  assert.ok(!events.includes("old-next"));
  queue.resume("a"); await queue.idle("a");
  assert.equal(events.at(-1), "old-next");
});
