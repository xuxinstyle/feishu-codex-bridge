// Bind stop intent to the exact turn created by this submission, never "latest".
export class TurnInterrupt {
  constructor(send) {
    this.send = send;
    this.requested = false;
    this.submitting = false;
    this.finished = false;
    this.target = null;
    this.promise = null;
    this.sent = false;
    this.acknowledged = false;
  }
  request() {
    if (this.finished) return Promise.resolve({ alreadyFinished: true });
    this.requested = true;
    if (!this.submitting) return Promise.resolve({ beforeSubmission: true });
    if (this.acknowledged) { this.promise = null; this.sent = false; this.acknowledged = false; }
    if (!this.promise) {
      this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
      this.flush();
    }
    return this.promise;
  }
  beginSubmission() {
    if (this.requested) return false;
    this.submitting = true;
    return true;
  }
  observe(threadId, turnId) {
    if (!this.target) this.target = { threadId, turnId };
    this.flush();
  }
  flush() {
    if (!this.requested || !this.target || !this.promise || this.sent || this.finished) return;
    this.sent = true;
    Promise.resolve().then(() => this.send(this.target.threadId, this.target.turnId)).then(result => {
      this.acknowledged = true;
      this.resolve(result);
    }).catch(error => {
      this.reject(error);
      this.requested = false;
      this.sent = false;
      this.promise = null;
    });
  }
  finish() {
    this.finished = true;
    this.resolve?.({ alreadyFinished: true });
  }
}
