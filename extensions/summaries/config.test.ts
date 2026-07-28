import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  DEFAULT_SUMMARY_CONFIG,
  PRIVATE_CONFIG_PATH,
  parseSummaryConfig,
} from "./src/config.ts";

test("summary config defaults to Codex Luna at medium reasoning, enabled", () => {
  assert.deepEqual(parseSummaryConfig(undefined), DEFAULT_SUMMARY_CONFIG);
  assert.deepEqual(DEFAULT_SUMMARY_CONFIG, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoning: "medium",
    enabled: true,
  });
});

test("summary config accepts valid private overrides and rejects partial corruption", () => {
  assert.deepEqual(
    parseSummaryConfig({
      provider: " anthropic ",
      model: " claude-sonnet ",
      reasoning: "high",
    }),
    {
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
      enabled: true,
    },
  );

  assert.deepEqual(
    parseSummaryConfig({ provider: "", model: 42, reasoning: "turbo" }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: 42,
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
});

test("a config written before the toggle existed keeps its model and reads as enabled", () => {
  const legacy = {
    provider: "opencode",
    model: "deepseek-v4-flash-free",
    reasoning: "medium",
  };

  assert.deepEqual(parseSummaryConfig(legacy), {
    ...legacy,
    enabled: true,
  });
});

test("the real private config on disk survives the enabled flag", (t) => {
  if (!existsSync(PRIVATE_CONFIG_PATH)) {
    t.skip("no private config on this machine");
    return;
  }

  const parsed = parseSummaryConfig(
    JSON.parse(readFileSync(PRIVATE_CONFIG_PATH, "utf8")),
  );

  assert.equal(typeof parsed.enabled, "boolean");
  assert.notDeepEqual(
    { provider: parsed.provider, model: parsed.model },
    {
      provider: DEFAULT_SUMMARY_CONFIG.provider,
      model: DEFAULT_SUMMARY_CONFIG.model,
    },
    "the saved model must not have been reset to the built-in default",
  );
});

test("enabled: false is honored and a malformed enabled falls back to on", () => {
  const saved = {
    provider: "opencode",
    model: "deepseek-v4-flash-free",
    reasoning: "medium",
  } as const;

  assert.deepEqual(parseSummaryConfig({ ...saved, enabled: false }), {
    ...saved,
    enabled: false,
  });

  for (const malformed of ["false", 0, null, {}, []]) {
    assert.deepEqual(
      parseSummaryConfig({ ...saved, enabled: malformed }),
      { ...saved, enabled: true },
      `malformed enabled ${JSON.stringify(malformed)} should keep summaries on`,
    );
  }
});
