/**
 * The gate. Pure: it takes a tool call, a rule set and a mode, and returns one
 * of allow / ask / deny. `index.ts` turns an `ask` into a `ctx.ui.confirm()`.
 */

import * as path from "node:path";
import type { PermissionMode } from "../../shared/permission-modes.ts";
import {
  firstMatch,
  resourceOf,
  type PermissionRule,
  type ToolCall,
} from "./rules.ts";

export type DecisionEffect = "allow" | "ask" | "deny";

export interface Decision {
  readonly effect: DecisionEffect;
  /** Shown to the model on a block, and in the confirm dialog on an ask. */
  readonly reason: string;
}

/**
 * Tools that change something outside the session. Anything unrecognised —
 * every custom and extension-provided tool — is treated as mutating, so a new
 * tool arrives gated rather than silently exempt.
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "rg",
  "find",
  "fd",
  "ls",
  "web_search",
  "web_fetch",
]);

/** Tools `acceptEdits` auto-approves, when they stay inside the session cwd. */
const EDIT_TOOLS = new Set(["write", "edit"]);

export function isReadOnlyTool(toolName: string) {
  return READ_ONLY_TOOLS.has(toolName);
}

function withinCwd(call: ToolCall) {
  const resource = resourceOf(call);
  if (resource === undefined) return false;
  const relative = path.relative(call.cwd, resource);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

interface Rules {
  readonly deny: readonly PermissionRule[];
  readonly ask: readonly PermissionRule[];
  readonly allow: readonly PermissionRule[];
}

function byMode(mode: PermissionMode, call: ToolCall): Decision {
  if (isReadOnlyTool(call.toolName)) {
    return { effect: "allow", reason: `${call.toolName} is read-only` };
  }
  if (mode === "plan") {
    return {
      effect: "deny",
      reason: `plan mode is read-only; ${call.toolName} would change something. Present the plan instead, or leave plan mode with shift+tab.`,
    };
  }
  if (
    mode === "acceptEdits" &&
    EDIT_TOOLS.has(call.toolName) &&
    withinCwd(call)
  ) {
    return {
      effect: "allow",
      reason: "acceptEdits: file edit inside the working directory",
    };
  }
  return {
    effect: "ask",
    reason: `${call.toolName} can change things outside this session`,
  };
}

/**
 * Precedence is deny -> ask -> allow, matching Claude Code, then the mode.
 *
 * Two deliberate divergences, both stated rather than inferred:
 *
 * - `deny` rules are evaluated *before* `bypassPermissions`, so bypass cannot
 *   widen past them. Claude Code's bypass skips everything. This is the
 *   stricter reading, the settled "tighten, never loosen" rule requires it, and
 *   it is what makes bypass safe to put one keystroke away: the loosest mode
 *   means "stop prompting", not "ignore the rules".
 * - `ask` rules are skipped under `bypassPermissions`. Honouring them would
 *   make bypass indistinguishable from `default`, which is the whole point of
 *   the mode. `deny` stays because it is a boundary; `ask` is a prompt.
 */
export function decide(options: {
  readonly call: ToolCall;
  readonly rules: Rules;
  readonly mode: PermissionMode;
}): Decision {
  const { call, rules, mode } = options;

  const denied = firstMatch(rules.deny, call);
  if (denied) {
    return {
      effect: "deny",
      reason: `denied by permission rule ${denied.source}`,
    };
  }

  if (mode === "bypassPermissions") {
    return { effect: "allow", reason: "bypassPermissions" };
  }

  const asked = firstMatch(rules.ask, call);
  if (asked) {
    return {
      effect: "ask",
      reason: `permission rule ${asked.source} requires confirmation`,
    };
  }

  const allowed = firstMatch(rules.allow, call);
  if (allowed) {
    return {
      effect: "allow",
      reason: `allowed by permission rule ${allowed.source}`,
    };
  }

  return byMode(mode, call);
}

/**
 * What an `ask` becomes when there is nobody to ask — a headless subagent, an
 * `-p` run, an RPC turn with no dialog surface.
 *
 * Fails closed. The alternative, falling through to the agent's own mode, would
 * let an unattended child auto-approve precisely the calls a rule marked as
 * needing a human, which inverts the reason the rule exists. In practice this
 * rarely fires: a spawned child runs under `bypassPermissions` unless its
 * definition asked for something stricter, and bypass never reaches an ask.
 */
export function resolveUnattended(decision: Decision): Decision {
  if (decision.effect !== "ask") return decision;
  return {
    effect: "deny",
    reason: `${decision.reason}, and there is no interactive UI here to confirm it. Ask the user to run this themselves, or have them add an allow rule.`,
  };
}
