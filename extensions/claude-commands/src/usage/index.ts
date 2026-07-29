/**
 * `/usage` — independent local sources, rendered into a dismissable overlay
 * that leaves no transcript residue. Each source degrades to a one-line reason
 * when it is unavailable.
 */

import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchClaudeQuota } from "./claude.ts";
import { PLAIN_TEXT_WIDTH, renderPanelText } from "../panel/layout.ts";
import { showPanelOverlay } from "../panel/overlay.ts";
import { scanSessionDir, summarizeBranch } from "./pi.ts";
import { buildUsageView } from "./view.ts";

export async function collectUsage(ctx: ExtensionCommandContext) {
  const now = new Date();
  // The cwd-encoded session dir sits one level under the sessions root; scan
  // the root so opencode-go turns from other projects are not invisible.
  const sessionsRoot = dirname(ctx.sessionManager.getSessionDir());
  const [scan, quota] = await Promise.all([
    scanSessionDir(sessionsRoot, now),
    fetchClaudeQuota({ signal: ctx.signal }),
  ]);

  return buildUsageView({
    branch: summarizeBranch(ctx.sessionManager.getBranch()),
    scan,
    sessionsRoot,
    quota,
    now,
  });
}

export async function showUsage(ctx: ExtensionCommandContext) {
  const view = await collectUsage(ctx);
  if (ctx.mode === "tui") {
    await showPanelOverlay(ctx, view);
    return;
  }
  ctx.ui.notify(renderPanelText(view, PLAIN_TEXT_WIDTH), "info");
}
