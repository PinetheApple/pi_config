/**
 * The project-local config directories pi treats as equivalent, so an agent or
 * skill needs to exist in only one of them — no symlinks, no copies.
 *
 * Listed highest precedence first. The order is not arbitrary: pi core already
 * loads `.pi/skills` and `.agents/skills` itself, in that order, and resolves
 * skill-name collisions first-wins (`dist/core/skills.js`). An extension can
 * only append to that list, never reorder it, so `.pi` beats `.agents` for
 * skills whatever we do. Adopting the same order for agents — where we own the
 * whole search path — keeps one precedence rule for both resource types.
 */

import * as path from "node:path";

export const PROJECT_CONFIG_ROOTS = [".pi", ".agents", ".claude", ".ai"];

/**
 * Roots whose `skills/` directory pi core discovers on its own, gated on
 * project trust. Contributing those again from `resources_discover` would be
 * redundant, so the skills handler contributes only the complement.
 */
export const CORE_DISCOVERED_SKILL_ROOTS = [".pi", ".agents"];

/** `<cwd>/<root>/<subdir>` for each root, highest precedence first. */
export function projectConfigDirs(
  cwd: string,
  subdir: string,
  roots: readonly string[] = PROJECT_CONFIG_ROOTS,
) {
  return roots.map((root) => path.join(cwd, root, subdir));
}
