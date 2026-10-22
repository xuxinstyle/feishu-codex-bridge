import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskSteering, buildSteeringCard } from "../task-steering.mjs";

function fixture(steer = async () => ({ turnId: "turn-a" })) {
  const target = { taskId: "task-a", source: { chatId: "chat", senderId: "user" }, projectPath: "repo", sessionName: "default", status: "running" };
  const queued = { ...target, taskId: "task-b", status: "pending", prompt: "先完成测试", steerTargetTaskId: "task-a", steerCardMessageId: "card" };
  const tasks = new Map([[target.taskId, target], [queued.taskId, queued]]);
  const controls = new Map([[target.taskId, { steer }]]);
  const steering = new TaskSteering({ tasks, controls });
  const scope = { chatId: "chat", senderId: "user", messageId: "card" };
  return { target, queued, tasks, controls, steering, scope };
}

test("promotion holds the queue and duplicate clicks share one delivery", async () => {
  let finish, calls = 0;
  const f = fixture(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = f.steering.promote("task-b", f.scope);
  assert.equal(f.steering.promote("task-b", f.scope), first);
  let released = false;
  const run = f.steering.claimForRun(f.queued).then(result => { released = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false);
  finish({ turnId: "turn-a" });
  assert.equal((await first).targetTaskId, "task-a");
  assert.equal(await run, false);
  assert.equal(f.queued.status, "steered");
  assert.equal(f.target.status, "running");
  assert.equal((await f.steering.promote("task-b", f.scope)).alreadySubmitted, true);
  assert.equal(calls, 1);
});

test("known rejection releases the message to normal queue execution", async () => {
  const f = fixture(async () => { throw new Error("turn ended"); });
  const submit = f.steering.promote("task-b", f.scope);
  const run = f.steering.claimForRun(f.queued);
  await assert.rejects(submit, /turn ended/);
  assert.equal(await run, true);
  assert.equal(f.queued.status, "running");
  await assert.rejects(f.steering.promote("task-b", f.scope), /已开始执行/);
});

test("unknown delivery never automatically runs the queued prompt again", async () => {
  const f = fixture(async () => { throw Object.assign(new Error("lost acknowledgement"), { steerOutcomeUnknown: true }); });
  await assert.rejects(f.steering.promote("task-b", f.scope), /lost acknowledgement/);
  assert.equal(await f.steering.claimForRun(f.queued), false);
  assert.equal(f.queued.status, "steer_unknown");
});

test("old cards cannot steer a new running task after the original completes", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; });
  f.target.status = "success";
  f.tasks.set("task-new", { ...f.target, taskId: "task-new", status: "running" });
  await assert.rejects(f.steering.promote("task-b", f.scope), /没有可引导/);
  assert.equal(calls, 0);
  assert.equal(f.queued.status, "pending");
});

test("promotion validates sender, chat, card, session and reset generation", async () => {
  const f = fixture();
  for (const scope of [{ ...f.scope, senderId: "other" }, { ...f.scope, chatId: "other" }, { ...f.scope, messageId: "old-card" }]) {
    await assert.rejects(f.steering.promote("task-b", scope), /不属于/);
  }
  f.target.sessionName = "other";
  await assert.rejects(f.steering.promote("task-b", f.scope), /原任务已不可用/);
  f.target.sessionName = "default";
  f.steering.isCurrent = () => false;
  await assert.rejects(f.steering.promote("task-b", f.scope), /会话已重置/);
  assert.equal(f.steering.active("chat", "repo", "default"), undefined);
});

test("direct steering is scoped and serial, without adding a queued task", async () => {
  const order = [];
  const f = fixture(async prompt => { order.push(prompt); });
  assert.equal(f.steering.active("other", "repo", "default"), undefined);
  assert.equal(f.steering.active("chat", "other", "default"), undefined);
  const active = f.steering.active("chat", "repo", "default");
  await Promise.all([f.steering.submit(active, "一"), f.steering.submit(active, "二")]);
  assert.deepEqual(order, ["一", "二"]);
  assert.equal(f.tasks.size, 2);
  assert.equal(active.steerCount, 2);
});

test("empty input and unready tasks are rejected without queue changes", async () => {
  const f = fixture();
  await assert.rejects(f.steering.submit(f.target, " "), /请输入/);
  f.controls.clear();
  await assert.rejects(f.steering.promote("task-b", f.scope), /尚未就绪/);
  assert.equal(f.queued.status, "pending");
});

test("queue card exposes steering only until the message leaves the queue", () => {
  const f = fixture();
  const card = buildSteeringCard(f.queued);
  assert.equal(card.elements.at(-1).actions[0].text.content, "引导");
  f.queued.status = "steered";
  assert.ok(!buildSteeringCard(f.queued, "已提交").elements.some(e => e.tag === "action"));
});

test("image messages remain queued and cancelled messages never start", async () => {
  const f = fixture();
  f.queued.imageKey = "image";
  await assert.rejects(f.steering.promote("task-b", f.scope), /仅支持文字/);
  assert.equal(f.queued.status, "pending");
  f.queued.status = "cancelled";
  assert.equal(await f.steering.claimForRun(f.queued), false);
});
