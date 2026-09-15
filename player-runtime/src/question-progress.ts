import type { QuestionPhase } from "@aside/engine/contracts";
import { systemClock, type RuntimeClock } from "./runtime-clock";
/** Delay brief answers' filler; limit long tool chains to two spoken updates. */
export class QuestionProgress {
  private clear?: () => void;
  private phase: QuestionPhase = "working";
  private count = 0;
  private lastAt = 0;
  private closed = false;
  constructor(
    private emit: (phase: QuestionPhase) => void,
    private clock: RuntimeClock = systemClock,
  ) {}
  update(phase: QuestionPhase) {
    if (this.closed || this.count >= 2) return;
    this.phase = phase;
    if (this.clear) return;
    const delay =
      this.count === 0
        ? 1500
        : Math.max(0, 8000 - (this.clock.now() - this.lastAt));
    this.clear = this.clock.after(delay, () => {
      this.clear = undefined;
      if (this.closed) return;
      this.count++;
      this.lastAt = this.clock.now();
      this.emit(this.phase);
    });
  }
  close() {
    this.closed = true;
    this.clear?.();
  }
}
