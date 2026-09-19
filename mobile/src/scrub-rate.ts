/** Moving the finger up from the track slows the scrub: full, half, quarter speed. */
export const scrubRate = (liftPx: number) =>
  liftPx > 140 ? 0.25 : liftPx > 70 ? 0.5 : 1;
