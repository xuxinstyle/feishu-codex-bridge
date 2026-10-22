import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPanelCard, buildTaskCard } from "../feishu-cards.mjs";

const task = { taskId: "task-private", source: { chatId: "chat" }, generation: "attempt", sessionName: "default", projectPath: "D:\\repo", prompt: "检查接口并运行测试", status: "running", startedAt: 1000 };
const state = { chatId: "chat", projectPath: "D:\\repo", projectLabel: "接口服务", sessionName: "default", task,
  model: "gpt-6.1-sol", reasoning: "high", reasoningChoices: ["low", "high"], queued: [], sessions: [{ name: "default", status: "running" }],
  models: ["gpt-6.1-sol", "grok-4.6"], projects: Array.from({ length: 17 }, (_, i) => ({ alias: `项目${i}`, path: `D:\\p${i}` })),
};
const visible = card => JSON.stringify(card, (key, value) => key === "value" ? undefined : value);
const buttons = card => card.elements.flatMap(e => e.actions || []);

test("the home card removes paths, ids and model lists while retaining navigation", () => {
  const card = buildPanelCard(state), text = visible(card);
  assert.ok(text.includes("停止当前任务"));
  assert.ok(text.includes("设置"));
  assert.ok(!text.includes("task-private") && !text.includes("D:\\\\repo") && !text.includes("gpt-6.1-sol"));
  assert.ok(buttons(card).length <= 6);
  assert.ok(card.elements.filter(e => e.tag === "action").every(e => e.actions.length <= 2));
});

test("settings remain available on demand instead of crowding the home card", () => {
  const card = buildPanelCard({ ...state, view: "settings" });
  assert.ok(visible(card).includes("gpt-6.1-sol"));
  assert.ok(buttons(card).some(b => b.value.action === "show_models"));
  assert.ok(buttons(card).find(b => b.value.action === "reset_active_session").confirm);
});

test("project pagination reaches entries beyond the original first eight", () => {
  const first = buildPanelCard({ ...state, view: "projects", page: 0 });
  const last = buildPanelCard({ ...state, view: "projects", page: 2 });
  assert.equal(buttons(first).filter(b => b.value.action === "set_project").length, 8);
  assert.ok(buttons(first).some(b => b.text.content === "下一页"));
  assert.ok(buttons(last).some(b => b.value.targetProjectPath === "D:\\p16"));
});

test("the stop action targets a task generation and never asks for a redundant confirmation", () => {
  const button = buttons(buildTaskCard(task)).find(b => b.value.action === "stop_task");
  assert.equal(button.value.taskId, task.taskId);
  assert.equal(button.value.generation, task.generation);
  assert.equal(button.confirm, undefined);
  assert.ok(!buttons(buildTaskCard({ ...task, status: "stopping" })).some(b => b.value.action === "stop_task"));
});

test("stopped cards offer continuation once and explain the paused queue", () => {
  const card = buildTaskCard({ ...task, status: "interrupted" }, { paused: true, pendingCount: 2 });
  assert.ok(visible(card).includes("待办已暂停"));
  assert.ok(buttons(card).some(b => b.value.action === "resume_task"));
  assert.ok(!buttons(buildTaskCard({ ...task, status: "interrupted", resumedAs: "new" })).some(b => b.value.action === "resume_task"));
});

test("queued steering remains a single task card with two clear choices", () => {
  const card = buildTaskCard({ ...task, status: "pending", steerTargetTaskId: "active" });
  assert.deepEqual(buttons(card).map(b => b.value.action), ["steer_task", "stop_task"]);
});

test("cancelled queue cards do not claim that the task is still preparing", () => {
  const card = buildTaskCard({ ...task, status: "cancelled", startedAt: null });
  assert.ok(!visible(card).includes("正在准备"));
});
