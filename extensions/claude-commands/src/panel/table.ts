/**
 * Pure column geometry for /usage tables: cells in, aligned lines out.
 *
 * Column 0 is the flexible label and is left-aligned; every other column is a
 * right-aligned number. When the terminal cannot carry every column, the
 * rightmost ones are dropped until `minColumns` remain, then the label is
 * clipped. Nothing here touches the TUI.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

export const COLUMN_GAP = 2;
/** Narrowest useful label column; below this, drop a column instead. */
export const MIN_LABEL_WIDTH = 10;

const ELLIPSIS = "…";
const GAP = " ".repeat(COLUMN_GAP);

/** Column-accurate clip that never injects ANSI, so the view model stays plain. */
export function clip(text: string, width: number) {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;

  let out = "";
  for (const character of text) {
    if (visibleWidth(out + character) > width - 1) break;
    out += character;
  }
  return out + ELLIPSIS;
}

export interface TableSpec {
  head: readonly string[];
  rows: readonly (readonly string[])[];
  /** Columns never dropped, however narrow the terminal gets. */
  minColumns: number;
}

export interface TableLayout {
  head: string;
  rows: string[];
}

function naturalWidths(spec: TableSpec) {
  return spec.head.map((header, index) =>
    Math.max(
      visibleWidth(header),
      ...spec.rows.map((row) => visibleWidth(row[index] ?? "")),
    ),
  );
}

function lineWidth(widths: readonly number[], count: number) {
  let total = COLUMN_GAP * Math.max(0, count - 1);
  for (let index = 0; index < count; index += 1) total += widths[index] ?? 0;
  return total;
}

function renderRow(
  cells: readonly string[],
  widths: readonly number[],
  count: number,
) {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const width = widths[index] ?? 0;
    const cell = cells[index] ?? "";
    parts.push(
      index === 0
        ? clip(cell, width).padEnd(width)
        : clip(cell, width).padStart(width),
    );
  }
  return parts.join(GAP).trimEnd();
}

export function layoutTable(spec: TableSpec, width: number): TableLayout {
  const widths = naturalWidths(spec);
  const floor = Math.max(1, Math.min(spec.minColumns, widths.length));

  let count = widths.length;
  while (count > floor && lineWidth(widths, count) > width) count -= 1;

  const label = widths[0] ?? 0;
  const slack = width - (lineWidth(widths, count) - label);
  widths[0] = Math.max(1, Math.min(label, Math.max(MIN_LABEL_WIDTH, slack)));

  return {
    head: renderRow(spec.head, widths, count),
    rows: spec.rows.map((row) => renderRow(row, widths, count)),
  };
}
