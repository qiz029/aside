import { normalizeSpokenText, matchesSpokenText } from "@aside/engine/core";
import type { LiveControlEvent } from "@aside/engine/contracts";

type Answered = Extract<LiveControlEvent, { type: "answered" }>;
interface Variant {
  text: string;
  normalized: string;
  terminal: boolean;
  eligible: boolean;
  emitted: boolean;
}

/**
 * Live may speak a later backend formulation of the same input. Observe at most
 * two alternatives without admitting another turn or executing its tools. Only
 * a complete tool-free response corroborated by output captions can update the
 * original reply's completion metadata. The client still owns audible history,
 * native drain and continuation. These captions do not prove audio was heard.
 */
export class SpokenAnswerVariants {
  private variants = new Map<string, Variant>();
  private transcript = "";
  constructor(
    private first: Answered,
    private emit: (event: Answered) => void,
  ) {}

  has(id: string) {
    return this.variants.has(id);
  }

  start(id: string) {
    if (this.variants.has(id)) return true;
    if (this.variants.size >= 2) return false;
    this.variants.set(id, {
      text: "",
      normalized: "",
      terminal: false,
      eligible: true,
      emitted: false,
    });
    return true;
  }

  receive(id: string, event: Record<string, unknown>) {
    if (!this.start(id)) return;
    const variant = this.variants.get(id)!;
    if (variant.terminal) return;
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string") {
          if (variant.text.length + event.delta.length > 64000)
            variant.eligible = false;
          else variant.text += event.delta;
        }
        break;
      case "response.output_item.done":
        if (
          (event.item as { type?: unknown } | undefined)?.type ===
          "function_call"
        )
          variant.eligible = false;
        break;
      case "response.completed":
      case "response.done":
        variant.terminal = true;
        variant.normalized = normalizeSpokenText(variant.text);
        this.confirm();
        break;
      case "response.failed":
      case "response.incomplete":
        variant.eligible = false;
        variant.terminal = true;
        break;
    }
  }

  observe(text: string) {
    this.transcript = (this.transcript + text).slice(-64000);
    this.confirm();
  }

  private confirm() {
    const spoken = normalizeSpokenText(this.transcript);
    for (const variant of this.variants.values()) {
      if (
        !variant.terminal ||
        !variant.eligible ||
        variant.emitted ||
        !matchesSpokenText(spoken, variant.normalized)
      )
        continue;
      variant.emitted = true;
      if (variant.normalized !== normalizeSpokenText(this.first.answer))
        this.emit({ ...this.first, answer: variant.text });
    }
  }
}
