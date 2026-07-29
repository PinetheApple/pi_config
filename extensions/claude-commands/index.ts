/**
 * Claude-Code-parity slash commands for pi.
 *
 * Only commands pi does not already ship are registered here. `/help` and
 * `/status` deliver `claude-commands-report` custom entries, which are
 * persisted in the session but never enter LLM context. `/context` and
 * `/usage` open dismissable overlays and persist nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAliases } from "./src/aliases.ts";
import { showContext } from "./src/context/index.ts";
import { buildHelpReport } from "./src/help.ts";
import { buildStatusReport } from "./src/status.ts";
import { present, registerReportRenderer } from "./src/ui.ts";
import { showUsage } from "./src/usage/index.ts";

export default function (pi: ExtensionAPI) {
  registerReportRenderer(pi);
  registerAliases(pi);

  pi.registerCommand("help", {
    description: "List available slash commands",
    handler: async (_args, ctx) => {
      present(pi, ctx, buildHelpReport(pi.getCommands()));
    },
  });

  pi.registerCommand("context", {
    description: "Show what is occupying the context window",
    handler: async (_args, ctx) => {
      await showContext(pi, ctx);
    },
  });

  pi.registerCommand("status", {
    description: "Show environment, session and provider auth state",
    handler: async (_args, ctx) => {
      present(pi, ctx, await buildStatusReport(ctx));
    },
  });

  pi.registerCommand("usage", {
    description:
      "Show token usage and plan quota across pi, opencode and Claude Code",
    handler: async (_args, ctx) => {
      await showUsage(ctx);
    },
  });
}
