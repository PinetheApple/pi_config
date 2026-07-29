/**
 * The /usage view model: source data in, panel sections out. Nothing here
 * touches the TUI.
 */

import type { UsageSummary } from "../../../shared/usage-totals.ts";
import { formatRelativeToNow, formatTokens, homeRelative } from "../format.ts";
import {
  sourceRow,
  type PanelRow,
  type PanelSection,
  type PanelView,
} from "../panel/rows.ts";
import { QUOTA_LABELS, type ClaudeQuota } from "./claude.ts";
import { GO_LIMITS_DOC, goLimitGauges } from "./go-limits.ts";
import type { ModelBucket, SessionScan } from "./pi.ts";
import { windowRows } from "./rows.ts";
import { WINDOW_LABELS } from "./window.ts";

/** pi providers billed by opencode Zen: "opencode" and "opencode-go". */
const OPENCODE_PROVIDER_PREFIX = "opencode";

export const OPENCODE_HEADING = "opencode";

function resetNote(resetsAt: Date | undefined, now: Date) {
  if (!resetsAt) return "Reset time unknown";
  const absolute = resetsAt.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return `Resets ${formatRelativeToNow(resetsAt, now)} · ${absolute}`;
}

export function buildClaudeSection(
  quota: ClaudeQuota,
  now: Date,
): PanelSection {
  if (!quota.ok) {
    return {
      heading: "Claude Code plan",
      rows: [{ kind: "text", value: `unavailable — ${quota.reason}` }],
    };
  }

  return {
    heading: "Claude Code plan",
    rows: quota.windows.map((window) => ({
      kind: "gauge",
      label: QUOTA_LABELS[window.key],
      fraction: window.utilization,
      note: resetNote(window.resetsAt, now),
    })),
  };
}

export function isOpencodeProvider(provider: string) {
  return (
    provider === OPENCODE_PROVIDER_PREFIX ||
    provider.startsWith(`${OPENCODE_PROVIDER_PREFIX}-`)
  );
}

/** opencode-billed turns pi ran itself — the only place opencode usage exists. */
export function buildOpencodeSection(
  scan: SessionScan | undefined,
  sessionsRoot: string,
): PanelSection {
  const heading = OPENCODE_HEADING;
  const rows: PanelRow[] = [
    sourceRow(homeRelative(sessionsRoot), "a subset of the pi section"),
  ];

  if (!scan) {
    rows.push({ kind: "text", value: "session directory unreadable" });
    return { heading, rows };
  }

  const models: ModelBucket[] = scan.models.filter((bucket) =>
    isOpencodeProvider(bucket.provider),
  );

  rows.push(...goLimitGauges(models));

  return { heading, rows };
}

export function buildPiSection(
  branch: UsageSummary,
  scan: SessionScan | undefined,
  sessionsRoot: string,
): PanelSection {
  const rows: PanelRow[] = [
    sourceRow(homeRelative(sessionsRoot), "every provider pi has talked to"),
    {
      kind: "text",
      label: "This session",
      value: `${formatTokens(branch.totalTokens)} tok · ${branch.messages} replies`,
    },
  ];

  if (!scan) {
    rows.push({ kind: "text", value: "session directory unreadable" });
    return { heading: "pi", rows };
  }

  rows.push(
    ...windowRows(
      (window) => ({
        label: WINDOW_LABELS[window],
        usage: scan.windows[window],
        count: scan.windows[window].messages,
      }),
      "replies",
    ),
    {
      kind: "text",
      label: "Scanned",
      value: `${scan.filesScanned} of ${scan.filesAvailable} session files${scan.truncated ? " (capped)" : ""}`,
      dim: true,
    },
  );

  return { heading: "pi", rows };
}

export interface UsageSources {
  branch: UsageSummary;
  scan: SessionScan | undefined;
  sessionsRoot: string;
  quota: ClaudeQuota;
  now: Date;
}

export function buildUsageView(sources: UsageSources): PanelView {
  return {
    title: "Usage",
    sections: [
      buildClaudeSection(sources.quota, sources.now),
      buildOpencodeSection(sources.scan, sources.sessionsRoot),
      buildPiSection(sources.branch, sources.scan, sources.sessionsRoot),
    ],
    footer: `Every section names the local file it was read from. Bars mean consumption of a published limit. Claude Code figures come from an undocumented OAuth endpoint that may change or disappear without notice. opencode publishes no usage endpoint, so the Go bars divide the cost pi recorded locally by the limits at ${GO_LIMITS_DOC} — they count pi's own turns only, and credit-billed opencode models have no limit to divide by.`,
  };
}
