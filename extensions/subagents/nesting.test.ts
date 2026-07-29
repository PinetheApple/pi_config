/**
 * Process-wide budget and nesting depth: the two limits that bound a tree of
 * subagents, given that every nested session gets its own `MAX_RUNNING`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  acquireGlobalSlot,
  canSpawnAtDepth,
  globalRunningCount,
  MAX_SPAWN_DEPTH,
  MAX_TOTAL_RUNNING,
  registerSessionDepth,
  resetSubagentBudget,
  releaseGlobalSlot,
  sessionDepth,
} from "../shared/subagent-budget.ts";
import {
  CHILD_EXCLUDED_TOOL_NAMES,
  excludedToolsAtDepth,
  HEADLESS_EXCLUDED_TOOL_NAMES,
} from "./src/domain.ts";
import { MAX_RUNNING } from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";
import { capRange, task, withManager } from "./test-harness.ts";

test("the depth ceiling withholds orchestration but keeps real tools", () => {
  // Below the ceiling: only the tools a headless child can never use.
  assert.deepEqual(excludedToolsAtDepth(true), [
    ...HEADLESS_EXCLUDED_TOOL_NAMES,
  ]);
  assert.ok(!excludedToolsAtDepth(true).includes("subagent_spawn"));
  // ask_user is excluded for an unrelated reason and must survive the split.
  assert.ok(excludedToolsAtDepth(true).includes("ask_user"));

  // At the ceiling: orchestration goes too, but nothing else is added.
  assert.deepEqual(excludedToolsAtDepth(false), [...CHILD_EXCLUDED_TOOL_NAMES]);
  assert.ok(excludedToolsAtDepth(false).includes("subagent_spawn"));
});

test("depth is allowed up to the ceiling and refused at it", () => {
  assert.ok(canSpawnAtDepth(0), "the root session orchestrates");
  assert.ok(
    canSpawnAtDepth(MAX_SPAWN_DEPTH - 1),
    "the last level still spawns",
  );
  assert.ok(!canSpawnAtDepth(MAX_SPAWN_DEPTH), "the ceiling cannot spawn");
  assert.ok(!canSpawnAtDepth(MAX_SPAWN_DEPTH + 1));
});

test("a child learns its depth from the session file its parent registered", (t) => {
  resetSubagentBudget();
  t.after(resetSubagentBudget);
  // An unregistered session is a root session.
  assert.equal(sessionDepth("/sessions/unknown.jsonl"), 0);
  assert.equal(sessionDepth(undefined), 0);

  registerSessionDepth("/sessions/child.jsonl", 1);
  registerSessionDepth("/sessions/grandchild.jsonl", 2);
  assert.equal(sessionDepth("/sessions/child.jsonl"), 1);
  assert.equal(sessionDepth("/sessions/grandchild.jsonl"), 2);
  // Concurrent in-process children must not collide: this is exactly why the
  // depth is keyed per session file rather than carried in process.env.
  assert.equal(sessionDepth("/sessions/child.jsonl"), 1);
});

test("the global budget refuses a slot past MAX_TOTAL_RUNNING", (t) => {
  resetSubagentBudget();
  t.after(resetSubagentBudget);
  for (let i = 0; i < MAX_TOTAL_RUNNING; i++) {
    assert.ok(acquireGlobalSlot(), `slot ${i} granted`);
  }
  assert.equal(globalRunningCount(), MAX_TOTAL_RUNNING);
  assert.ok(!acquireGlobalSlot(), "the process is saturated");
  releaseGlobalSlot();
  assert.ok(acquireGlobalSlot(), "a released slot is reusable");
});

test("a manager draws from the process budget and returns it on settle", async (t) => {
  resetSubagentBudget();
  t.after(resetSubagentBudget);
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(capRange(), (n) => manager.spawn("codex", task(`T${n}`)), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, MAX_RUNNING);
    assert.equal(globalRunningCount(), MAX_RUNNING);

    await runTool(runtime, manager.waitFor(spawns.map((s) => s.id)));
    assert.equal(globalRunningCount(), 0, "settling returns every slot");
  });
});

test("a saturated process refuses a spawn even under the per-session cap", async (t) => {
  resetSubagentBudget();
  t.after(resetSubagentBudget);
  // Stand in for subagents running in other sessions of this process.
  for (let i = 0; i < MAX_TOTAL_RUNNING; i++) acquireGlobalSlot();

  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("blocked"))),
      new RegExp(`Max ${MAX_TOTAL_RUNNING} subagents.*across all sessions`),
    );
    // The refusal must not strand the per-session reservation either.
    releaseGlobalSlot();
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.status, "running");
  });
});

test("disposing a manager mid-run hands its slots back", async (t) => {
  resetSubagentBudget();
  t.after(resetSubagentBudget);
  await withManager(async (manager, runtime) => {
    await runTool(runtime, manager.spawn("claude", task("Long running task")));
    assert.equal(globalRunningCount(), 1);
  });
  // withManager disposes the runtime; a leaked slot here would starve every
  // later session in the process.
  assert.equal(globalRunningCount(), 0);
});
