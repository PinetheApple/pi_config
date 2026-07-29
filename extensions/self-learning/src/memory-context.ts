import { homedir } from "node:os";
import { join } from "node:path";
import { readOptionalFile } from "./exec.ts";

const AI_CONFIG_ROOT = join(homedir(), ".config", "ai");
const PERSONA_FILE = join(AI_CONFIG_ROOT, "persona.md");
const GLOBAL_MEMORY_INDEX = join(AI_CONFIG_ROOT, "memory", "MEMORY.md");
const WORKTREE_SUFFIX = /--claude-worktrees-.*$/;
/**
 * Claude Code's project-slug encoding: `/`, `.` and `_` all collapse to `-`,
 * everything else (case, existing hyphens, digits) is preserved. Derived by
 * checking every slug in `~/.config/ai/projects` against its real path — e.g.
 * `/home/pineapple/.pi/agent` → `-home-pineapple--pi-agent` and
 * `/home/pineapple/Development/music_app` → `-home-pineapple-Development-music-app`.
 */
const SLUG_SEPARATORS = /[/._]/g;

const BOOTSTRAP_HEADING = "# Agent Session Bootstrap";
const BOOTSTRAP_NUDGE =
  "Scan the memory index each turn and apply what fits, silently. When a turn " +
  "produces durable signal — a correction, a stated preference, a confirmed " +
  "non-obvious approach — capture it with the `auto-memory` skill before ending " +
  "the turn.";

/** A worktree shares its parent's memory store, so the branch suffix is stripped. */
export function projectSlug(cwd: string) {
  return cwd.replace(SLUG_SEPARATORS, "-").replace(WORKTREE_SUFFIX, "");
}

export function projectMemoryIndexPath(cwd: string) {
  return join(
    AI_CONFIG_ROOT,
    "projects",
    projectSlug(cwd),
    "memory",
    "MEMORY.md",
  );
}

export interface BootstrapSources {
  persona: string;
  globalMemoryIndex: string;
  projectMemoryIndex: string;
}

export function composeBootstrap(sources: BootstrapSources) {
  const parts: string[] = [];
  if (sources.persona) parts.push("## Persona", sources.persona);
  if (sources.globalMemoryIndex) {
    parts.push("", "## Memory Index", sources.globalMemoryIndex);
  }
  if (sources.projectMemoryIndex) {
    parts.push("", "## Project Memory Index", sources.projectMemoryIndex);
  }
  if (parts.length === 0) return undefined;

  parts.push("", BOOTSTRAP_NUDGE);
  return [BOOTSTRAP_HEADING, "", ...parts].join("\n");
}

/** Read fresh every turn: the agent writes these files mid-session. */
export async function loadBootstrap(cwd: string) {
  const [persona, globalMemoryIndex, projectMemoryIndex] = await Promise.all([
    readOptionalFile(PERSONA_FILE),
    readOptionalFile(GLOBAL_MEMORY_INDEX),
    readOptionalFile(projectMemoryIndexPath(cwd)),
  ]);
  return composeBootstrap({
    persona: persona.trim(),
    globalMemoryIndex: globalMemoryIndex.trim(),
    projectMemoryIndex: projectMemoryIndex.trim(),
  });
}
