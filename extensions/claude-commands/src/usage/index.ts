/**
 * `/usage` — three independent sources, rendered into a dismissable overlay
 * that leaves no transcript residue. Each source degrades to a one-line reason
 * when it is unavailable.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchClaudeQuota } from "./claude.ts";
import { OPENCODE_DB_PATH, readOpencodeUsage } from "./opencode.ts";
import { showUsageOverlay } from "./overlay.ts";
import { scanSessionDir, summarizeBranch } from "./pi.ts";
import { buildUsageView, renderUsageText } from "./view.ts";

/** Width assumed when rendering usage outside a terminal. */
const PLAIN_TEXT_WIDTH = 72;

export async function collectUsage(ctx: ExtensionCommandContext) {
  const now = new Date();
  const [scan, opencode, quota] = await Promise.all([
    scanSessionDir(ctx.sessionManager.getSessionDir(), now),
    readOpencodeUsage(OPENCODE_DB_PATH, now),
    fetchClaudeQuota({ signal: ctx.signal }),
  ]);

  return buildUsageView({
    branch: summarizeBranch(ctx.sessionManager.getBranch()),
    scan,
    opencode,
    quota,
    now,
  });
}

export async function showUsage(ctx: ExtensionCommandContext) {
  const view = await collectUsage(ctx);
  if (ctx.mode === "tui") {
    await showUsageOverlay(ctx, view);
    return;
  }
  ctx.ui.notify(renderUsageText(view, PLAIN_TEXT_WIDTH), "info");
}
