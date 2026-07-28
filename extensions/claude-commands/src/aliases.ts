/**
 * Claude-Code-compatible aliases for pi built-ins.
 *
 * `/clear` maps onto a real API call. `/config` and `/rewind` cannot: built-in
 * interactive commands are dispatched by the interactive layer and are not
 * reachable through `pi.getCommands()` or any ExtensionAPI method. Reimplementing
 * their selectors would mean rebuilding state pi does not expose, so these two
 * aliases only point at the real command.
 *
 * Prefilling the editor was tried and rejected: the text survives until the user
 * submits, so anything they type next is concatenated onto it and sent as a
 * prompt.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export function pointToBuiltin(
  ctx: ExtensionCommandContext,
  alias: string,
  builtin: string,
) {
  ctx.ui.notify(
    `/${alias} is an alias for the built-in /${builtin}, which extensions cannot invoke — run /${builtin}.`,
    "info",
  );
}

export function registerAliases(pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description:
      "Clear the conversation and start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });

  pi.registerCommand("config", {
    description: "Open settings (alias for /settings)",
    handler: async (_args, ctx) => pointToBuiltin(ctx, "config", "settings"),
  });

  pi.registerCommand("rewind", {
    description: "Rewind to an earlier point in the session (alias for /tree)",
    handler: async (_args, ctx) => pointToBuiltin(ctx, "rewind", "tree"),
  });
}
