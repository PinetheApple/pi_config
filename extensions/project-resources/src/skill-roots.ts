import * as fs from "node:fs";
import {
  CORE_DISCOVERED_SKILL_ROOTS,
  PROJECT_CONFIG_ROOTS,
  projectConfigDirs,
} from "../../shared/project-config-roots.ts";

/** Subdirectory holding skills inside each project config root. */
export const PROJECT_SKILLS_SUBDIR = "skills";

const EXTRA_SKILL_ROOTS = PROJECT_CONFIG_ROOTS.filter(
  (root) => !CORE_DISCOVERED_SKILL_ROOTS.includes(root),
);

/**
 * The `skills/` directories pi core does not look in, highest precedence
 * first. Core appends whatever we return to the paths it already loaded and
 * keeps the first declaration of each skill name, so returning them in
 * precedence order is what makes the dedupe come out right.
 *
 * `extendResources` applies no trust check of its own — the gate that keeps
 * `.pi/skills` out of an untrusted project lives in pi's package manager and
 * never sees these paths — so an untrusted project must contribute nothing.
 */
export function projectSkillPaths(options: {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}) {
  if (!options.projectTrusted) return [];
  return projectConfigDirs(
    options.cwd,
    PROJECT_SKILLS_SUBDIR,
    EXTRA_SKILL_ROOTS,
  ).filter((dir) => {
    // A missing path is reported as a diagnostic by core; only offer real ones.
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}
