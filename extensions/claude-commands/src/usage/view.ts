/**
 * Pure view model for /usage: source data in, laid-out rows out. Nothing here
 * touches the TUI, so the bar math and width degradation are unit-testable.
 */

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UsageSummary } from "../../../shared/usage-totals.ts";
import {
  formatCost,
  formatPercent,
  formatRelativeToNow,
  formatTokens,
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
import type { OpencodeRead } from "./opencode.ts";
import type { SessionScan } from "./pi.ts";
import { USAGE_WINDOWS, WINDOW_LABELS } from "./window.ts";

export const GAUGE_INDENT = "  ";
/** Widest percentage is "100%", plus one column of separation from the bar. */
export const PERCENT_WIDTH = 5;
export const TEXT_LABEL_WIDTH = 16;
/** Enough model rows to be useful without turning the panel into a table. */
export const MAX_MODEL_ROWS = 6;

export const OPENCODE_QUOTA_NOTE =
  "unavailable — opencode Zen publishes no usage or quota endpoint";

export interface GaugeRow {
  kind: "gauge";
  label: string;
  fraction: number | undefined;
  note?: string;
}

export interface TextRow {
  kind: "text";
  label?: string;
  value: string;
}

export type UsageRow = GaugeRow | TextRow;

export interface UsageSection {
  heading: string;
  rows: UsageRow[];
}

export interface UsageView {
  title: string;
  sections: UsageSection[];
  footer: string;
}

const ELLIPSIS = "…";

/** Column-accurate clip that never injects ANSI, so the view model stays plain. */
export function clip(text: string, width: number) {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;

  const characters = [...text];
  let out = "";
  for (const character of characters) {
    if (visibleWidth(out + character) > width - 1) break;
    out += character;
  }
  return out + ELLIPSIS;
}

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

function summaryLine(summary: UsageSummary) {
  return [
    `${formatTokens(summary.totalTokens)} tok`,
    `in ${formatTokens(summary.input)}`,
    `out ${formatTokens(summary.output)}`,
    `cache r/w ${formatTokens(summary.cacheRead)}/${formatTokens(summary.cacheWrite)}`,
    formatCost(summary.cost),
  ].join(" · ");
}

function sessions(count: number) {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
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

export function buildOpencodeSection(result: OpencodeRead): UsageSection {
  const rows: UsageRow[] = [
    { kind: "text", label: "Plan quota", value: OPENCODE_QUOTA_NOTE },
  ];

  if (!result.ok) {
    rows.push({
      kind: "text",
      value: `local session records unavailable — ${result.reason}`,
    });
    return { heading: "opencode", rows };
  }

  for (const window of USAGE_WINDOWS) {
    const bucket = result.totals.windows[window];
    rows.push({
      kind: "text",
      label: WINDOW_LABELS[window],
      value: `${summaryLine(bucket.usage)} (${sessions(bucket.sessions)})`,
    });
  }

  const total = result.totals.windows.all.usage.totalTokens;
  const top = result.totals.byModel.slice(0, MAX_MODEL_ROWS);
  if (top.length > 0) {
    rows.push({
      kind: "text",
      value: `Share of all-time tokens (${sessions(result.totals.rows)}):`,
    });
    for (const bucket of top) {
      rows.push({
        kind: "gauge",
        label: `${bucket.provider}/${bucket.model}`,
        fraction: total > 0 ? bucket.usage.totalTokens / total : undefined,
        note: `${summaryLine(bucket.usage)} · ${sessions(bucket.sessions)}`,
      });
    }
  }

  return { heading: "opencode", rows };
}

export function buildPiSection(
  branch: UsageSummary,
  scan: SessionScan | undefined,
): UsageSection {
  const rows: UsageRow[] = [
    {
      kind: "text",
      label: "This session",
      value: `${summaryLine(branch)} (${branch.messages} replies)`,
    },
  ];

  if (!scan) {
    rows.push({
      kind: "text",
      label: "Other windows",
      value: "session directory unreadable",
    });
    return { heading: "pi", rows };
  }

  for (const window of USAGE_WINDOWS) {
    rows.push({
      kind: "text",
      label: WINDOW_LABELS[window],
      value: summaryLine(scan.windows[window]),
    });
  }
  rows.push({
    kind: "text",
    label: "Scanned",
    value: `${scan.filesScanned} of ${scan.filesAvailable} session files for this cwd${scan.truncated ? " (capped)" : ""}`,
  });

  return { heading: "pi", rows };
}

export interface UsageSources {
  branch: UsageSummary;
  scan: SessionScan | undefined;
  opencode: OpencodeRead;
  quota: ClaudeQuota;
  now: Date;
}

export function buildUsageView(sources: UsageSources): UsageView {
  return {
    title: "Usage",
    sections: [
      buildClaudeSection(sources.quota, sources.now),
      buildOpencodeSection(sources.opencode),
      buildPiSection(sources.branch, sources.scan),
    ],
    footer:
      "pi and opencode figures are read from local session records. Claude Code plan figures come from an undocumented OAuth endpoint that may change or disappear without notice.",
  };
}

/** Plain-text rendering for non-TUI modes and for tests. */
export function renderUsageText(view: UsageView, width: number) {
  const lines: string[] = [view.title];
  for (const section of view.sections) {
    lines.push("", section.heading);
    for (const row of section.rows) {
      if (row.kind === "text") lines.push(clip(textRowLine(row), width));
      else lines.push(...gaugeLines(layoutGauge(row, width)));
    }
  }
  lines.push("", ...wrapTextWithAnsi(view.footer, width));
  return lines.join("\n");
}
