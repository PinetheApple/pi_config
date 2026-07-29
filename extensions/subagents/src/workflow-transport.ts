/**
 * `pi-extensible-workflows` AgentTransport backed by the SubagentManager.
 *
 * The workflow package drives every workflow agent through an `AgentTransport`.
 * Routing that through the manager instead of the package's own
 * `localAgentTransport` keeps one pool: workflow children are counted by
 * MAX_RUNNING, listed by `subagent_list`, and killed by `subagent_cancel`.
 *
 * It lives beside the manager (rather than in `extensions/workflows`) because
 * only this package has `effect` on its resolution path; the workflows
 * extension consumes it as plain async code.
 */

import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { onBudgetChange } from "../../shared/subagent-budget.ts";
import type { WorkflowParentContext } from "../../shared/subagent-host.ts";
import { WORKFLOW_TRANSPORT_ID } from "../../shared/workflow-transport.ts";
import type {
  AgentTransport,
  AgentTransportContext,
  PreparedAgentSession,
  WorkflowAgentSession,
  WorkflowAgentSessionEvent,
  WorkflowAgentSessionState,
  WorkflowAgentSessionStats,
} from "../../shared/workflow-transport.ts";
import type {
  BackendName,
  SpawnTask,
  SubagentSnapshot,
  ReasoningEffort,
} from "./domain.ts";
import type { SubagentManagerShape } from "./manager.ts";
import { runTool, type SubagentRuntime } from "./runtime.ts";
import { resolveChildProjectTrust } from "./spawn.ts";
import { normalizeTitle } from "./title.ts";

/** Backstop in case a manager notification is missed while queued for a slot. */
const CAPACITY_RECHECK_MS = 250;
/** `send` restarts an idle child through the async pump, not synchronously. */
const RUN_START_TIMEOUT_MS = 10_000;
const WORKFLOW_TITLE_MAX_LENGTH = 160;
const EMPTY_STATS: WorkflowAgentSessionStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

export interface SubagentTransportOptions {
  readonly runtime: SubagentRuntime;
  readonly manager: SubagentManagerShape;
  readonly parent: WorkflowParentContext;
  readonly thinkingLevel?: string;
  /** Depth of the session hosting the workflow; agents go one deeper. */
  readonly sessionDepth?: number;
  /** Harness workflow children run on. Overridable so tests can use a stub. */
  readonly backend?: BackendName;
}

function toolNames(prepared: PreparedAgentSession) {
  return [
    ...prepared.tools,
    ...(prepared.customTools ?? []).map((tool) => tool.name),
    ...(prepared.resultTool ? [prepared.resultTool.name] : []),
  ];
}

/**
 * The pi backend can only *override* a child's system prompt, so an append-only
 * persona is folded into the first user turn instead of being dropped.
 */
function personaPrefix(prepared: PreparedAgentSession) {
  if (prepared.systemPrompt !== undefined) return undefined;
  const append = prepared.systemPromptAppend?.trim();
  return append ? append : undefined;
}

function buildSpawnTask(
  prepared: PreparedAgentSession,
  prompt: string,
  options: SubagentTransportOptions,
  onResultAccepted: (text: string | undefined) => void,
): SpawnTask {
  const names = toolNames(prepared);
  return {
    prompt,
    title: normalizeTitle(prepared.sessionLabel, {
      fallback: "workflow agent",
      maxLength: WORKFLOW_TITLE_MAX_LENGTH,
    }),
    cwd: prepared.cwd,
    model: `${prepared.model.provider}/${prepared.model.model}`,
    reasoningEffort: prepared.model.thinking as ReasoningEffort | undefined,
    // Shallow copies: the workflow package freezes these, and pi's session
    // wraps `execute` in place when it registers a custom tool.
    customTools: [
      ...(prepared.customTools ?? []).map((tool) => ({ ...tool })),
      ...(prepared.resultTool
        ? [observeResultTool(prepared.resultTool, onResultAccepted)]
        : []),
    ],
    agent: {
      name: prepared.sessionLabel,
      description: "workflow agent",
      systemPrompt: prepared.systemPrompt ?? "",
      tools: names,
    },
    parent: {
      depth: options.sessionDepth ?? 0,
      parentCwd: options.parent.cwd,
      projectTrusted: resolveChildProjectTrust({
        parentCwd: options.parent.cwd,
        childCwd: prepared.cwd,
        parentTrusted: options.parent.isProjectTrusted(),
      }),
      inheritedModel: options.parent.model
        ? {
            provider: options.parent.model.provider,
            id: options.parent.model.id,
          }
        : undefined,
      inheritedThinkingLevel: options.thinkingLevel,
      modelRegistry: options.parent.modelRegistry,
    },
  };
}

/**
 * Wrap `workflow_result` so we learn the moment it accepts a value.
 *
 * The package's own `execute` calls `session.abort()` on acceptance, so the
 * abort that follows is a *successful* termination. Without this signal the
 * transport cannot tell it apart from a cancellation or a timeout, and a
 * finished agent is recorded as "error / Run was aborted".
 */
function observeResultTool(
  resultTool: ToolDefinition,
  onAccepted: (text: string | undefined) => void,
) {
  const execute = resultTool.execute.bind(resultTool);
  return {
    ...resultTool,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      // Record *before* delegating: the package aborts the session from inside
      // its own execute, so waiting for the result would let that abort be
      // seen as a cancellation.
      onAccepted(resultText(args[1]));
      const result = await execute(...args);
      // `isError` is how the package rejects a bad or duplicate result; it
      // sits outside pi's declared AgentToolResult, so read it defensively.
      // A rejected result never aborts, so rolling back here is safe.
      if ((result as { isError?: unknown }).isError === true) {
        onAccepted(undefined);
      }
      return result;
    },
  };
}

function resultText(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolCallFailed(snapshot: SubagentSnapshot, toolId: string) {
  for (let i = snapshot.transcript.length - 1; i >= 0; i--) {
    const item = snapshot.transcript[i];
    if (item.kind === "toolResult" && item.toolId === toolId)
      return item.isError;
  }
  return false;
}

/**
 * An abort is a normal outcome, not a provider failure: `workflow_result`
 * aborts the session the moment it accepts a value. Reporting that as
 * `stopReason: "error"` would make the package raise AGENT_FAILED on the
 * success path, so only an unrequested failure is terminal.
 */
function assistantMessage(snapshot: SubagentSnapshot, abortRequested: boolean) {
  const failed = snapshot.status === "error" && !abortRequested;
  return {
    role: "assistant",
    content: [{ type: "text", text: snapshot.finalText }],
    ...(failed
      ? { stopReason: "error", errorMessage: snapshot.errorText }
      : snapshot.status === "error"
        ? { stopReason: "aborted" }
        : {}),
  };
}

export function createSubagentTransport(
  options: SubagentTransportOptions,
): AgentTransport {
  const { manager, runtime } = options;
  const backend = options.backend ?? "pi";

  /** Resolves on the next manager change; the timer covers a lost wakeup. */
  const nextChange = Effect.callback<void>((resume) => {
    let done = false;
    const wake = () => {
      if (done) return;
      done = true;
      resume(Effect.void);
    };
    const unsubscribe = manager.view.subscribe(wake);
    // A slot may be freed by a different session in this process, which this
    // manager's view never reports.
    const unsubscribeBudget = onBudgetChange(wake);
    const timer = setTimeout(wake, CAPACITY_RECHECK_MS);
    return Effect.sync(() => {
      clearTimeout(timer);
      unsubscribeBudget();
      unsubscribe();
    });
  });

  /**
   * MAX_RUNNING is the single authoritative cap, so a refused spawn is
   * backpressure: queue for a slot rather than failing the workflow run.
   */
  const spawnQueued = (
    task: SpawnTask,
  ): Effect.Effect<SubagentSnapshot, unknown> =>
    manager.spawn(backend, task).pipe(
      Effect.catchIf(
        (error) => error._tag === "ConcurrencyLimitError",
        () =>
          nextChange.pipe(
            Effect.andThen(Effect.suspend(() => spawnQueued(task))),
          ),
      ),
    );

  /** A restarted child is still `done` until its pump reports the new run. */
  const awaitRunStart = (id: string) =>
    Effect.suspend(function loop(): Effect.Effect<void> {
      if (manager.view.get(id)?.status === "running") return Effect.void;
      return nextChange.pipe(Effect.andThen(Effect.suspend(loop)));
    }).pipe(Effect.timeout(RUN_START_TIMEOUT_MS), Effect.ignore);

  const createSession = async (
    prepared: PreparedAgentSession,
    context: AgentTransportContext,
  ): Promise<WorkflowAgentSession> => {
    const sessionId = randomUUID();
    const tools = toolNames(prepared);
    const prefix = personaPrefix(prepared);
    let subagentId: string | undefined;
    let firstTurn = true;
    /** Set when we asked for the stop, so it is not reported as a failure. */
    let abortRequested = false;
    /** The value `workflow_result` accepted, if the child submitted one. */
    let acceptedResult: string | undefined;

    const snapshot = () =>
      subagentId === undefined ? undefined : manager.view.get(subagentId);

    const state = (): WorkflowAgentSessionState => ({
      model: prepared.model,
      ...(prepared.model.thinking ? { thinking: prepared.model.thinking } : {}),
      tools,
      ...(prepared.systemPrompt !== undefined
        ? { systemPrompt: prepared.systemPrompt }
        : {}),
    });

    const runTurn = (text: string) =>
      Effect.gen(function* () {
        if (subagentId === undefined) {
          const spawned = yield* spawnQueued(
            buildSpawnTask(
              prepared,
              prefix && firstTurn ? `${prefix}\n\n---\n\n${text}` : text,
              options,
              (value) => {
                acceptedResult = value;
              },
            ),
          );
          subagentId = spawned.id;
        } else {
          yield* manager.send(subagentId, text);
        }
        firstTurn = false;
        yield* awaitRunStart(subagentId);
        // waitFor also marks the settle "consumed", so the subagents extension
        // does not deliver a duplicate result into the parent's context.
        yield* manager.waitFor([subagentId]);
      });

    return {
      get reference() {
        return {
          transport: WORKFLOW_TRANSPORT_ID,
          sessionId,
          locator: {
            subagentId,
            sessionFile: snapshot()?.meta.sessionFilePath,
            runId: context.run.runId,
          },
        };
      },
      getState: state,
      getSessionStats: () => {
        const tokens = snapshot()?.usage.tokens;
        if (tokens === undefined) return EMPTY_STATS;
        return {
          tokens: {
            input: tokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: tokens,
          },
          cost: 0,
        };
      },
      subscribe(listener) {
        listener({ type: "state_changed", state: state() });
        const running = new Map<string, string>();
        return manager.view.subscribe(() => {
          const snap = snapshot();
          if (!snap) return;
          const live = new Map(
            snap.liveTools.map((tool) => [tool.toolId, tool.name]),
          );
          for (const [toolCallId, toolName] of live) {
            if (running.has(toolCallId)) continue;
            running.set(toolCallId, toolName);
            listener({ type: "tool_execution_start", toolCallId, toolName });
          }
          for (const [toolCallId, toolName] of [...running]) {
            if (live.has(toolCallId)) continue;
            running.delete(toolCallId);
            listener({
              type: "tool_execution_end",
              toolCallId,
              toolName,
              isError: toolCallFailed(snap, toolCallId),
            });
          }
        });
      },
      async prompt(text) {
        await runTool(runtime, runTurn(text), {
          signal: context.signal,
          interruptMessage: "Workflow agent was cancelled.",
        });
        const snap = snapshot();
        return snap
          ? { assistant: assistantMessage(snap, abortRequested) }
          : {};
      },
      async steer(text) {
        if (subagentId === undefined) return;
        await runTool(runtime, manager.send(subagentId, text));
      },
      async abort() {
        if (subagentId === undefined) return;
        abortRequested = true;
        // `workflow_result` aborts the session as its normal success path, so
        // an abort that follows an accepted result must settle as a success.
        await runTool(
          runtime,
          acceptedResult === undefined
            ? manager.cancel([subagentId])
            : manager.completeAndStop(subagentId, acceptedResult),
        );
      },
      async dispose() {
        // The entry deliberately survives: `/subagents` and `subagent_list`
        // keep showing what the workflow ran, exactly like a tool-driven spawn.
        if (subagentId === undefined) return;
        abortRequested = true;
        await runTool(
          runtime,
          acceptedResult === undefined
            ? manager.cancel([subagentId])
            : manager.completeAndStop(subagentId, acceptedResult),
        ).catch(() => {});
      },
    };
  };

  return { id: WORKFLOW_TRANSPORT_ID, createSession };
}
