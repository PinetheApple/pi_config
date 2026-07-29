/**
 * The workflow AgentTransport driven exactly as `pi-extensible-workflows`
 * drives it: create sessions, prompt them, cancel them. The manager runs on
 * the shared stub-backend rig, so these are real manager semantics.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_TRANSPORT_ID,
  type AgentTransportContext,
  type PreparedAgentSession,
  type WorkflowAgentMessage,
  type WorkflowAgentSession,
} from "../shared/workflow-transport.ts";
import { MAX_RUNNING } from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";
import type { WorkflowParentContext } from "../shared/subagent-host.ts";
import { createSubagentTransport } from "./src/workflow-transport.ts";
import { withManager } from "./test-harness.ts";

const parentContext: WorkflowParentContext = {
  cwd: process.cwd(),
  isProjectTrusted: () => false,
};

function prepared(label: string): PreparedAgentSession {
  return {
    cwd: process.cwd(),
    model: { provider: "stub", model: "stub-model" },
    tools: ["read"],
    sessionLabel: label,
  };
}

function transportContext(signal: AbortSignal): AgentTransportContext {
  return {
    run: { cwd: process.cwd(), runId: "run-1" },
    identity: { structuralPath: [], callSite: "agent" },
    attempt: 1,
    signal,
  };
}

function assistantText(message: WorkflowAgentMessage | undefined) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a fan-out wider than MAX_RUNNING waits instead of widening the pool", async () => {
  await withManager(async (manager, runtime) => {
    const transport = createSubagentTransport({
      runtime,
      manager,
      parent: parentContext,
      backend: "codex",
    });
    const fanOut = MAX_RUNNING * 2;
    let peak = 0;
    const unsubscribe = manager.view.subscribe(() => {
      const running = manager.view
        .list()
        .filter((snap) => snap.status === "running").length;
      peak = Math.max(peak, running);
    });

    const signal = new AbortController().signal;
    const sessions = await Promise.all(
      Array.from({ length: fanOut }, (_, index) =>
        transport.createSession(
          prepared(`fanout:agent-${index}`),
          transportContext(signal),
        ),
      ),
    );
    const results = await Promise.all(
      sessions.map((session, index) => session.prompt(`Task ${index}`)),
    );
    unsubscribe();

    assert.ok(peak > 0, "the stub children actually ran");
    assert.ok(
      peak <= MAX_RUNNING,
      `peak concurrency ${peak} exceeded MAX_RUNNING ${MAX_RUNNING}`,
    );
    // Every queued agent still finished: the cap is backpressure, not failure.
    assert.equal(results.length, fanOut);
    for (const result of results) {
      assert.match(assistantText(result.assistant), /completed/);
    }
    // ...and all of them are visible to subagent_list.
    assert.equal(manager.view.list().length, fanOut);
    assert.equal(sessions[0].reference.transport, WORKFLOW_TRANSPORT_ID);
  });
});

test("subagent_cancel aborts a workflow child and ends its turn", async () => {
  await withManager(async (manager, runtime) => {
    const transport = createSubagentTransport({
      runtime,
      manager,
      parent: parentContext,
      backend: "claude",
    });
    const session = await transport.createSession(
      prepared("cancel:agent-0"),
      transportContext(new AbortController().signal),
    );
    const turn = session.prompt("Long running task");
    while (manager.view.list().length === 0) await sleep(10);
    const [child] = manager.view.list();

    const report = await runTool(runtime, manager.cancel([child.id]));
    assert.deepEqual(report, [
      {
        id: child.id,
        title: "cancel:agent-0",
        status: "error",
        cancelled: true,
      },
    ]);

    const result = await turn;
    assert.equal(result.assistant?.stopReason, "error");
    assert.equal(manager.view.get(child.id)?.errorText, "Run was aborted");
  });
});

test("session.abort cancels the child it spawned", async () => {
  await withManager(async (manager, runtime) => {
    const transport = createSubagentTransport({
      runtime,
      manager,
      parent: parentContext,
      backend: "claude",
    });
    const session = await transport.createSession(
      prepared("abort:agent-0"),
      transportContext(new AbortController().signal),
    );
    const turn = session.prompt("Long running task");
    while (manager.view.list().length === 0) await sleep(10);

    await session.abort();
    await turn;

    const [child] = manager.view.list();
    assert.equal(child.status, "error");
    assert.equal(child.errorText, "Run was aborted");
    assert.equal(session.reference.transport, WORKFLOW_TRANSPORT_ID);
  });
});

test("a settled child stays listed after the session is disposed", async () => {
  await withManager(async (manager, runtime) => {
    const transport = createSubagentTransport({
      runtime,
      manager,
      parent: parentContext,
      backend: "codex",
    });
    const session = await transport.createSession(
      prepared("dispose:agent-0"),
      transportContext(new AbortController().signal),
    );
    await session.prompt("Say hello to the tests");
    await session.dispose();

    const [child] = manager.view.list();
    assert.equal(child.status, "done");
    assert.match(child.finalText, /completed: Say hello to the tests/);
  });
});

test("an accepted workflow_result settles the child as a success", async () => {
  await withManager(async (manager, runtime) => {
    const transport = createSubagentTransport({
      runtime,
      manager,
      parent: parentContext,
      backend: "codex",
    });

    // Mirrors pi-extensible-workflows' own result tool: it accepts the value
    // and then aborts the session as its normal termination path.
    let session: WorkflowAgentSession | undefined;
    let accepted: unknown;
    const resultTool = Object.freeze({
      name: "workflow_result",
      label: "Workflow Result",
      description: "Submit the terminal structured workflow result",
      parameters: {},
      async execute(_id: string, value: unknown) {
        accepted = value;
        void session?.abort();
        return {
          content: [{ type: "text", text: "Result accepted." }],
          details: {},
        };
      },
    });

    session = await transport.createSession(
      { ...prepared("schema:agent-0"), resultTool } as never,
      transportContext(new AbortController().signal),
    );
    const result = await session.prompt("Pick a colour");

    assert.deepEqual(
      accepted,
      { stub: true },
      "the child called the result tool",
    );
    const [child] = manager.view.list();
    // The bug: a successful submission used to land as error/"Run was aborted".
    assert.equal(child.status, "done");
    assert.equal(child.errorText, undefined);
    assert.notEqual(child.finalText, "");
    // ...and the package must not see a terminal provider error either.
    assert.notEqual(result.assistant?.stopReason, "error");
  });
});

test("an abort with no accepted result is still a cancellation", async () => {
  await withManager(async (manager, runtime) => {
    const transport = createSubagentTransport({
      runtime,
      manager,
      parent: parentContext,
      backend: "claude",
    });
    const session = await transport.createSession(
      prepared("cancel:agent-1"),
      transportContext(new AbortController().signal),
    );
    const turn = session.prompt("Long running task");
    while (manager.view.list().length === 0) await sleep(10);
    await session.abort();
    await turn;

    const [child] = manager.view.list();
    assert.equal(child.status, "error");
    assert.equal(child.errorText, "Run was aborted");
  });
});
