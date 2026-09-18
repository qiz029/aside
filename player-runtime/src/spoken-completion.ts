import { normalizeSpokenText, matchesSpokenText } from "@aside/engine/core";

/**
 * Live has no semantic audio-done event. Mobile may resume only after the
 * backend's complete answer was heard AND the native playout queue drained.
 * Paraphrased/missing captions intentionally require explicit Continue.
 * Punctuation/spacing/case changes are harmless; missing words or numbers aren't.
 */
export class SpokenCompletion {
  private expected = "";
  private heard = "";
  private started = false;
  private drained = false;
  answer(value: string) {
    this.expected = normalizeSpokenText(value);
  }
  transcript(value: string) {
    this.heard = normalizeSpokenText(value);
  }
  outputStarted() {
    this.started = true;
    this.drained = false;
  }
  outputDrained() {
    if (this.started) this.drained = true;
  }
  get complete() {
    return (
      this.started &&
      this.drained &&
      matchesSpokenText(this.heard, this.expected)
    );
  }
}
