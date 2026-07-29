import assert from "node:assert/strict";
import test from "node:test";
import {
  availablePiModelIds,
  type ModelLookup,
  resolvePiModel,
} from "./src/backends/model-hint.ts";

const model = (provider: string, id: string) => ({ provider, id }) as never;

function registry(options: {
  all: ReadonlyArray<[string, string]>;
  available?: ReadonlyArray<[string, string]>;
}): ModelLookup {
  const all = options.all.map(([provider, id]) => model(provider, id));
  const available = (options.available ?? options.all).map(([p, id]) =>
    model(p, id),
  );
  return {
    getAll: () => all,
    getAvailable: () => available,
    find: (provider, id) =>
      all.find((m: any) => m.provider === provider && m.id === id),
  };
}

const throws = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.fail("expected a rejection");
};

test("an unknown model lists the available provider-qualified ids", () => {
  const message = throws(() =>
    resolvePiModel(
      registry({
        all: [
          ["anthropic", "claude-opus-4-5"],
          ["anthropic", "claude-haiku-4-5"],
          ["openai", "gpt-5"],
        ],
      }),
      "haiku",
      undefined,
    ),
  );
  assert.match(message, /^Unknown model "haiku"\. Available models: /);
  assert.match(message, /anthropic\/claude-haiku-4-5/);
  assert.match(message, /openai\/gpt-5/);
});

test("a provider-qualified miss is rejected with the same catalog", () => {
  const message = throws(() =>
    resolvePiModel(
      registry({ all: [["openai", "gpt-5"]] }),
      "anthropic/haiku",
      undefined,
    ),
  );
  assert.match(message, /Unknown model "anthropic\/haiku"\./);
  assert.match(message, /Available models: openai\/gpt-5\./);
});

test("the listed ids are deduped, sorted, and capped with a +N more note", () => {
  const all: Array<[string, string]> = Array.from(
    { length: 30 },
    (_, index) => ["p", `m${index.toString().padStart(2, "0")}`],
  );
  const message = throws(() =>
    resolvePiModel(registry({ all }), "nope", undefined),
  );
  const listed = message.slice(
    message.indexOf("Available models: ") + "Available models: ".length,
  );
  assert.ok(listed.startsWith("p/m00, p/m01, "));
  assert.match(listed, /\(\+6 more\)\.$/);
  assert.equal(listed.split(", ").length, 24);
});

test("an ambiguous bare id names the exact qualified alternatives", () => {
  const message = throws(() =>
    resolvePiModel(
      registry({
        all: [
          ["openrouter", "kimi-k2"],
          ["moonshot", "kimi-k2"],
        ],
      }),
      "kimi-k2",
      undefined,
    ),
  );
  assert.equal(
    message,
    'Model "kimi-k2" exists in multiple providers. Use one of: moonshot/kimi-k2, openrouter/kimi-k2.',
  );
});

test("an empty registry says so instead of listing nothing", () => {
  assert.equal(
    throws(() => resolvePiModel(registry({ all: [] }), "haiku", undefined)),
    'Unknown model "haiku". No models are configured in this session\'s registry.',
  );
});

test("resolution semantics are unchanged: exact, inherited provider, unique bare id", () => {
  const lookup = registry({
    all: [
      ["anthropic", "opus"],
      ["openai", "gpt-5"],
    ],
  });
  assert.deepEqual(resolvePiModel(lookup, "anthropic/opus", undefined), {
    provider: "anthropic",
    id: "opus",
  });
  assert.deepEqual(
    resolvePiModel(lookup, "opus", { provider: "anthropic", id: "other" }),
    { provider: "anthropic", id: "opus" },
  );
  assert.deepEqual(resolvePiModel(lookup, "gpt-5", undefined), {
    provider: "openai",
    id: "gpt-5",
  });
  assert.equal(resolvePiModel(lookup, undefined, undefined), undefined);
});

test("the catalog prefers authenticated models, falling back to the full registry", () => {
  assert.deepEqual(
    availablePiModelIds(
      registry({
        all: [
          ["anthropic", "opus"],
          ["openai", "gpt-5"],
        ],
        available: [["openai", "gpt-5"]],
      }),
    ),
    ["openai/gpt-5"],
  );
  assert.deepEqual(
    availablePiModelIds(
      registry({ all: [["anthropic", "opus"]], available: [] }),
    ),
    ["anthropic/opus"],
  );
});
