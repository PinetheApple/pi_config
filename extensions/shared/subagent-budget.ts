/**
 * Process-wide subagent budget and nesting depth.
 *
 * Every pi session builds its own `SubagentManager`, and a headless child is a
 * pi session, so `MAX_RUNNING` bounds one level only. Left alone, a tree of
 * depth d admits `MAX_RUNNING^d` concurrent children. These two limits are
 * what actually bound the tree:
 *
 * - a global slot budget every manager in the process draws from, and
 * - a depth ceiling that stops a subagent from orchestrating past it.
 *
 * Both live on `globalThis` for the same reason the host handle does: pi loads
 * each extension through its own jiti instance, so module state is not shared.
 */

/** Concurrent subagents allowed across every session in this process. */
export const MAX_TOTAL_RUNNING = 12;

/**
 * Nesting levels allowed. The root pi session is depth 0, so 10 permits ten
 * layers of subagents; the tenth cannot orchestrate further. Matches Claude
 * Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` semantics (1 = no nesting).
 */
export const MAX_SPAWN_DEPTH = 10;

interface BudgetState {
  running: number;
  /** Depth per child session file, written by the spawning parent. */
  readonly depths: Map<string, number>;
  readonly listeners: Set<() => void>;
}

interface BudgetSlot {
  __piSubagentBudget?: BudgetState;
}

const slot = globalThis as typeof globalThis & BudgetSlot;

function state() {
  return (slot.__piSubagentBudget ??= {
    running: 0,
    depths: new Map(),
    listeners: new Set(),
  });
}

function notify() {
  for (const listener of [...state().listeners]) listener();
}

/** Runs on every release, so a manager queued for a slot can retry. */
export function onBudgetChange(listener: () => void) {
  const { listeners } = state();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Take a global slot, or report that the process is saturated. */
export function acquireGlobalSlot() {
  const current = state();
  if (current.running >= MAX_TOTAL_RUNNING) return false;
  current.running += 1;
  return true;
}

/** Idempotency is the caller's job; a slot must be released exactly once. */
export function releaseGlobalSlot() {
  const current = state();
  if (current.running > 0) current.running -= 1;
  notify();
}

export function globalRunningCount() {
  return state().running;
}

/**
 * Record how deep a child session sits, before it binds its extensions. The
 * child reads this back at `session_start`; there is no per-session channel
 * into an in-process child, and `process.env` is shared by all of them.
 */
export function registerSessionDepth(sessionFile: string, depth: number) {
  state().depths.set(sessionFile, depth);
}

export function forgetSessionDepth(sessionFile: string) {
  state().depths.delete(sessionFile);
}

/** Unknown session file = a root session, which is depth 0. */
export function sessionDepth(sessionFile: string | undefined) {
  return sessionFile ? (state().depths.get(sessionFile) ?? 0) : 0;
}

/** True when a session at `depth` may still spawn children of its own. */
export function canSpawnAtDepth(depth: number) {
  return depth < MAX_SPAWN_DEPTH;
}

/** Test-only: drop all process-wide state between cases. */
export function resetSubagentBudget() {
  slot.__piSubagentBudget = undefined;
}
