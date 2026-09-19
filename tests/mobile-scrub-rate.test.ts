import assert from "node:assert/strict";
import test from "node:test";
import { scrubRate } from "../mobile/src/scrub-rate";

test("scrubbing slows as the finger lifts away from the track", () => {
  assert.equal(scrubRate(0), 1);
  assert.equal(scrubRate(-40), 1);
  assert.equal(scrubRate(70), 1);
  assert.equal(scrubRate(71), 0.5);
  assert.equal(scrubRate(140), 0.5);
  assert.equal(scrubRate(141), 0.25);
});
