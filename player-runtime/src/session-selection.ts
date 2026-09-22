import type { ListeningSession } from "./listening-session";
import type { Episode } from "@aside/engine/core";

export type SessionSnapshot = ReturnType<ListeningSession["getSnapshot"]>;

/** Cache by selected value, so unrelated store ticks never schedule a render. */
export function selectStore<S, T>(
  getSnapshot: () => S,
  select: (snapshot: S) => T,
  equal: (a: T, b: T) => boolean = Object.is,
) {
  let initialized = false;
  let previous: T;
  return () => {
    const next = select(getSnapshot());
    if (!initialized || !equal(previous, next)) {
      initialized = true;
      previous = next;
    }
    return previous;
  };
}
function shallowEqual(a: object, b: object) {
  const left = Object.entries(a),
    right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(([key, value]) =>
      Object.is(value, (b as Record<string, unknown>)[key]),
    )
  );
}
export function selectPlayerScreen(
  snapshot: SessionSnapshot,
  passages: NonNullable<Episode["analysis"]>["passages"] = [],
) {
  const { positionMs, ...state } = snapshot.state;
  return {
    ...snapshot,
    // Position belongs to the timeline. The screen needs only passage boundaries.
    state,
    passageIndex: passages.findIndex(
      (p) => positionMs >= p.startMs && positionMs < p.endMs,
    ),
  };
}
export function samePlayerScreen(
  a: ReturnType<typeof selectPlayerScreen>,
  b: ReturnType<typeof selectPlayerScreen>,
) {
  const { state: as, history: ah, ...ar } = a;
  const { state: bs, history: bh, ...br } = b;
  return (
    shallowEqual(as, bs) &&
    shallowEqual(ar, br) &&
    ah.length === bh.length &&
    ah.every((turn, i) => turn === bh[i])
  );
}
