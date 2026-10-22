import { createKeyedSerialExecutor } from "./bridge-core.mjs";

export function buildSteeringCard(task, notice = "") {
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "排队消息 · 引导" } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: `${task.prompt.slice(0, 1000)}\n\nsession=${task.sessionName}  ${task.taskId}` } },
      { tag: "div", text: { tag: "plain_text", content: notice || "点击引导，将这条消息提交给当前任务，不中断模型运行。不点击则继续排队。" } },
      ...(task.status === "pending" ? [{ tag: "action", actions: [{
        tag: "button", text: { tag: "plain_text", content: "引导" }, type: "primary",
        value: { bridge: "feishu-codex-bridge", action: "steer_task", taskId: task.taskId, scopeChatId: task.source.chatId },
      }] }] : []),
    ],
  };
}

// Steering runs outside the task queue. Hold a promoted message until delivery
// settles, so a completing turn cannot also dispatch it as a separate task.
export class TaskSteering {
  constructor({ tasks, controls, isCurrent = () => true }) {
    this.tasks = tasks;
    this.controls = controls;
    this.isCurrent = isCurrent;
    this.serialize = createKeyedSerialExecutor();
  }

  active(chatId, projectPath, sessionName) {
    return [...this.tasks.values()].find(task => task.status === "running" &&
      task.source.chatId === chatId && task.projectPath === projectPath &&
      task.sessionName === sessionName && this.isCurrent(task));
  }

  submit(target, prompt) {
    return this.serialize(target?.taskId, async () => {
      if (!prompt?.trim()) throw new Error("请输入补充要求，例如 /steer 请先完成测试。");
      if (!target || target.status !== "running" || !this.isCurrent(target)) {
        throw new Error("当前没有可引导的运行中任务；请先发送任务，或等待任务开始。");
      }
      const control = this.controls.get(target.taskId);
      if (!control?.steer) throw new Error("任务尚未就绪，或执行端不支持引导；请稍后重试。");
      const result = await control.steer(prompt);
      target.steerCount = (target.steerCount || 0) + 1;
      return { targetTaskId: target.taskId, ...result };
    });
  }

  promote(taskId, { chatId, senderId, messageId }) {
    const task = this.tasks.get(taskId);
    if (!task || task.source.chatId !== chatId || task.source.senderId !== senderId ||
        (messageId && task.steerCardMessageId !== messageId)) {
      return Promise.reject(new Error("这条排队消息不存在或不属于当前聊天和用户。"));
    }
    if (task.steeringDone) return task.steeringDone;
    if (task.status === "steered") return Promise.resolve({ targetTaskId: task.steeredTo, alreadySubmitted: true });
    if (task.status !== "pending" || !this.isCurrent(task)) return Promise.reject(new Error("消息已开始执行、已取消或会话已重置，不能再引导。"));
    if (task.imageKey) return Promise.reject(new Error("目前引导仅支持文字；图片消息继续排队执行。"));
    const target = this.tasks.get(task.steerTargetTaskId);
    if (!target || target.source.chatId !== task.source.chatId || target.projectPath !== task.projectPath ||
        target.sessionName !== task.sessionName) return Promise.reject(new Error("原任务已不可用，消息继续排队。"));
    // Set the hold synchronously, before the first asynchronous delivery step.
    const operation = Promise.resolve().then(() => this.submit(target, task.prompt)).then(result => {
      task.status = "steered";
      task.steeredTo = result.targetTaskId;
      task.finishedAt = Date.now();
      return result;
    }).catch(error => {
      // A lost acknowledgement must never cause automatic duplicate execution.
      if (error.steerOutcomeUnknown) task.status = "steer_unknown";
      throw error;
    }).finally(() => { task.steeringDone = null; });
    task.steeringDone = operation;
    return operation;
  }

  async claimForRun(task) {
    while (task.steeringDone) await task.steeringDone.catch(() => {});
    if (task.status !== "pending") return false;
    task.status = "running";
    return true;
  }
}
