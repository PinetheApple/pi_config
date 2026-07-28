/** `/status` — environment, session and auth state. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readClaudeAccount, readOpencodeAccountEmail } from "./accounts.ts";
import { pad } from "./format.ts";
import { report, type ReportSection } from "./report.ts";
import { OPENCODE_DB_PATH } from "./usage/opencode.ts";

const LABEL_WIDTH = 20;

function row(label: string, value: string) {
  return `${pad(label, LABEL_WIDTH)}${value}`;
}

const NOT_AVAILABLE = "not available";

function environmentSection(ctx: ExtensionCommandContext): ReportSection {
  const model = ctx.model;
  return {
    heading: "Environment",
    lines: [
      row("Mode", ctx.mode),
      row("Model", model ? `${model.provider}/${model.id}` : "none selected"),
      row(
        "Provider",
        model
          ? ctx.modelRegistry.getProviderDisplayName(model.provider)
          : NOT_AVAILABLE,
      ),
      row("Thinking", ctx.thinkingLevel ?? NOT_AVAILABLE),
      row(
        "Context window",
        model?.contextWindow ? `${model.contextWindow}` : NOT_AVAILABLE,
      ),
      row(
        "OAuth",
        model
          ? ctx.modelRegistry.isUsingOAuth(model)
            ? "yes"
            : "no"
          : NOT_AVAILABLE,
      ),
      row("cwd", ctx.cwd),
      row("Project trusted", ctx.isProjectTrusted() ? "yes" : "no"),
    ],
  };
}

function sessionSection(ctx: ExtensionCommandContext): ReportSection {
  const manager = ctx.sessionManager;
  return {
    heading: "Session",
    lines: [
      row("Id", manager.getSessionId()),
      row("Name", manager.getSessionName() ?? "(unnamed)"),
      row("File", manager.getSessionFile() ?? NOT_AVAILABLE),
      row(
        "Entries",
        `${manager.getEntries().length} (${manager.getBranch().length} on branch)`,
      ),
    ],
  };
}

function authSection(ctx: ExtensionCommandContext): ReportSection {
  const providers = new Set<string>(
    ctx.modelRegistry.getRegisteredProviderIds(),
  );
  for (const model of ctx.modelRegistry.getAvailable())
    providers.add(model.provider);
  if (ctx.model) providers.add(ctx.model.provider);

  const lines = [...providers].sort().map((provider) => {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    const detail = status.configured
      ? [status.source, status.label].filter(Boolean).join(", ") || "configured"
      : "not configured";
    return row(
      ctx.modelRegistry.getProviderDisplayName(provider),
      `${status.configured ? "✓" : "✗"} ${detail}`,
    );
  });

  return {
    heading: `Provider auth (${lines.length})`,
    lines: lines.length > 0 ? lines : ["No providers registered."],
  };
}

async function accountsSection(): Promise<ReportSection> {
  const [claude, opencodeEmail] = await Promise.all([
    readClaudeAccount(),
    readOpencodeAccountEmail(OPENCODE_DB_PATH),
  ]);

  const claudeDetail = claude
    ? [
        claude.email ?? claude.displayName,
        claude.organizationName,
        claude.seatTier ?? claude.billingType,
      ]
        .filter(Boolean)
        .join(" · ")
    : NOT_AVAILABLE;

  return {
    heading: "Accounts",
    lines: [
      row("pi", "no account concept (auth.json stores API keys only)"),
      row("Claude Code", claudeDetail || NOT_AVAILABLE),
      row("opencode", opencodeEmail ?? NOT_AVAILABLE),
    ],
  };
}

export async function buildStatusReport(ctx: ExtensionCommandContext) {
  return report("Status", [
    environmentSection(ctx),
    sessionSection(ctx),
    authSection(ctx),
    await accountsSection(),
  ]);
}
