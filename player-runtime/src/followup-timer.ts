import { systemClock, type RuntimeClock } from "./runtime-clock";
/** A single cancellable follow-up window; eligibility is rechecked at expiry. */
export class FollowupTimer {
  private clear?: () => void;
  constructor(
    private onDeadline: (deadline: number | null) => void = () => {},
    private clock: RuntimeClock = systemClock,
  ) {}
  cancel() {
    this.clear?.();
    this.clear = undefined;
    this.onDeadline(null);
  }
  arm(delayMs: number, eligible: () => boolean, resume: () => void) {
    this.cancel();
    if (delayMs <= 0 || !eligible()) return;
    this.onDeadline(this.clock.now() + delayMs);
    this.clear = this.clock.after(delayMs, () => {
      this.clear = undefined;
      this.onDeadline(null);
      if (eligible()) resume();
    });
  }
}
