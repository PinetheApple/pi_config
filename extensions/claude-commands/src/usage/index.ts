/**
 * `/usage` (and its `/cost` alias) — three independent sources, each rendered
 * only when it is actually available and skipped with a one-line reason
 * otherwise.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { UsageSummary } from "../../../shared/usage-totals.ts";
import {
  formatCost,
  formatPercent,
  formatRelativeToNow,
  formatTokens,
  pad,
} from "../format.ts";
import { report, type ReportSection } from "../report.ts";
import { fetchClaudeQuota, QUOTA_LABELS, type ClaudeQuota } from "./claude.ts";
import {
  OPENCODE_DB_PATH,
  readOpencodeUsage,
  type OpencodeRead,
} from "./opencode.ts";
import { scanSessionDir, summarizeBranch, type SessionScan } from "./pi.ts";
import { USAGE_WINDOWS, WINDOW_LABELS } from "./window.ts";

const LABEL_WIDTH = 22;

function row(label: string, value: string) {
  return `${pad(label, LABEL_WIDTH)}${value}`;
}

function summaryLine(summary: UsageSummary) {
  return [
    `${formatTokens(summary.totalTokens)} tok`,
    `in ${formatTokens(summary.input)}`,
    `out ${formatTokens(summary.output)}`,
    `cache r/w ${formatTokens(summary.cacheRead)}/${formatTokens(summary.cacheWrite)}`,
    formatCost(summary.cost),
  ].join(" · ");
}

function piSection(
  branch: UsageSummary,
  scan: SessionScan | undefined,
): ReportSection {
  const lines = [
    row("This session", `${summaryLine(branch)} (${branch.messages} replies)`),
  ];

  if (!scan) {
    lines.push(row("Other windows", "session directory unreadable"));
  } else {
    for (const window of USAGE_WINDOWS) {
      lines.push(row(WINDOW_LABELS[window], summaryLine(scan.windows[window])));
    }
    lines.push(
      row(
        "Scanned",
        `${scan.filesScanned} of ${scan.filesAvailable} session files for this cwd${scan.truncated ? " (capped)" : ""}`,
      ),
    );
  }

  return { heading: "pi", lines };
}

function opencodeSection(result: OpencodeRead): ReportSection {
  if (!result.ok) {
    return { heading: "opencode", lines: [`skipped — ${result.reason}`] };
  }

  const lines = USAGE_WINDOWS.map((window) => {
    const bucket = result.totals.windows[window];
    return row(
      WINDOW_LABELS[window],
      `${summaryLine(bucket.usage)} (${bucket.sessions} sessions)`,
    );
  });

  lines.push("");
  lines.push(`By model (all time, ${result.totals.rows} sessions):`);
  for (const bucket of result.totals.byModel) {
    lines.push(
      row(
        `  ${bucket.provider}/${bucket.model}`.slice(0, 40),
        `${summaryLine(bucket.usage)} (${bucket.sessions})`,
      ),
    );
  }

  return { heading: "opencode", lines };
}

function claudeSection(quota: ClaudeQuota, now: Date): ReportSection {
  if (!quota.ok) {
    return {
      heading: "Claude Code plan",
      lines: [`skipped — ${quota.reason}`],
    };
  }

  const lines = quota.windows.map((window) => {
    const resets = window.resetsAt
      ? `resets ${formatRelativeToNow(window.resetsAt, now)} (${window.resetsAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })})`
      : "reset time unknown";
    return row(
      QUOTA_LABELS[window.key],
      `${formatPercent(window.utilization, 0)} used · ${resets}`,
    );
  });

  return { heading: "Claude Code plan", lines };
}

export async function buildUsageReport(ctx: ExtensionCommandContext) {
  const now = new Date();
  const branch = summarizeBranch(ctx.sessionManager.getBranch());

  const [scan, opencode, quota] = await Promise.all([
    scanSessionDir(ctx.sessionManager.getSessionDir(), now),
    readOpencodeUsage(OPENCODE_DB_PATH, now),
    fetchClaudeQuota({ signal: ctx.signal }),
  ]);

  return report(
    "Usage",
    [
      piSection(branch, scan),
      opencodeSection(opencode),
      claudeSection(quota, now),
    ],
    "pi and opencode figures are read from local session records. Claude Code plan figures come from an undocumented OAuth endpoint that may change or disappear without notice.",
  );
}
