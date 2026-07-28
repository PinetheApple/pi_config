/**
 * Claude-Code-parity slash commands for pi.
 *
 * Only commands pi does not already ship are registered here. `/help`,
 * `/context` and `/status` deliver `claude-commands-report` custom entries,
 * which are persisted in the session but never enter LLM context. `/usage`
 * opens a dismissable overlay and persists nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAliases } from "./src/aliases.ts";
import { buildContextReport } from "./src/context.ts";
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
    description: "Show the context-window breakdown for this session",
    handler: async (_args, ctx) => {
      present(
        pi,
        ctx,
        buildContextReport({
          usage: ctx.getContextUsage(),
          modelLabel: ctx.model
            ? `${ctx.model.provider}/${ctx.model.id}`
            : "none selected",
          fallbackContextWindow: ctx.model?.contextWindow,
          systemPrompt: ctx.getSystemPrompt(),
          contextEntries: ctx.sessionManager.buildContextEntries(),
        }),
      );
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
