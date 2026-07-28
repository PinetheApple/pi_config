/**
 * Pure view model for /usage: source data in, laid-out rows out. Nothing here
 * touches the TUI, so the bar math, table geometry and width degradation stay
 * unit-testable.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UsageSummary } from "../../../shared/usage-totals.ts";
import {
  formatPercent,
  formatRelativeToNow,
  formatTokens,
  homeRelative,
  modelLabel,
  pad,
} from "../format.ts";
import { QUOTA_LABELS, type ClaudeQuota } from "./claude.ts";
import {
  barWidth,
  MARKER_WIDTH,
  renderBar,
  severityOf,
  SEVERITY_MARKERS,
  type Severity,
} from "./bar.ts";
import { GO_LIMITS_DOC, goLimitGauges } from "./go-limits.ts";
import type { ModelBucket, SessionScan } from "./pi.ts";
import {
  sourceRow,
  windowRows,
  type GaugeRow,
  type TextRow,
  type UsageRow,
  type UsageSection,
  type UsageView,
} from "./rows.ts";
import { clip, layoutTable } from "./table.ts";
import { WINDOW_LABELS } from "./window.ts";

export { clip };
export * from "./rows.ts";

export const GAUGE_INDENT = "  ";
/** Widest percentage is "100%", plus one column of separation from the bar. */
export const PERCENT_WIDTH = 5;
export const TEXT_LABEL_WIDTH = 16;
/** pi providers billed by opencode Zen: "opencode" and "opencode-go". */
const OPENCODE_PROVIDER_PREFIX = "opencode";

export const OPENCODE_HEADING = "opencode";

export interface GaugeLayout {
  label: string;
  /** Empty when the terminal is too narrow to carry a bar at all. */
  bar: string;
  percent: string;
  marker: string;
  note: string;
  severity: Severity;
}

export function layoutGauge(row: GaugeRow, width: number): GaugeLayout {
  const severity = severityOf(row.fraction);
  const percent = formatPercent(row.fraction, 0).padStart(PERCENT_WIDTH);
  const cells = barWidth(
    width - GAUGE_INDENT.length - PERCENT_WIDTH - MARKER_WIDTH,
  );
  const indented = Math.max(1, width - GAUGE_INDENT.length);

  return {
    label: clip(row.label, width),
    bar: cells === undefined ? "" : renderBar(row.fraction, cells),
    percent,
    marker: SEVERITY_MARKERS[severity].padEnd(MARKER_WIDTH),
    note: row.note ? clip(row.note, indented) : "",
    severity,
  };
}

/** Plain lines for a gauge, in render order: label, bar, optional note. */
export function gaugeLines(layout: GaugeLayout) {
  const meter = `${GAUGE_INDENT}${layout.bar}${layout.percent}${layout.marker}`;
  const lines = [layout.label, meter.trimEnd()];
  if (layout.note) lines.push(`${GAUGE_INDENT}${layout.note}`);
  return lines;
}

export function textRowLine(row: TextRow) {
  return row.label
    ? `${pad(row.label, TEXT_LABEL_WIDTH)}${row.value}`
    : row.value;
}

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
): UsageSection {
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
): UsageSection {
  const heading = OPENCODE_HEADING;
  const rows: UsageRow[] = [
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
): UsageSection {
  const rows: UsageRow[] = [
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

export function buildUsageView(sources: UsageSources): UsageView {
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

/** Plain-text rendering for non-TUI modes and for tests. */
export function renderUsageText(view: UsageView, width: number) {
  const lines: string[] = [view.title];
  for (const section of view.sections) {
    lines.push("", section.heading);
    for (const row of section.rows) {
      // Wrap rather than clip, so the overlay and the plain path agree.
      if (row.kind === "text")
        lines.push(...wrapTextWithAnsi(textRowLine(row), width));
      else if (row.kind === "gauge")
        lines.push(...gaugeLines(layoutGauge(row, width)));
      else {
        const table = layoutTable(row.spec, width);
        lines.push(table.head, ...table.rows);
      }
    }
  }
  lines.push("", ...wrapTextWithAnsi(view.footer, width));
  return lines.join("\n");
}
