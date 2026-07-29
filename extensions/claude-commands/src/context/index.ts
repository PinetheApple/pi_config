/**
 * `/context` — what actually occupies the context window, in a dismissable
 * overlay that leaves no transcript residue.
 */

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { PLAIN_TEXT_WIDTH, renderPanelText } from "../panel/layout.ts";
import { showPanelOverlay } from "../panel/overlay.ts";
import {
  buildContextBreakdown,
  type ContextSources,
  type ToolSchema,
} from "./breakdown.ts";
import { buildContextView } from "./view.ts";

/**
 * The tool list is a runtime action, not a session read: `pi -p` and other
 * non-interactive modes never bind it. Absent is reported as absent rather
 * than counted as zero.
 */
function activeToolSchemas(
  pi: ExtensionAPI,
): readonly ToolSchema[] | undefined {
  try {
    const active = new Set(pi.getActiveTools());
    return pi.getAllTools().filter((tool) => active.has(tool.name));
  } catch {
    return undefined;
  }
}

function promptParts(ctx: ExtensionCommandContext) {
  const options = ctx.getSystemPromptOptions();
  const skills = (options.skills ?? []).filter(
    (skill) => !skill.disableModelInvocation,
  );
  return {
    contextFiles: options.contextFiles ?? [],
    skillsPrompt: skills.length > 0 ? formatSkillsForPrompt(skills) : "",
    skillCount: skills.length,
  };
}

export function collectContextSources(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): ContextSources {
  return {
    usage: ctx.getContextUsage(),
    modelLabel: ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "none selected",
    fallbackContextWindow: ctx.model?.contextWindow,
    systemPrompt: ctx.getSystemPrompt(),
    ...promptParts(ctx),
    tools: activeToolSchemas(pi),
    entries: ctx.sessionManager.buildContextEntries(),
  };
}

export async function showContext(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
) {
  const view = buildContextView(
    buildContextBreakdown(collectContextSources(pi, ctx)),
  );

  if (ctx.mode === "tui") {
    await showPanelOverlay(ctx, view);
    return;
  }
  ctx.ui.notify(renderPanelText(view, PLAIN_TEXT_WIDTH), "info");
}
