/**
 * Shared test rig: a real ManagedRuntime over a test-only backend registry.
 * Scripted stub sessions stand in for claude/codex (the production backends
 * launch real processes and have their own live test files); the real pi
 * backend is registered for its cheap registry preconditions.
 *
 * Not named `*.test.ts` on purpose — the node:test glob must not pick it up.
 */

import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  MAX_RUNNING,
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";

export const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

export const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );

export type TestRuntime = ReturnType<typeof createTestRuntime>;

export const parent: ParentContext = {
  depth: 0,
  parentCwd: process.cwd(),
  projectTrusted: false,
};

export function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

export async function withManager(
  run: (manager: SubagentManagerShape, runtime: TestRuntime) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

/** Exactly enough tasks to saturate the cap: [1..MAX_RUNNING]. */
export const capRange = () =>
  Array.from({ length: MAX_RUNNING }, (_, index) => index + 1);

/** The rejection every over-cap spawn or restart must produce. */
export const capMessage = new RegExp(`Max ${MAX_RUNNING} subagents`);
