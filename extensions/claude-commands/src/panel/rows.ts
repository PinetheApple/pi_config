/**
 * The row vocabulary shared by every claude-commands overlay panel.
 *
 * A panel is a titled list of sections; a section is a list of rows. Rows are
 * plain data — laying them out is layout.ts, painting them is overlay.ts.
 */

import type { TableSpec } from "./table.ts";

export interface GaugeRow {
  kind: "gauge";
  label: string;
  fraction: number | undefined;
  /**
   * Fraction the colour and marker are derived from, when that is not the bar
   * itself. A full "free space" bar is reassuring, not critical.
   */
  severityFraction?: number;
  note?: string;
}

export interface TextRow {
  kind: "text";
  label?: string;
  value: string;
  dim?: boolean;
}

export interface TableRow {
  kind: "table";
  spec: TableSpec;
}

export type PanelRow = GaugeRow | TextRow | TableRow;

export interface PanelSection {
  heading: string;
  rows: PanelRow[];
}

export interface PanelView {
  title: string;
  sections: PanelSection[];
  footer: string;
}

export function sourceRow(path: string, what: string): TextRow {
  return { kind: "text", value: `Source: ${path} — ${what}`, dim: true };
}
