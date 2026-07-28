/**
 * The one place a subagent is validated and started.
 *
 * Both callers — the model-facing `subagent_spawn` tool and the user-facing
 * `/subagent-spawn` command — build their SpawnTask here, so cwd validation,
 * title bounding, and child trust resolution cannot drift apart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentDefinition,
  findAgentDefinition,
  resolveAgentForHarness,
} from "./agent-defs.ts";
import { CHILD_EXCLUDED_TOOL_NAMES } from "./domain.ts";
import type {
  AgentSpec,
  BackendName,
  ReasoningEffort,
  SpawnTask,
  SubagentOrigin,
} from "./domain.ts";
import type { SubagentManagerShape } from "./manager.ts";
import { runTool, type SubagentRuntime } from "./runtime.ts";
import { normalizeTitle } from "./title.ts";

export const SUBAGENT_TITLE_MAX_LENGTH = 160;

/** Parent-session facts a spawn needs; a subset of ExtensionContext. */
export type SpawnParentContext = Pick<
  ExtensionContext,
  "cwd" | "model" | "modelRegistry" | "isProjectTrusted"
>;

export interface SubagentSpawnRequest {
  readonly prompt: string;
  readonly title: string;
  /** Resolved against the parent cwd. Omitted = the parent cwd itself. */
  readonly workingDir?: string;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly origin?: SubagentOrigin;
  /** Name of the caller's directory argument, used in validation errors. */
  readonly workingDirLabel?: string;
  /** Already projected onto the target harness by `resolveSpawnAgent`. */
  readonly agent?: AgentSpec;
}

/**
 * Look the agent up and project it onto the harness. An unknown name is a
 * hard error: silently spawning a generic child would hide the fact that the
 * requested persona never applied.
 */
export function resolveSpawnAgent(options: {
  readonly agentName: string | undefined;
  readonly definitions: readonly AgentDefinition[];
  readonly harness: BackendName;
  readonly ctx: SpawnParentContext;
}): { spec?: AgentSpec; warnings: readonly string[] } {
  if (!options.agentName) return { warnings: [] };
  const definition = findAgentDefinition(
    options.definitions,
    options.agentName,
  );
  if (!definition) {
    const known = options.definitions.map((def) => def.name).join(", ");
    throw new Error(
      `Unknown agent "${options.agentName}". Available: ${known || "none"}.`,
    );
  }
  return resolveAgentForHarness({
    definition,
    harness: options.harness,
    registry: options.ctx.modelRegistry,
    provider: options.ctx.model?.provider,
    toolDenylist: CHILD_EXCLUDED_TOOL_NAMES,
  });
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
export function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

/** Resolve and validate a child cwd. Throws when it is not a directory. */
export function resolveSpawnCwd(
  parentCwd: string,
  workingDir: string | undefined,
  label = "working_dir",
) {
  const cwd = path.resolve(parentCwd, workingDir ?? ".");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`${label} is not a directory: ${cwd}`);
  }
  return cwd;
}

export function buildSpawnTask(
  request: SubagentSpawnRequest,
  ctx: SpawnParentContext,
  thinkingLevel: string | undefined,
): SpawnTask {
  const cwd = resolveSpawnCwd(
    ctx.cwd,
    request.workingDir,
    request.workingDirLabel,
  );
  return {
    origin: request.origin,
    prompt: request.prompt,
    title: normalizeTitle(request.title, {
      fallback: "subagent",
      maxLength: SUBAGENT_TITLE_MAX_LENGTH,
    }),
    cwd,
    // Omitted model / effort inherit the parent's via the backend defaults.
    // An explicit model on the call outranks the agent's declared default.
    model: request.model ?? request.agent?.model,
    reasoningEffort: request.reasoningEffort,
    agent: request.agent,
    parent: {
      parentCwd: ctx.cwd,
      projectTrusted: resolveChildProjectTrust({
        parentCwd: ctx.cwd,
        childCwd: cwd,
        parentTrusted: ctx.isProjectTrusted(),
      }),
      inheritedModel: ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined,
      inheritedThinkingLevel: thinkingLevel,
      modelRegistry: ctx.modelRegistry,
    },
  };
}

/** Validate, build the task, and run the manager spawn effect. */
export async function spawnSubagent(options: {
  readonly runtime: SubagentRuntime;
  readonly manager: SubagentManagerShape;
  readonly harness: BackendName;
  readonly request: SubagentSpawnRequest;
  readonly ctx: SpawnParentContext;
  readonly thinkingLevel: string | undefined;
  readonly signal?: AbortSignal;
  readonly interruptMessage?: string;
  readonly agentName?: string;
  readonly agentDefinitions?: readonly AgentDefinition[];
}) {
  const agent = resolveSpawnAgent({
    agentName: options.agentName,
    definitions: options.agentDefinitions ?? [],
    harness: options.harness,
    ctx: options.ctx,
  });
  const task = buildSpawnTask(
    { ...options.request, agent: agent.spec },
    options.ctx,
    options.thinkingLevel,
  );
  const snapshot = await runTool(
    options.runtime,
    options.manager.spawn(options.harness, task),
    { signal: options.signal, interruptMessage: options.interruptMessage },
  );
  return { snapshot, task, warnings: agent.warnings };
}
