/** The runtime owns timers; the browser and tests supply time. */
export interface RuntimeClock {
  now(): number;
  after(delayMs: number, callback: () => void): () => void;
}
export const systemClock: RuntimeClock = {
  now: () => Date.now(),
  after(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
