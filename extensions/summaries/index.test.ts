import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import summariesExtension from "./index.ts";
import { PRIVATE_CONFIG_PATH, type SummaryConfig } from "./src/config.ts";

test("registers only the recap renderer, commands, and bounded lifecycle hooks", () => {
  const events = new Set<string>();
  const renderers = new Set<string>();
  const commands = new Set<string>();
  const api = {
    on: (event: string) => events.add(event),
    registerEntryRenderer: (customType: string) => renderers.add(customType),
    registerCommand: (name: string) => commands.add(name),
  } as unknown as ExtensionAPI;

  summariesExtension(api);

  assert.deepEqual(
    events,
    new Set([
      "session_start",
      "before_agent_start",
      "agent_settled",
      "session_shutdown",
    ]),
  );
  assert.deepEqual(renderers, new Set(["summary-recap"]));
  assert.deepEqual(commands, new Set(["summary-model", "summaries"]));
});

const BASELINE_ID = "baseline";

function branch(): SessionEntry[] {
  const shared = { type: "message", parentId: null, timestamp: "" } as const;
  return [
    {
      ...shared,
      id: BASELINE_ID,
      message: { role: "user", content: "earlier", timestamp: 0 },
    },
    {
      ...shared,
      id: "run-turn",
      message: { role: "user", content: "do the thing", timestamp: 1 },
    },
  ];
}

function harness() {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const appended: { customType: string; data: unknown }[] = [];
  const statusUpdates: (string | undefined)[] = [];
  let modelLookups = 0;

  const api = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => handlers.set(event, handler),
    registerEntryRenderer: () => {},
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) =>
      appended.push({ customType, data }),
  } as unknown as ExtensionAPI;

  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getLeafId: () => BASELINE_ID,
      getBranch: branch,
    },
    modelRegistry: {
      find: () => {
        modelLookups += 1;
        return undefined;
      },
    },
    ui: {
      setStatus: (_key: string, value: string | undefined) =>
        statusUpdates.push(value),
      notify: () => {},
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;

  summariesExtension(api);

  return {
    appended,
    statusUpdates,
    modelLookups: () => modelLookups,
    async runTurn() {
      handlers.get("session_start")?.({}, ctx);
      handlers.get("before_agent_start")?.({}, ctx);
      handlers.get("agent_settled")?.({}, ctx);
      for (let tick = 0; tick < 100 && appended.length === 0; tick += 1) {
        await delay(10);
      }
    },
  };
}

function withConfig(t: import("node:test").TestContext, config: SummaryConfig) {
  const original = existsSync(PRIVATE_CONFIG_PATH)
    ? readFileSync(PRIVATE_CONFIG_PATH, "utf8")
    : undefined;
  t.after(() => {
    if (original === undefined) unlinkSync(PRIVATE_CONFIG_PATH);
    else writeFileSync(PRIVATE_CONFIG_PATH, original, { mode: 0o600 });
  });
  writeFileSync(PRIVATE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

const TEST_CONFIG = {
  provider: "test-provider",
  model: "test-model",
  reasoning: "medium",
  enabled: true,
} as const satisfies SummaryConfig;

test("a disabled config skips the summarizer, the recap entry, and the status", async (t) => {
  withConfig(t, { ...TEST_CONFIG, enabled: false });
  const run = harness();

  await run.runTurn();

  assert.equal(run.modelLookups(), 0, "no model work when disabled");
  assert.deepEqual(run.appended, []);
  assert.deepEqual(run.statusUpdates, [], "no footer status flicker");
});

test("an enabled config summarizes the run and appends exactly one recap", async (t) => {
  withConfig(t, TEST_CONFIG);
  const run = harness();

  await run.runTurn();

  assert.equal(run.modelLookups(), 1);
  assert.equal(run.appended.length, 1);
  assert.equal(run.appended[0]?.customType, "summary-recap");
  assert.deepEqual(
    run.appended[0]?.data,
    {
      recap: "The main-agent run completed.",
      next: "Review the completed work above and continue if anything remains.",
      provider: "test-provider",
      model: "test-model",
      reasoning: "medium",
      fallback: true,
    },
    "the recap entry records the model, not the enabled flag",
  );
  assert.ok(
    run.statusUpdates.includes("✦ summarizing run…"),
    "the footer reports in-flight work",
  );
});
