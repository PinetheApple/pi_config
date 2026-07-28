import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUMMARY_CONFIG } from "./src/config.ts";
import {
  formatSummaryState,
  parseToggleArguments,
  resolveEnabled,
  type ToggleAction,
} from "./src/toggle.ts";

test("bare invocation toggles, named arguments are explicit", () => {
  const actions = ["", "  ", "on", "OFF", " status "].map((raw) =>
    parseToggleArguments(raw),
  );

  assert.deepEqual(
    actions.map((parsed) => (parsed.ok ? parsed.action : parsed.error)),
    ["toggle", "toggle", "on", "off", "status"],
  );
});

test("an unknown argument names the valid ones and changes nothing", () => {
  const parsed = parseToggleArguments("enable");

  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error, /Unknown argument "enable"/);
  for (const valid of ["on", "off", "status"]) {
    assert.match(parsed.ok ? "" : parsed.error, new RegExp(`\\b${valid}\\b`));
  }
});

test("resolveEnabled flips only for toggle and never for status", () => {
  const table: readonly [ToggleAction, boolean, boolean][] = [
    ["on", false, true],
    ["on", true, true],
    ["off", true, false],
    ["off", false, false],
    ["status", true, true],
    ["status", false, false],
    ["toggle", true, false],
    ["toggle", false, true],
  ];

  for (const [action, current, expected] of table) {
    assert.equal(
      resolveEnabled(action, current),
      expected,
      `${action} from ${current}`,
    );
  }
});

test("the reported state carries the current model", () => {
  assert.equal(
    formatSummaryState({
      ...DEFAULT_SUMMARY_CONFIG,
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      enabled: true,
    }),
    "Summaries: on · opencode/deepseek-v4-flash-free · medium",
  );
  assert.equal(
    formatSummaryState({ ...DEFAULT_SUMMARY_CONFIG, enabled: false }),
    "Summaries: off · openai-codex/gpt-5.6-luna · medium",
  );
});
