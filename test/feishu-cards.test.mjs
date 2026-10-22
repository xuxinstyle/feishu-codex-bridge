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

test("the home card shows current configuration and complete navigation without private identifiers", () => {
  const card = buildPanelCard(state), text = visible(card);
  assert.ok(text.includes("停止当前任务"));
  assert.ok(text.includes("设置"));
  assert.ok(!text.includes("task-private") && !text.includes("D:\\\\repo"));
  assert.ok(text.includes("gpt-6.1-sol") && text.includes("推理高"));
  assert.ok(!text.includes("grok-4.6"));
  assert.deepEqual(buttons(card).map(b => b.value.action), [
    "stop_task", "show_projects", "show_sessions", "new_session", "show_queue", "show_settings", "show_help",
  ]);
  assert.ok(card.elements.filter(e => e.tag === "action").every(e => e.actions.length <= 2));
});

test("empty and stopped home cards keep navigation and only offer valid task actions", () => {
  const empty = buildPanelCard({ ...state, task: null });
  assert.ok(visible(empty).includes("直接发送消息"));
  assert.ok(buttons(empty).some(b => b.text.content === "待办 0"));
  assert.ok(!buttons(empty).some(b => b.value.action === "stop_task"));
  assert.ok(buttons(buildPanelCard({ ...state, task: { ...task, status: "interrupted" } })).some(b => b.value.action === "resume_task"));
  assert.ok(!buttons(buildPanelCard({ ...state, task: { ...task, status: "interrupted", resumedAs: "new" } })).some(b => b.value.action === "resume_task"));
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
  assert.equal(buttons(last).find(b => b.value.action === "refresh").value.view, "projects");
  assert.equal(buttons(last).find(b => b.value.action === "refresh").value.page, 2);
});

test("session pagination reaches every session and shows useful task summaries", () => {
  const sessions = Array.from({ length: 19 }, (_, i) => ({ name: `会话${i}`, status: "success", summary: `处理接口 ${i}` }));
  const seen = [];
  for (let page = 0; page < 3; page++) {
    const card = buildPanelCard({ ...state, sessions, view: "sessions", page });
    const choices = buttons(card).filter(b => b.value.action === "use_session");
    assert.ok(choices.length <= 8);
    assert.ok(choices.every(b => b.value.page === page && b.text.content.includes("处理接口")));
    seen.push(...choices.map(b => b.value.sessionName));
    assert.equal(buttons(card).some(b => b.text.content === "下一页"), page < 2);
  }
  assert.deepEqual(seen, sessions.map(s => s.name));
});

test("queue pagination reaches all items and cancellation keeps the current page", () => {
  const queued = Array.from({ length: 14 }, (_, i) => ({ taskId: `queued-${i}`, generation: `g-${i}`, prompt: `待办内容 ${i}` }));
  const second = buildPanelCard({ ...state, view: "queue", page: 1, queued, paused: true });
  const cancel = buttons(second).filter(b => b.value.action === "stop_task");
  assert.deepEqual(cancel.map(b => b.value.taskId), queued.slice(6, 12).map(t => t.taskId));
  assert.ok(cancel.every(b => b.value.page === 1 && b.value.view === "queue"));
  assert.ok(buttons(second).some(b => b.value.action === "resume_queue"));
  const clamped = buildPanelCard({ ...state, view: "queue", page: 20, queued });
  assert.deepEqual(buttons(clamped).filter(b => b.value.action === "stop_task").map(b => b.value.taskId), ["queued-12", "queued-13"]);
  const afterCancellation = buildPanelCard({ ...state, view: "queue", page: 2, queued: queued.slice(0, 12) });
  assert.ok(buttons(afterCancellation).filter(b => b.value.action === "stop_task").every(b => b.value.page === 1));
});

test("subpages give explicit return destinations", () => {
  for (const view of ["projects", "sessions", "queue", "settings", "help"]) {
    assert.ok(buttons(buildPanelCard({ ...state, view })).some(b => b.text.content === "返回首页" && b.value.action === "show_home"));
  }
  for (const view of ["models", "reasoning"]) {
    assert.ok(buttons(buildPanelCard({ ...state, view })).some(b => b.text.content === "返回设置" && b.value.action === "show_settings"));
  }
});

test("help explains task continuation, steering and independent sessions", () => {
  const text = visible(buildPanelCard({ ...state, view: "help" }));
  for (const phrase of ["文字或图片", "/stop", "/resume", "新一轮", "已完成的修改不会撤销", "/steer", "新建会话", "独立上下文"]) {
    assert.ok(text.includes(phrase), phrase);
  }
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
