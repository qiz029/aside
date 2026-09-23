let context: AudioContext | undefined;
/**
 * A quiet two-note rise when the app takes up a spoken question: the
 * listener hears that they were understood before the answer starts. Pure
 * tones do not trigger the speech detector, and echo cancellation removes
 * them from the microphone.
 */
export function playHeardCue() {
  if (typeof AudioContext === "undefined") return;
  try {
    context ??= new AudioContext();
  } catch {
    return;
  }
  const ctx = context;
  void ctx
    .resume()
    .then(() => {
      const start = ctx.currentTime + 0.01;
      for (const [offset, frequency] of [
        [0, 660],
        [0.09, 880],
      ] as const) {
        const tone = ctx.createOscillator();
        const gain = ctx.createGain();
        tone.type = "sine";
        tone.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start + offset);
        gain.gain.linearRampToValueAtTime(0.05, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
        tone.connect(gain).connect(ctx.destination);
        tone.start(start + offset);
        tone.stop(start + offset + 0.18);
      }
    })
    .catch(() => {});
}
