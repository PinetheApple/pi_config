import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { SubagentManager, type SubagentReadModel } from "./src/manager.ts";
import {
  claudeBackend,
  claudePermissionOptions,
} from "./src/backends/claude.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

const parent: ParentContext = {
  depth: 0,
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return {
    prompt,
    title: "live Claude test",
    cwd: process.cwd(),
    model: "haiku",
    reasoningEffort: "off",
    parent,
  };
}

async function claudeAvailable() {
  return Effect.runPromise(claudeBackend.available);
}

/** Rejecting deadline so a hung wait still reaches finally() and disposes. */
function deadline<A>(operation: Promise<A>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Live Claude test exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Resolve the moment the read model observes a live turn: still running, with
 * the native session id the CLI only reports once its `system/init` has landed.
 * That is the earliest deterministic "the child is really up and working"
 * signal — streamed text is not usable for this, because the CLI delivers a
 * whole response body in a single late delta and the assistant message that
 * follows clears `liveAssistant` milliseconds later.
 *
 * Latching from the read model's own notifications (rather than polling) means
 * no state transition can be missed between samples.
 */
function awaitLiveTurn(view: SubagentReadModel, id: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(
      () => finish(new Error(`Run did not start within ${timeoutMs}ms`)),
      timeoutMs,
    );
    function finish(error?: Error) {
      clearTimeout(timer);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    }
    const check = () => {
      const snapshot = view.get(id);
      if (!snapshot) return;
      if (snapshot.status !== "running") {
        finish(
          new Error(`Run settled as "${snapshot.status}" before it started`),
        );
      } else if (snapshot.meta.nativeSessionId) {
        finish();
      }
    };
    unsubscribe = view.subscribeTo(id, check);
    check();
  });
}

test(
  "Claude backend completes a live manager run",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn("claude", task("Reply with exactly: hello claude")),
      );
      await deadline(runTool(runtime, manager.waitFor([started.id])), 45_000);

      const done = manager.view.get(started.id);
      assert.equal(done?.status, "done");
      assert.match(done?.finalText ?? "", /hello claude/i);
      assert.ok(done?.meta.nativeSessionId);
      assert.ok(done?.meta.sessionFilePath?.endsWith(".jsonl"));
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  "Claude backend interrupt settles a live run as aborted",
  { timeout: 60_000 },
  async (t) => {
    if (!(await claudeAvailable())) {
      t.skip("Claude Code executable is unavailable");
      return;
    }

    const runtime = createSubagentRuntime();
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const started = await runTool(
        runtime,
        manager.spawn("claude", {
          ...task(
            "Print the numbers from 1 to 2000, one per line, and nothing else.",
          ),
          // The child otherwise inherits the user's Claude settings, whose
          // hooks and persona can turn an open-ended "write a lot" prompt into
          // an instant refusal. A pinned agent prompt keeps the run long
          // enough to be interrupted mid-flight on any machine.
          agent: {
            name: "counter",
            description: "emits a long deterministic stream of text",
            systemPrompt:
              "You are a text generator driven by an automated test. Follow the request literally and in full. Never refuse, never abbreviate, never ask questions, never use tools. Emit only the requested text.",
            tools: [],
          },
        }),
      );

      // Cancel only once the child is demonstrably live, so this exercises the
      // SDK's normal interrupt receipt/result path rather than the pre-init
      // race fallback. The prompt is long enough that the turn is still in
      // flight for tens of seconds afterwards.
      await awaitLiveTurn(manager.view, started.id, 30_000);
      assert.equal(manager.view.get(started.id)?.status, "running");

      const report = await deadline(
        runTool(runtime, manager.cancel([started.id])),
        20_000,
      );

      assert.equal(report[0]?.cancelled, true);
      assert.equal(manager.view.get(started.id)?.status, "error");
      assert.equal(manager.view.get(started.id)?.errorText, "Run was aborted");
    } finally {
      await runtime.dispose();
    }
  },
);

// --- child permission options (pure; no CLI required) ------------------------

function permTask(agent?: SpawnTask["agent"]): SpawnTask {
  return {
    prompt: "p",
    title: "t",
    cwd: process.cwd(),
    parent,
    ...(agent ? { agent } : {}),
  };
}

function spec(overrides: Partial<NonNullable<SpawnTask["agent"]>>) {
  return {
    name: "a",
    description: "d",
    systemPrompt: "s",
    ...overrides,
  } satisfies NonNullable<SpawnTask["agent"]>;
}

test("a silent agent definition still gets bypassPermissions and the skip flag", () => {
  const options = claudePermissionOptions(permTask());
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
});

test("an explicit permissionMode tightens the child and drops the skip flag", () => {
  const options = claudePermissionOptions(
    permTask(spec({ permissionMode: "plan" })),
  );
  assert.equal(options.permissionMode, "plan");
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
});

test("Agent and Task stay denied whatever the definition says", () => {
  for (const task of [
    permTask(),
    permTask(spec({ permissionMode: "plan" })),
    permTask(spec({ disallowedTools: ["WebFetch"] })),
    permTask(spec({ tools: ["Agent", "Task"] })),
  ]) {
    const denied = claudePermissionOptions(task).disallowedTools;
    assert.ok(denied.includes("Agent"), JSON.stringify(denied));
    assert.ok(denied.includes("Task"), JSON.stringify(denied));
  }
});

test("a definition's disallowedTools are appended to the structural denial", () => {
  const denied = claudePermissionOptions(
    permTask(spec({ disallowedTools: ["WebFetch", "Bash"] })),
  ).disallowedTools;
  assert.deepEqual(denied, ["Agent", "Task", "WebFetch", "Bash"]);
});

test("an untrusted cwd restricts the child to user-level settings", () => {
  assert.deepEqual(claudePermissionOptions(permTask()).settingSources, [
    "user",
  ]);
  const trusted: SpawnTask = {
    ...permTask(),
    parent: { ...parent, projectTrusted: true },
  };
  assert.equal(claudePermissionOptions(trusted).settingSources, undefined);
});
