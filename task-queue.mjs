export class SessionTaskQueue {
  constructor({ run, onError = () => {}, onChange = () => {}, paused = [] }) {
    this.run = run;
    this.onError = onError;
    this.onChange = onChange;
    this.paused = new Set(paused);
    this.entries = new Map();
  }

  enqueue(scope, task, { priority = false } = {}) {
    let entry = this.entries.get(scope);
    if (!entry) this.entries.set(scope, entry = { pending: [], active: false, promise: Promise.resolve() });
    const item = { task, priority };
    entry.pending.push(item);
    this.drain(scope);
    return entry.promise;
  }

  drain(scope) {
    const entry = this.entries.get(scope);
    if (!entry || entry.active) return;
    const index = this.paused.has(scope) ? entry.pending.findIndex(item => item.priority) : 0;
    if (!entry.pending.length || index < 0) return;
    const [{ task }] = entry.pending.splice(index, 1);
    entry.active = true;
    entry.promise = Promise.resolve().then(() => this.run(task)).catch(error => this.onError(error, task)).finally(() => {
      entry.active = false;
      this.drain(scope);
    });
  }

  pause(scope) { this.paused.add(scope); this.onChange(); }
  resume(scope) { this.paused.delete(scope); this.onChange(); this.drain(scope); }
  isPaused(scope) { return this.paused.has(scope); }
  snapshot() { return [...this.paused]; }
  queued(scope) { return (this.entries.get(scope)?.pending || []).map(item => item.task).filter(task => task.status === "pending"); }
  async idle(scope) {
    const entry = this.entries.get(scope);
    while (entry?.active) await entry.promise;
  }
}
