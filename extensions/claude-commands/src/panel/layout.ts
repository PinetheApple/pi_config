/**
 * Pure geometry for panel rows: a row and a width in, plain lines out.
 *
 * Nothing here touches the TUI, so the bar math, table geometry and width
 * degradation stay unit-testable and the plain-text path renders identically.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatPercent, pad } from "../format.ts";
import { barWidth, MARKER_WIDTH, renderBar, severityOf } from "./bar.ts";
import { SEVERITY_MARKERS, type Severity } from "./bar.ts";
import type { GaugeRow, PanelView, TextRow } from "./rows.ts";
import { clip, layoutTable } from "./table.ts";

export const GAUGE_INDENT = "  ";
/** Widest percentage is "100%", plus one column of separation from the bar. */
export const PERCENT_WIDTH = 5;
export const TEXT_LABEL_WIDTH = 16;
/** Width assumed when rendering a panel outside a terminal. */
export const PLAIN_TEXT_WIDTH = 72;

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
  const severity = severityOf(row.severityFraction ?? row.fraction);
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

/** Plain-text rendering, used outside the TUI and by tests. */
export function renderPanelText(view: PanelView, width: number) {
  const lines: string[] = [clip(view.title, width)];
  for (const section of view.sections) {
    lines.push("", clip(section.heading, width));
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
