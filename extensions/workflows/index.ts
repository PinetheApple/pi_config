/**
 * Workflow orchestration hosted on the in-house subagents layer.
 *
 * `pi-extensible-workflows` hardcodes nothing: its default export takes an
 * `AgentTransport` as its fourth argument. This extension is the thin host
 * that supplies ours, so workflow agents are ordinary subagents — counted by
 * MAX_RUNNING, listed by `subagent_list`, killable by `subagent_cancel` —
 * instead of a second, unbounded pool of children.
 *
 * The package must therefore be installed with its own extension disabled:
 *
 *   { "source": "npm:pi-extensible-workflows@3.4.2", "extensions": [] }
 *
 * Loading both would register the `workflow*` tools twice, the second copy on
 * the package's own `localAgentTransport`.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSubagentHost } from "../shared/subagent-host.ts";
import {
  WORKFLOW_TRANSPORT_ID,
  type AgentTransport,
} from "../shared/workflow-transport.ts";
import { createRoleSetupHook, ROLE_HOOK_NAME } from "./src/roles.ts";
import { withWorkflowGuidance } from "./src/tool-guidance.ts";

/** Resolved at runtime: the package is installed by the user, not vendored. */
const WORKFLOW_PACKAGE = "pi-extensible-workflows";

const EXTENSION_METADATA = {
  version: "1.0.0",
  headline: "In-house subagent roles",
  description:
    "Resolves workflow roles from ~/.config/ai/agents through the subagents agent definitions.",
};

interface WorkflowPackage {
  default?: unknown;
  registerWorkflowExtension?: unknown;
}

/**
 * `pi install` puts packages under `<agentDir>/npm/node_modules`, which is not
 * on the resolution path of an extension in `<agentDir>/extensions`, so the
 * specifier is resolved against pi's package root explicitly.
 */
function resolveWorkflowEntry() {
  const require = createRequire(
    path.join(getAgentDir(), "npm", "package.json"),
  );
  return pathToFileURL(require.resolve(WORKFLOW_PACKAGE)).href;
}

/**
 * The specifier stays non-literal so the optional peer cannot break
 * `tsc --noEmit`. An uninstalled package is a no-op, not a broken session;
 * anything else is a real failure and propagates.
 */
async function loadWorkflowPackage(): Promise<WorkflowPackage | undefined> {
  let entry: string;
  try {
    entry = resolveWorkflowEntry();
  } catch {
    return undefined;
  }
  return (await import(entry)) as WorkflowPackage;
}

export default async function (pi: ExtensionAPI) {
  const roles = createRoleSetupHook();
  let sessionContext: ExtensionContext | undefined;

  /**
   * The real transport needs the live manager and the parent session, neither
   * of which exists when the package registers its tools, so the facade
   * resolves them on first use and never outlives a session.
   */
  const transport: AgentTransport = {
    id: WORKFLOW_TRANSPORT_ID,
    async createSession(prepared, context) {
      const host = getSubagentHost();
      if (!host) {
        throw new Error(
          "The subagents extension is not active; workflow agents have nowhere to run.",
        );
      }
      const ctx = sessionContext;
      if (!ctx) {
        throw new Error("No active session; cannot start a workflow agent.");
      }
      const delegate = await host.workflowTransport({ parent: ctx });
      return delegate.createSession(prepared, context);
    },
  };

  const workflows = await loadWorkflowPackage();
  if (!workflows) {
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        `${WORKFLOW_PACKAGE} is not installed; /workflow is unavailable.`,
        "warning",
      );
    });
    return;
  }
  const register = workflows.registerWorkflowExtension;
  const host = workflows.default;
  if (typeof register !== "function" || typeof host !== "function") {
    throw new Error(
      `${WORKFLOW_PACKAGE} does not expose the expected extension surface; check the installed version.`,
    );
  }

  // Registration must precede the host: it freezes the registry as it loads.
  register({
    ...EXTENSION_METADATA,
    agentSetupHooks: { [ROLE_HOOK_NAME]: roles.hook },
  });
  // The package teaches the tool's options but not its source language, so its
  // `workflow` registration is decorated on the way through.
  host(withWorkflowGuidance(pi), undefined, undefined, transport);

  // Warnings surface when the role is actually used, not at load: a warning
  // about an agent this session never spawns is noise, and at spawn time it
  // names the one agent whose capabilities just changed.
  roles.onWarnings((role, warnings) => {
    const ctx = sessionContext;
    if (!ctx?.hasUI) return;
    ctx.ui.notify(`Workflow role "${role}": ${warnings.join("; ")}`, "warning");
  });

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    roles.loadForSession({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
  });

  pi.on("session_shutdown", () => {
    sessionContext = undefined;
  });
}
