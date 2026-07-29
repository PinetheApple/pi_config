/**
 * Where the rules come from.
 *
 * Two user-global layers, both in Claude Code's own `permissions` shape:
 *
 * 1. `~/.claude/settings.json` — the user's existing rules, read in place.
 *    Copying them into a pi-specific file would create two sources of truth
 *    for one policy and guarantee drift the first time either is edited.
 * 2. `~/.pi/agent/permissions.json` — pi-side additions, and the home of
 *    `defaultMode`. Same schema, so entries can be moved between the two files
 *    verbatim.
 *
 * The layers are unioned rather than ranked: `decide()` already orders the
 * result deny -> ask -> allow, so a deny in either file beats an allow in the
 * other whichever way round they are read.
 *
 * Project-local rules are deliberately *not* read. A repo that could contribute
 * `allow` entries would be a way for checked-in config to widen the gate, and
 * nothing in this task needs it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isPermissionMode,
  type PermissionMode,
} from "../../shared/permission-modes.ts";
import { parseRules, type PermissionRule } from "./rules.ts";

export const CLAUDE_SETTINGS_PATH = path.join(
  os.homedir(),
  ".claude",
  "settings.json",
);

export const PI_PERMISSIONS_FILENAME = "permissions.json";

/** Mode a session starts in when no config says otherwise. */
export const FALLBACK_MODE: PermissionMode = "default";

export interface RuleSet {
  readonly deny: readonly PermissionRule[];
  readonly ask: readonly PermissionRule[];
  readonly allow: readonly PermissionRule[];
}

export interface PermissionConfig {
  readonly mode: PermissionMode;
  readonly rules: RuleSet;
  /** Files that were read, for `/permissions` to report. */
  readonly sources: readonly string[];
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // A missing file is the normal case and a malformed one must not take the
    // gate down with it — an unreadable layer contributes no rules, which
    // errs toward asking rather than toward allowing.
    return undefined;
  }
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The `permissions` block of one file, in Claude Code's shape. */
function readLayer(file: string) {
  const parsed = readJson(file);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const permissions =
    typeof record.permissions === "object" && record.permissions !== null
      ? (record.permissions as Record<string, unknown>)
      : {};
  return {
    allow: stringList(permissions.allow),
    ask: stringList(permissions.ask),
    deny: stringList(permissions.deny),
    defaultMode: record.defaultMode,
  };
}

export function loadPermissionConfig(options: {
  readonly agentDir: string;
  /** Overridable so tests need not touch the real home directory. */
  readonly claudeSettingsPath?: string;
}): PermissionConfig {
  const files = [
    options.claudeSettingsPath ?? CLAUDE_SETTINGS_PATH,
    path.join(options.agentDir, PI_PERMISSIONS_FILENAME),
  ];

  const allow: PermissionRule[] = [];
  const ask: PermissionRule[] = [];
  const deny: PermissionRule[] = [];
  const sources: string[] = [];
  let mode: PermissionMode | undefined;

  for (const file of files) {
    const layer = readLayer(file);
    if (!layer) continue;
    sources.push(file);
    allow.push(...parseRules(layer.allow, "allow"));
    ask.push(...parseRules(layer.ask, "ask"));
    deny.push(...parseRules(layer.deny, "deny"));
    // Later layer wins: pi's own file is the one that should decide how pi starts.
    if (isPermissionMode(layer.defaultMode)) mode = layer.defaultMode;
  }

  return { mode: mode ?? FALLBACK_MODE, rules: { allow, ask, deny }, sources };
}
