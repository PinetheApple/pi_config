/**
 * The session's current mode, and how it survives a resume, fork or reload.
 *
 * Mode changes are written as custom entries. Custom entries are durable and
 * excluded from LLM context, which is exactly right here: the model must not be
 * able to read — or argue with — the gate it is being held to.
 *
 * Persisted entry shape (`customType: "permission-mode"`), a compatibility
 * surface for sessions written by older builds:
 *
 * ```json
 * { "mode": "acceptEdits", "at": 1753800000000 }
 * ```
 *
 * `at` is informational. Only `mode` is read back, and an entry whose `mode` is
 * not a known mode is ignored rather than trusted.
 */

import {
  isPermissionMode,
  type PermissionMode,
} from "../../shared/permission-modes.ts";

export const PERMISSION_MODE_ENTRY = "permission-mode";

export interface PermissionModeEntry {
  readonly mode: PermissionMode;
  readonly at: number;
}

interface EntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/**
 * The last mode recorded on this session, or undefined for a session that never
 * set one. Reads every entry, including abandoned branches: a fork should keep
 * the mode it was forked at, and the alternative — replaying only the active
 * branch — would silently drop back to the configured default on any fork made
 * before the first mode change.
 */
export function restoreMode(entries: readonly EntryLike[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== PERMISSION_MODE_ENTRY) {
      continue;
    }
    const data = entry.data;
    if (typeof data !== "object" || data === null) continue;
    const mode = (data as { mode?: unknown }).mode;
    if (isPermissionMode(mode)) return mode;
  }
  return undefined;
}

export function modeEntry(mode: PermissionMode): PermissionModeEntry {
  return { mode, at: Date.now() };
}
