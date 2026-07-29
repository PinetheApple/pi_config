/**
 * The permission-mode vocabulary, shared by the `permissions` extension (which
 * enforces it) and `subagents` (which projects it onto a child harness).
 *
 * A deliberate subset of Claude Code's modes. Excluded, and why:
 * - `auto` / `dontAsk` — not separate modes here. `auto` is the *label* worn by
 *   `bypassPermissions`, because `deny` rules survive it (see `decide.ts`), so
 *   "never prompt, honour deny" is already exactly what it does. One
 *   enforcement path, one id; three names for it would be a footgun on a
 *   security surface.
 * - `manual` — its Claude Code semantics could not be verified from anything in
 *   this checkout, and it adds no enforcement `plan` and `default` lack.
 *
 * Ordered strictest first. The index *is* the strictness rank, so "tighten,
 * never loosen" is a `Math.min` that cannot drift from the list. Note this is
 * deliberately *not* the cycle order: `plan` denies every mutating tool, which
 * makes it stricter than `default`, but it sits second in the cycle because
 * that is the order a user reaches for. See `CYCLED_PERMISSION_MODES`.
 */
export const PERMISSION_MODES = [
  "plan",
  "default",
  "acceptEdits",
  "bypassPermissions",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The strictest mode there is — where anything unrecognised has to land. */
export const STRICTEST_PERMISSION_MODE: PermissionMode = PERMISSION_MODES[0];

/**
 * What shift+tab walks through, in the order the user asked for:
 * `default → plan → acceptEdits → auto`, wrapping back to `default`.
 *
 * `bypassPermissions` (shown as `auto`) is in the cycle, one keystroke away
 * like the others. That is only tenable because `deny` rules are evaluated
 * *before* bypass in `decide()`, so even the loosest mode means "stop
 * prompting", not "ignore the rules". If that ordering ever changes, this
 * decision has to change with it.
 */
export const CYCLED_PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
] as const;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value);
}

function rank(mode: PermissionMode) {
  return PERMISSION_MODES.indexOf(mode);
}

/** The stricter of two modes. Never widens, whichever order it is called in. */
export function strictestMode(a: PermissionMode, b: PermissionMode) {
  return rank(a) <= rank(b) ? a : b;
}

export function cyclePermissionMode(mode: PermissionMode): PermissionMode {
  const index = CYCLED_PERMISSION_MODES.indexOf(mode);
  return CYCLED_PERMISSION_MODES[(index + 1) % CYCLED_PERMISSION_MODES.length];
}

/**
 * The mode a spawned child runs under.
 *
 * Two settled rules meet here and pull in different directions, so the shape is
 * not symmetric:
 *
 * - A definition that says nothing gets `bypassPermissions`, whatever the
 *   session is doing. Inheriting a tightened session mode would break every
 *   existing spawn, and a headless child cannot answer a prompt anyway.
 * - A definition that names a mode has opted in, so it is bounded by the
 *   session as well: the child runs under whichever of the two is stricter and
 *   can never be looser than the session it was spawned from.
 */
export function effectiveAgentMode(options: {
  readonly sessionMode?: PermissionMode;
  readonly definitionMode?: PermissionMode;
}): PermissionMode {
  if (!options.definitionMode) return "bypassPermissions";
  if (!options.sessionMode) return options.definitionMode;
  return strictestMode(options.sessionMode, options.definitionMode);
}

export const PERMISSION_MODE_LABELS: Readonly<Record<PermissionMode, string>> =
  {
    plan: "plan (read-only)",
    default: "default (ask to change)",
    acceptEdits: "accept edits",
    bypassPermissions: "auto (bypass permissions)",
  };
