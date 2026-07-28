import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSignalNudge,
  detectCues,
  SIGNAL_NUDGE_MARKER,
} from "./src/signal-cues.ts";

test("detects each cue class the python hook detects", () => {
  assert.deepEqual(detectCues("No, don't do that"), ["correction"]);
  assert.deepEqual(detectCues("yes, exactly — perfect"), ["confirmation"]);
  assert.deepEqual(detectCues("I prefer tabs from now on"), ["preference"]);
  assert.deepEqual(detectCues("see the linear ticket"), ["external-reference"]);
});

test("cue matching is case-insensitive and reports every class that hits", () => {
  assert.deepEqual(detectCues("STOP. I ALWAYS use the runbook."), [
    "correction",
    "preference",
    "external-reference",
  ]);
});

test("bare words outside the cue lists do not fire", () => {
  assert.deepEqual(detectCues("please refactor the parser"), []);
  assert.deepEqual(detectCues("slack is fine"), []);
  assert.deepEqual(detectCues("nicely done"), []);
});

test("no nudge for empty or signal-free prompts", () => {
  assert.equal(buildSignalNudge("   "), undefined);
  assert.equal(buildSignalNudge("add a test for the parser"), undefined);
});

test("nudge lists the detected cues and names the auto-memory skill", () => {
  const nudge = buildSignalNudge("no, that's wrong — I prefer pnpm");
  assert.ok(nudge);
  assert.ok(nudge.startsWith(SIGNAL_NUDGE_MARKER));
  assert.ok(nudge.includes("(correction, preference)"));
  assert.ok(nudge.includes("`auto-memory`"));
});

test("an already-nudged prompt is not nudged again", () => {
  const first = buildSignalNudge("no, stop");
  assert.ok(first);
  assert.equal(buildSignalNudge(`no, stop\n\n${first}`), undefined);
});
