/**
 * Teach pi to find skills in every project config root, not just `.pi`.
 *
 * pi core hardcodes `<cwd>/.pi/skills` and `<cwd>/.agents/skills`; the roots a
 * repo actually carries are usually `.claude` or `.ai`. `resources_discover`
 * is the supported way to add to the skill set without touching core.
 *
 * Agent definitions use the same root list but a different mechanism — see
 * `extensions/subagents/src/agent-defs.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectSkillPaths } from "./src/skill-roots.ts";

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", (event, ctx) => ({
    // The event carries the session's own cwd, which is not the process cwd:
    // a headless child runs in the parent's process against another directory.
    skillPaths: projectSkillPaths({
      cwd: event.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    }),
  }));
}
