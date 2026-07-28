/**
 * `/terminal-spawn <command>` — start a background terminal yourself and land
 * straight in the /ps dashboard with it selected, instead of asking the model
 * to call `bg_start`.
 *
 * `--name` and `--dir` may precede the command; everything after the leading
 * flags is the command, verbatim — it goes to the same shell invocation
 * `bg_start` uses, so quoting must survive the parse untouched.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseLeadingFlags } from "../../shared/flag-args.ts";
import type { TerminalManagerShape } from "./manager.ts";
import { runTool, type TerminalRuntime } from "./runtime.ts";
import { normalizeTerminalTitle } from "./title.ts";
import { openTerminalPicker } from "./ui/ps.ts";

export const TERMINAL_SPAWN_FLAGS = ["--name", "--dir"] as const;

export const TERMINAL_SPAWN_USAGE =
  "/terminal-spawn [--name <title>] [--dir <path>] <command>";

export interface ParsedTerminalSpawn {
  readonly command: string;
  readonly name?: string;
  readonly dir?: string;
}

export type TerminalSpawnParseResult =
  | { readonly ok: true; readonly value: ParsedTerminalSpawn }
  | { readonly ok: false; readonly error: string };

export function parseTerminalSpawnArgs(raw: string): TerminalSpawnParseResult {
  const parsed = parseLeadingFlags(raw, TERMINAL_SPAWN_FLAGS);
  if (!parsed.ok) {
    return {
      ok: false,
      error: `${parsed.error}\nUsage: ${TERMINAL_SPAWN_USAGE}`,
    };
  }
  if (!parsed.rest) {
    return { ok: false, error: `Usage: ${TERMINAL_SPAWN_USAGE}` };
  }
  return {
    ok: true,
    value: {
      command: parsed.rest,
      name: parsed.flags.get("--name"),
      dir: parsed.flags.get("--dir"),
    },
  };
}

/** Resolve and validate the child cwd. Throws when it is not a directory. */
export function resolveTerminalCwd(parentCwd: string, dir: string | undefined) {
  const cwd = path.resolve(parentCwd, dir ?? ".");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`--dir is not a directory: ${cwd}`);
  }
  return cwd;
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

export async function runTerminalSpawnCommand(options: {
  readonly rawArgs: string;
  readonly ctx: ExtensionCommandContext;
  readonly manager: TerminalManagerShape;
  readonly runtime: TerminalRuntime;
}) {
  const { ctx, manager } = options;
  const parsed = parseTerminalSpawnArgs(options.rawArgs);
  if (!parsed.ok) {
    report(ctx, parsed.error, true);
    return;
  }

  const { command, name, dir } = parsed.value;
  let id: string;
  try {
    const cwd = resolveTerminalCwd(ctx.cwd, dir);
    const snapshot = await runTool(
      options.runtime,
      manager.start({
        command,
        title: normalizeTerminalTitle(name ?? command),
        cwd,
      }),
    );
    id = snapshot.id;
  } catch (error) {
    // Bad --dir, spawn failure, or the concurrency cap: all readable.
    report(ctx, error instanceof Error ? error.message : String(error), true);
    return;
  }

  if (ctx.mode === "tui") {
    await openTerminalPicker(ctx, manager.view, { initialId: id });
    return;
  }
  report(ctx, `Started background terminal ${id}: ${command}`);
}
