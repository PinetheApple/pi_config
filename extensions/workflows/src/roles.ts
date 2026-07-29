/**
 * Workflow roles resolved from `~/.config/ai/agents`.
 *
 * `pi-extensible-workflows` has its own role directory and frontmatter
 * dialect. Rather than teaching it a second dialect, this hook lets an
 * in-house Claude-format agent definition win for a role of the same name,
 * reusing `agent-defs.ts` so there is exactly one parser and one catalog.
 * Roles it does not recognise are left untouched for the package to resolve.
 */

import { CHILD_EXCLUDED_TOOL_NAMES } from "../../shared/child-session.ts";
import type { AgentSetup } from "../../shared/workflow-transport.ts";
import {
  type AgentDefinition,
  loadSessionAgentDefinitions,
  resolveAgentForHarness,
} from "../../subagents/src/agent-defs.ts";

/** The package requires a JS identifier here, not a kebab-case slug. */
export const ROLE_HOOK_NAME = "inHouseAgentRoles";

interface ResolvedRole {
  readonly systemPrompt: string;
  readonly tools?: ReadonlySet<string>;
  readonly warnings: readonly string[];
}

/**
 * The hook is a pure lookup over a catalog loaded per session. Which
 * definitions those are depends on the session's cwd and whether its project
 * is trusted, neither of which is known when the package registers the hook,
 * so the catalog stays empty — every role falling through to the package —
 * until `session_start` fills it.
 */
export function createRoleSetupHook() {
  const roles = new Map<string, ResolvedRole>();
  const warned = new Set<string>();
  let onWarnings:
    ((role: string, warnings: readonly string[]) => void) | undefined;

  function load(definitions: readonly AgentDefinition[]) {
    roles.clear();
    warned.clear();
    for (const definition of definitions) {
      const resolution = resolveAgentForHarness({
        definition,
        harness: "pi",
        toolDenylist: CHILD_EXCLUDED_TOOL_NAMES,
      });
      roles.set(definition.name, {
        systemPrompt: resolution.spec.systemPrompt,
        ...(resolution.spec.tools
          ? { tools: new Set(resolution.spec.tools) }
          : {}),
        warnings: resolution.warnings,
      });
    }
  }

  const hook = {
    setup(agent: AgentSetup) {
      const role = agent.options.role;
      if (typeof role !== "string") return;
      const resolved = roles.get(role);
      if (!resolved) return;
      // Once per role per session: a fan-out of ten agents on one role should
      // not produce ten identical notifications.
      if (resolved.warnings.length > 0 && !warned.has(role)) {
        warned.add(role);
        onWarnings?.(role, resolved.warnings);
      }
      agent.sessionInput.systemPrompt = resolved.systemPrompt;
      agent.sessionInput.systemPromptAppend = "";
      // Narrowing only: the package rejects any widening of the tool policy.
      const allowed = resolved.tools;
      if (allowed) {
        agent.sessionInput.tools = agent.sessionInput.tools.filter((tool) =>
          allowed.has(tool),
        );
      }
    },
  };

  return {
    hook,
    load,
    /**
     * A role definition is a system prompt, and an untrusted project's
     * `_shared/` fragments are inlined into agents from every other layer, so
     * an untrusted project is left off the search path rather than filtered
     * out of its results.
     */
    loadForSession: (options: { cwd: string; projectTrusted: boolean }) =>
      load(loadSessionAgentDefinitions(options)),
    roleNames: () => [...roles.keys()],
    /** Register the sink for spawn-time warnings. */
    onWarnings(sink: (role: string, warnings: readonly string[]) => void) {
      onWarnings = sink;
    },
    /** Warnings a role would produce, without spawning it. */
    warningsFor: (role: string) => roles.get(role)?.warnings ?? [],
  };
}
