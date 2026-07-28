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
import type {
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
    model: request.model,
    reasoningEffort: request.reasoningEffort,
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
}) {
  const task = buildSpawnTask(
    options.request,
    options.ctx,
    options.thinkingLevel,
  );
  const snapshot = await runTool(
    options.runtime,
    options.manager.spawn(options.harness, task),
    { signal: options.signal, interruptMessage: options.interruptMessage },
  );
  return { snapshot, task };
}
