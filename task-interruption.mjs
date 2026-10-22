const TERMINAL = new Set(["success", "failed", "cancelled", "interrupted", "steered"]);

export class TaskInterruption {
  constructor({ tasks, controls, pause, onChange = () => {}, onError = () => {}, isCurrent = () => true, confirmationTimeoutMs = 15_000 }) {
    this.tasks = tasks;
    this.controls = controls;
    this.pause = pause;
    this.onChange = onChange;
    this.isCurrent = isCurrent;
    this.onError = onError;
    this.confirmationTimeoutMs = confirmationTimeoutMs;
  }

  stop(taskId, { chatId, senderId, generation, messageId } = {}) {
    const task = this.tasks.get(taskId);
    if (!task || task.source.chatId !== chatId || (senderId && task.source.senderId && senderId !== task.source.senderId) ||
        (generation && generation !== task.generation) || (messageId && messageId !== task.statusMessageId)) {
      throw new Error("这条任务不属于当前聊天、用户，或卡片已经失效。");
    }
    if (!this.isCurrent(task)) throw new Error("这条会话已重置，旧任务卡片不能再操作。");
    if (TERMINAL.has(task.status)) return { notice: "任务已结束，无需停止。", alreadyFinished: true };
    if (task.status === "stopping" && !task.stopError) return { notice: "正在停止当前任务…", pending: true };
    if (["pending", "steer_unknown"].includes(task.status) && !task.steeringDone) {
      task.status = "cancelled";
      task.finishedAt = Date.now();
      this.onChange(task);
      return { notice: "已取消排队。", cancelled: true };
    }
    if (task.steeringDone) throw new Error("这条消息正在提交引导，请等待回执后再操作。");
    this.pause(task);
    const control = this.controls.get(taskId);
    if (control && !control.interrupt) throw new Error("当前执行端暂不支持停止，请在客户端停止。");
    task.status = "stopping";
    task.stopRequested = true;
    task.stopError = "";
    this.onChange(task);
    if (control?.interrupt) {
      clearTimeout(task.stopTimer);
      task.stopOperation = Promise.resolve().then(() => control.interrupt()).then(() => {
        if (task.status !== "stopping") return;
        task.stopTimer = setTimeout(() => {
          if (task.status !== "stopping") return;
          task.stopError = "已发送停止请求，但暂未确认结果。可以重试，或在客户端检查。";
          this.onChange(task);
        }, this.confirmationTimeoutMs);
        task.stopTimer.unref?.();
      }).catch(error => {
        if (TERMINAL.has(task.status)) return;
        task.status = "running";
        task.stopRequested = false;
        task.stopError = error.message;
        this.onError(task, error);
        // A failed request may already have reached Desktop. Leave the queue
        // paused and allow the next click to retry against the same turn.
        this.onChange(task);
      }).finally(() => { task.stopOperation = null; });
    }
    // Before the backend control is attached, run() consumes stopRequested and
    // cancels preparation without submitting a model turn.
    return { notice: "正在停止当前任务…", pending: true };
  }

  finish(task) { clearTimeout(task.stopTimer); }
}
