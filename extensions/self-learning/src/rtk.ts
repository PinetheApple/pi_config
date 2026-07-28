import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readOptionalFile, type CommandRunner } from "./exec.ts";

const RTK_CONFIG_FILE = join(homedir(), ".config", "rtk", "config.toml");
const RTK_TIMEOUT_MS = 5_000;
const EXCLUDE_COMMANDS_ENTRY =
  /^[ \t]*exclude_commands[ \t]*=[ \t]*\[([^\]]*)\]/m;
const QUOTED_ENTRY = /"([^"]*)"/g;

/**
 * rtk's own `[hooks].exclude_commands` is the source of truth: it lists proxies
 * observed to corrupt results (rg drops --glob, diff reported false "identical").
 */
export function parseExcludedCommands(configToml: string) {
  const match = EXCLUDE_COMMANDS_ENTRY.exec(configToml);
  if (!match) return [];
  return [...match[1].matchAll(QUOTED_ENTRY)]
    .map((entry) => entry[1])
    .filter(Boolean);
}

export async function loadExcludedCommands() {
  return parseExcludedCommands(await readOptionalFile(RTK_CONFIG_FILE));
}

export function headCommand(command: string) {
  const [head] = command.trim().split(/\s+/);
  return head ? basename(head) : "";
}

export function isExcluded(command: string, excluded: string[]) {
  return excluded.includes(headCommand(command));
}

export function parseRtkRewrite(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const rewritten =
      JSON.parse(trimmed)?.hookSpecificOutput?.updatedInput?.command;
    return typeof rewritten === "string" && rewritten ? rewritten : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the rewritten command, or undefined when the command is left alone. */
export async function rewriteWithRtk(
  run: CommandRunner,
  command: string,
  cwd: string,
  excluded: string[],
) {
  if (!command.trim() || isExcluded(command, excluded)) return undefined;

  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  });
  const result = await run("rtk", ["hook", "claude"], {
    cwd,
    timeoutMs: RTK_TIMEOUT_MS,
    stdin: payload,
  });
  if (result.code !== 0) return undefined;

  const rewritten = parseRtkRewrite(result.stdout);
  return rewritten === command ? undefined : rewritten;
}
