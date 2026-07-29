/**
 * The permission mode a spawned pi child runs under.
 *
 * A headless child binds the same extensions as its parent, so without this the
 * `permissions` extension would read the *configured* default out of
 * `permissions.json` and start gating a child that has no UI to answer with —
 * turning every existing subagent spawn into a wall of fail-closed blocks.
 *
 * Same mechanism, and the same reasoning, as `registerSessionDepth`: the child
 * runs in the parent's process, there is no per-session channel into it, and
 * `process.env` is shared by every concurrent child. The session file is the
 * only identifier both sides already agree on.
 */

import type { PermissionMode } from "./permission-modes.ts";

interface ModeSlot {
  __piChildPermissionModes?: Map<string, PermissionMode>;
}

const slot = globalThis as typeof globalThis & ModeSlot;

function modes() {
  slot.__piChildPermissionModes ??= new Map();
  return slot.__piChildPermissionModes;
}

/** Must be called before the child binds its extensions. */
export function registerChildPermissionMode(
  sessionFile: string,
  mode: PermissionMode,
) {
  modes().set(sessionFile, mode);
}

export function forgetChildPermissionMode(sessionFile: string) {
  modes().delete(sessionFile);
}

/**
 * Undefined for a root session, which takes its mode from config instead. A
 * child never falls back to config: an unregistered child would silently be
 * gated, which is the failure this registry exists to prevent.
 */
export function childPermissionMode(sessionFile: string | undefined) {
  return sessionFile ? modes().get(sessionFile) : undefined;
}

/** Test-only: drop all process-wide state between cases. */
export function resetChildPermissionModes() {
  slot.__piChildPermissionModes = new Map();
}
