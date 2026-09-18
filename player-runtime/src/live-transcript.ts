import type {
  LiveInputMarker,
  TranscriptTiming,
} from "@aside/engine/contracts";

type Marker = LiveInputMarker & {
  state: "pending" | "answer" | "ignore" | "discard";
  replyId?: string;
};
type Fragment = { text: string; timing?: TranscriptTiming; after: Marker };

/** Revisable caption ownership. This never controls audio or interprets intent. */
export class LiveTranscript {
  private markers: Marker[] = [];
  private fragments: Fragment[] = [];

  observe(input: LiveInputMarker) {
    let marker = this.markers.find((m) => m.turnId === input.turnId);
    if (marker) {
      if (input.startMs !== undefined) marker.startMs ??= input.startMs;
      return marker;
    }
    const previous = this.markers.at(-1);
    if (previous?.state === "pending") previous.state = "ignore";
    marker = { ...input, state: "pending" };
    this.markers.push(marker);
    return marker;
  }
  resolve(input: LiveInputMarker, action: string, replyId: string) {
    const marker = this.observe(input);
    if (action === "wait") return;
    // An ignored extension of an already answered input is not a new reply.
    if (marker.state === "answer" && action !== "answer") return;
    marker.state =
      action === "answer"
        ? "answer"
        : action === "ignore"
          ? "ignore"
          : "discard";
    if (action === "answer") marker.replyId = replyId;
    // Retain complete replies, not individual fragments (which would erase
    // prefixes), and keep the active answer through any number of bystanders.
    const replies = this.markers.filter((m) => m.replyId);
    if (replies.length > 40) {
      const first = replies.at(-40)!;
      this.markers = this.markers.slice(this.markers.indexOf(first));
      this.fragments = this.fragments.filter((f) =>
        f.timing && first.startMs !== undefined
          ? f.timing.startMs >= first.startMs
          : this.markers.includes(f.after),
      );
    }
  }
  append(text: string, timing?: TranscriptTiming) {
    const after = this.markers.at(-1);
    if (!after) return;
    this.fragments.push({ text, timing, after });
  }
  replies() {
    const replies = this.markers
      .filter((m) => m.replyId)
      .map((m) => ({ id: m.replyId!, text: "" }));
    const fragments = [...this.fragments];
    if (fragments.every((f) => f.timing))
      fragments.sort((a, b) => a.timing!.startMs - b.timing!.startMs);
    for (const fragment of fragments) {
      let owner = fragment.after;
      if (fragment.timing && owner.startMs !== undefined) {
        const candidates = this.markers.filter(
          (m) =>
            m.startMs !== undefined && m.startMs <= fragment.timing!.startMs,
        );
        owner = candidates.at(-1) ?? owner;
        // An old session fragment has no owner in the retained window.
        if (!candidates.length) continue;
      }
      let at = this.markers.indexOf(owner);
      while (owner.state === "ignore" && at > 0) owner = this.markers[--at];
      if (owner.state !== "answer") continue;
      const reply = replies.find((r) => r.id === owner.replyId);
      if (reply) reply.text += fragment.text;
    }
    return replies;
  }
  clear() {
    this.markers = [];
    this.fragments = [];
  }
}
