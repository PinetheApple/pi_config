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
import { OPENCODE_DB_PATH, type OpencodeRead } from "./opencode.ts";
import { sumModelWindows, type ModelBucket, type SessionScan } from "./pi.ts";
import {
  breakdownRows,
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

export const OPENCODE_QUOTA_NOTE = "not published by opencode Zen";
export const OPENCODE_APP_HEADING = "opencode app";
export const OPENCODE_VIA_PI_HEADING = "opencode via pi";
export const OPENCODE_DB_SOURCE = homeRelative(OPENCODE_DB_PATH);

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

/** opencode-billed turns pi ran itself — the only place opencode-go usage exists. */
export function buildOpencodeViaPiSection(
  scan: SessionScan | undefined,
  sessionsRoot: string,
): UsageSection {
  const heading = OPENCODE_VIA_PI_HEADING;
  const rows: UsageRow[] = [
    sourceRow(
      homeRelative(sessionsRoot),
      "turns pi ran through an opencode provider (a subset of the pi section)",
    ),
    { kind: "text", label: "Plan quota", value: OPENCODE_QUOTA_NOTE },
  ];

  if (!scan) {
    rows.push({ kind: "text", value: "session directory unreadable" });
    return { heading, rows };
  }

  const models: ModelBucket[] = scan.models.filter((bucket) =>
    isOpencodeProvider(bucket.provider),
  );
  const windows = sumModelWindows(models);

  rows.push(
    ...windowRows(
      (window) => ({
        label: WINDOW_LABELS[window],
        usage: windows[window],
        count: windows[window].messages,
      }),
      "replies",
    ),
    ...breakdownRows(
      models.map((bucket) => ({
        label: modelLabel(bucket.provider, bucket.model),
        usage: bucket.windows.all,
        count: bucket.windows.all.messages,
      })),
      windows.all.totalTokens,
      "replies",
    ),
  );

  return { heading, rows };
}

/** Sessions run in the opencode app itself; pi never writes to this database. */
export function buildOpencodeAppSection(result: OpencodeRead): UsageSection {
  const heading = OPENCODE_APP_HEADING;
  const rows: UsageRow[] = [
    sourceRow(
      OPENCODE_DB_SOURCE,
      "sessions run in the opencode app, not through pi",
    ),
  ];

  if (!result.ok) {
    rows.push({ kind: "text", value: `unavailable — ${result.reason}` });
    return { heading, rows };
  }

  const { windows, byModel } = result.totals;
  rows.push(
    ...windowRows(
      (window) => ({
        label: WINDOW_LABELS[window],
        usage: windows[window].usage,
        count: windows[window].sessions,
      }),
      "sessions",
    ),
    ...breakdownRows(
      byModel.map((bucket) => ({
        label: modelLabel(bucket.provider, bucket.model),
        usage: bucket.usage,
        count: bucket.sessions,
      })),
      windows.all.usage.totalTokens,
      "sessions",
    ),
  );

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
  opencode: OpencodeRead;
  quota: ClaudeQuota;
  now: Date;
}

export function buildUsageView(sources: UsageSources): UsageView {
  return {
    title: "Usage",
    sections: [
      buildClaudeSection(sources.quota, sources.now),
      buildOpencodeViaPiSection(sources.scan, sources.sessionsRoot),
      buildOpencodeAppSection(sources.opencode),
      buildPiSection(sources.branch, sources.scan, sources.sessionsRoot),
    ],
    footer:
      "Every section names the local file it was read from. Bars mean consumption of a published limit, so only the Claude Code plan has them. Claude Code figures come from an undocumented OAuth endpoint that may change or disappear without notice.",
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
