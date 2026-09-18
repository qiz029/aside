/** Ignore typography when comparing speech, preserving words and numeric values. */
export function normalizeSpokenText(value: string) {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(
        /\p{N}+(?:[.,]\p{N}+)*|\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{M}])+/gu,
      )
      ?.join(" ") ?? ""
  );
}

/** Inputs are normalized. A short acknowledgement must match the whole reply. */
export function matchesSpokenText(heard: string, expected: string) {
  return (
    !!expected &&
    (expected.length < 20 ? heard === expected : heard.endsWith(expected))
  );
}
