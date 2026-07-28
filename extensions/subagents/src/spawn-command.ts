/**
 * `/subagent-spawn` — start a subagent with explicit config instead of asking
 * the model to call `subagent_spawn`.
 *
 * Two surfaces over one spawn path (`./spawn.ts`):
 * - flags: `/subagent-spawn --agent <name> --harness pi --model <id>
 *   --effort high --dir <path> --name <title> <prompt text>`
 * - wizard: anything a partial invocation left out is asked for, in order,
 *   through the TUI dialogs. Escape at any step aborts without spawning.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseLeadingFlags } from "../../shared/flag-args.ts";
import type { AgentDefinition } from "./agent-defs.ts";
import {
  BACKEND_NAMES,
  type BackendName,
  type ReasoningEffort,
  REASONING_EFFORTS,
} from "./domain.ts";
import type { SubagentManagerShape } from "./manager.ts";
import { spawnSubagent } from "./spawn.ts";
import { deriveTitleFromPrompt } from "./title.ts";
import type { SubagentRuntime } from "./runtime.ts";
import { openSubagentTakeover } from "./ui/takeover.ts";

export const SPAWN_COMMAND_FLAGS = [
  "--agent",
  "--harness",
  "--model",
  "--effort",
  "--dir",
  "--name",
] as const;

export const SPAWN_COMMAND_USAGE =
  "/subagent-spawn [--agent <name>] [--harness pi|claude|codex] [--model <id>] [--effort <level>] [--dir <path>] [--name <title>] <prompt>";

const DEFAULT_HARNESS: BackendName = "pi";
const WIZARD_TITLE_MAX_LENGTH = 60;
/** Explicit "no override" choice in the model / effort selectors. */
const INHERIT_CHOICE = "inherit from this session";

export interface ParsedSpawnCommand {
  readonly agent?: string;
  readonly harness?: BackendName;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly dir?: string;
  readonly name?: string;
  /** Undefined when no prompt text followed the flags. */
  readonly prompt?: string;
}

export type SpawnCommandParseResult =
  | { readonly ok: true; readonly value: ParsedSpawnCommand }
  | { readonly ok: false; readonly error: string };

function asEnum<T extends string>(values: readonly T[], value: string) {
  return values.find((candidate) => candidate === value);
}

export function parseSpawnCommandArgs(raw: string): SpawnCommandParseResult {
  const parsed = parseLeadingFlags(raw, SPAWN_COMMAND_FLAGS);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${parsed.error}\nUsage: ${SPAWN_COMMAND_USAGE}`,
    };
  }

  const harnessFlag = parsed.flags.get("--harness");
  const harness = harnessFlag ? asEnum(BACKEND_NAMES, harnessFlag) : undefined;
  if (harnessFlag && !harness) {
    return {
      ok: false,
      error: `Unknown --harness "${harnessFlag}". Choose one of: ${BACKEND_NAMES.join(", ")}.`,
    };
  }

  const effortFlag = parsed.flags.get("--effort");
  const effort = effortFlag ? asEnum(REASONING_EFFORTS, effortFlag) : undefined;
  if (effortFlag && !effort) {
    return {
      ok: false,
      error: `Unknown --effort "${effortFlag}". Choose one of: ${REASONING_EFFORTS.join(", ")}.`,
    };
  }

  return {
    ok: true,
    value: {
      agent: parsed.flags.get("--agent"),
      harness,
      model: parsed.flags.get("--model"),
      effort,
      dir: parsed.flags.get("--dir"),
      name: parsed.flags.get("--name"),
      prompt: parsed.rest || undefined,
    },
  };
}

/** Fall back to the prompt's first line when no `--name` was given. */
export function deriveSpawnTitle(prompt: string) {
  return deriveTitleFromPrompt(prompt, {
    fallback: "subagent",
    maxLength: WIZARD_TITLE_MAX_LENGTH,
  });
}

interface ResolvedSpawnCommand {
  readonly agent?: string;
  readonly harness: BackendName;
  readonly prompt: string;
  readonly title: string;
  readonly model?: string;
  readonly effort?: ReasoningEffort;
  readonly dir?: string;
}

/** Non-interactive path (print/RPC without dialogs): flags or defaults only. */
function resolveWithDefaults(
  parsed: ParsedSpawnCommand,
): ResolvedSpawnCommand | undefined {
  if (!parsed.prompt) return undefined;
  return {
    agent: parsed.agent,
    harness: parsed.harness ?? DEFAULT_HARNESS,
    prompt: parsed.prompt,
    title: parsed.name ?? deriveSpawnTitle(parsed.prompt),
    model: parsed.model,
    effort: parsed.effort,
    dir: parsed.dir,
  };
}

/**
 * Ask for whatever the invocation left out. Returns undefined when the user
 * escapes out of any step — nothing is spawned in that case.
 */
async function runWizard(
  parsed: ParsedSpawnCommand,
  ctx: ExtensionCommandContext,
): Promise<ResolvedSpawnCommand | undefined> {
  let prompt = parsed.prompt;
  if (!prompt) {
    const entered = await ctx.ui.editor("Subagent prompt");
    prompt = entered?.trim();
    if (!prompt) return undefined;
  }

  let harness = parsed.harness;
  if (!harness) {
    const picked = await ctx.ui.select("Harness", [...BACKEND_NAMES]);
    if (!picked) return undefined;
    harness = asEnum(BACKEND_NAMES, picked) ?? DEFAULT_HARNESS;
  }

  let model = parsed.model;
  if (model === undefined) {
    model = await pickModel(harness, ctx);
    if (model === undefined) return undefined;
    if (model === "") model = undefined;
  }

  let effort = parsed.effort;
  if (!effort) {
    const picked = await ctx.ui.select("Reasoning effort", [
      INHERIT_CHOICE,
      ...REASONING_EFFORTS,
    ]);
    if (!picked) return undefined;
    effort = asEnum(REASONING_EFFORTS, picked);
  }

  let title = parsed.name;
  if (!title) {
    const entered = await ctx.ui.input(
      "Subagent name",
      `leave empty for "${deriveSpawnTitle(prompt)}"`,
    );
    if (entered === undefined) return undefined;
    title = entered.trim() || deriveSpawnTitle(prompt);
  }

  return {
    agent: parsed.agent,
    harness,
    prompt,
    title,
    model,
    effort,
    dir: parsed.dir,
  };
}

/**
 * pi resolves models through the parent registry, so it gets a real list.
 * claude/codex take their own model slugs, which pi knows nothing about.
 * Returns "" for "inherit", undefined when the user escaped.
 */
async function pickModel(harness: BackendName, ctx: ExtensionCommandContext) {
  if (harness !== "pi") {
    const entered = await ctx.ui.input(
      `Model for ${harness}`,
      "leave empty for the harness default",
    );
    return entered === undefined ? undefined : entered.trim();
  }

  const available = ctx.modelRegistry
    .getAvailable()
    .map((model) => `${model.provider}/${model.id}`)
    .sort();
  const picked = await ctx.ui.select("Model", [INHERIT_CHOICE, ...available]);
  if (!picked) return undefined;
  return picked === INHERIT_CHOICE ? "" : picked;
}

function report(
  ctx: ExtensionCommandContext,
  message: string,
  isError = false,
) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, isError ? "error" : "info");
    return;
  }
  if (isError) console.error(message);
  else console.log(message);
}

export async function runSubagentSpawnCommand(options: {
  readonly rawArgs: string;
  readonly ctx: ExtensionCommandContext;
  readonly manager: SubagentManagerShape;
  readonly runtime: SubagentRuntime;
  readonly thinkingLevel: string | undefined;
  readonly agentDefinitions?: readonly AgentDefinition[];
}) {
  const { ctx, manager } = options;
  const parsed = parseSpawnCommandArgs(options.rawArgs);
  if (!parsed.ok) {
    report(ctx, parsed.error, true);
    return;
  }

  const resolved = ctx.hasUI
    ? await runWizard(parsed.value, ctx)
    : // No dialogs available: defaults for everything the flags left out.
      resolveWithDefaults(parsed.value);
  if (!resolved) {
    if (!ctx.hasUI) {
      report(ctx, `A prompt is required.\nUsage: ${SPAWN_COMMAND_USAGE}`, true);
    }
    return;
  }

  let id: string;
  let title: string;
  try {
    const { snapshot } = await spawnSubagent({
      runtime: options.runtime,
      manager,
      harness: resolved.harness,
      request: {
        prompt: resolved.prompt,
        title: resolved.title,
        workingDir: resolved.dir,
        workingDirLabel: "--dir",
        model: resolved.model,
        reasoningEffort: resolved.effort,
      },
      agentName: resolved.agent,
      agentDefinitions: options.agentDefinitions,
      ctx,
      thinkingLevel: options.thinkingLevel,
    });
    id = snapshot.id;
    title = snapshot.title;
  } catch (error) {
    // Concurrency limit, unknown model, unavailable backend: all readable.
    report(ctx, error instanceof Error ? error.message : String(error), true);
    return;
  }

  if (ctx.mode === "tui") {
    await openSubagentTakeover(ctx, manager.view, id);
    return;
  }
  report(ctx, `Spawned subagent ${id} "${title}" on ${resolved.harness}.`);
}
