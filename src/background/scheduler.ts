export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => work());
    this.tail = next.catch(() => {});
    return next;
  }
}

// One timer and one tick at a time. An undefined delay means no active work.
export class WorkerPump {
  private timer?: ReturnType<typeof setTimeout>;
  private due = Infinity;
  private running = false;
  private rerun = false;
  constructor(private readonly tick: () => Promise<number | undefined>) {}
  wake(delay = 0): void {
    if (this.running) { this.rerun = true; return; }
    const due = Date.now() + Math.max(0, delay);
    if (this.timer && this.due <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => { this.timer = undefined; this.due = Infinity; void this.run(); }, Math.max(0, delay));
  }
  private async run(): Promise<void> {
    this.running = true;
    let delay: number | undefined;
    try { delay = await this.tick(); } catch { delay = 5000; }
    finally {
      this.running = false;
      if (this.rerun) { this.rerun = false; this.wake(); }
      else if (delay !== undefined) this.wake(delay);
    }
  }
}
