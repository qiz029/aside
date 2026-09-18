import { systemClock, type RuntimeClock } from "./runtime-clock";

/** AbortSignal.any/timeout are absent in the native JS runtime. Release listeners on every outcome. */
export async function withAbortTimeout<T>(
  parent: AbortSignal,
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
  clock: RuntimeClock = systemClock,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  const cancel = clock.after(milliseconds, abort);
  try {
    return await operation(controller.signal);
  } finally {
    cancel();
    parent.removeEventListener("abort", abort);
  }
}
