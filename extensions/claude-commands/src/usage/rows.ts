/**
 * The /usage row vocabulary and the builders that turn windowed totals into
 * tables. Kept apart from view.ts so the section builders stay readable.
 */

import type { UsageSummary } from "../../../shared/usage-totals.ts";
import { formatCost, formatPercent, formatTokens } from "../format.ts";
import type { TableSpec } from "./table.ts";
import { USAGE_WINDOWS, type UsageWindow } from "./window.ts";

/** Enough model rows to be useful without turning the panel into a report. */
export const MAX_MODEL_ROWS = 6;
/** The label and the headline token count survive any terminal width. */
const MIN_TABLE_COLUMNS = 2;

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
  dim?: boolean;
}

export interface TableRow {
  kind: "table";
  spec: TableSpec;
}

export type UsageRow = GaugeRow | TextRow | TableRow;

export interface UsageSection {
  heading: string;
  rows: UsageRow[];
}

export interface UsageView {
  title: string;
  sections: UsageSection[];
  footer: string;
}

/** One row of a usage table: a name, its totals, and how many records made it. */
export interface UsageEntry {
  label: string;
  usage: UsageSummary;
  count: number;
}

/** A cost column earns its width only once some row actually cost money. */
function anyCost(entries: readonly UsageEntry[]) {
  return entries.some((entry) => entry.usage.cost > 0);
}

function windowsTable(
  entries: readonly UsageEntry[],
  countHeader: string,
): TableSpec {
  const cost = anyCost(entries);
  return {
    head: [
      "window",
      "tokens",
      "in",
      "out",
      "cache",
      ...(cost ? ["cost"] : []),
      countHeader,
    ],
    rows: entries.map((entry) => [
      entry.label,
      formatTokens(entry.usage.totalTokens),
      formatTokens(entry.usage.input),
      formatTokens(entry.usage.output),
      formatTokens(entry.usage.cacheRead + entry.usage.cacheWrite),
      ...(cost ? [formatCost(entry.usage.cost)] : []),
      String(entry.count),
    ]),
    minColumns: MIN_TABLE_COLUMNS,
  };
}

function breakdownTable(
  entries: readonly UsageEntry[],
  total: number,
  countHeader: string,
): TableSpec {
  const cost = anyCost(entries);
  return {
    head: ["model", "tokens", "share", ...(cost ? ["cost"] : []), countHeader],
    rows: entries.map((entry) => [
      entry.label,
      formatTokens(entry.usage.totalTokens),
      formatPercent(total > 0 ? entry.usage.totalTokens / total : undefined, 0),
      ...(cost ? [formatCost(entry.usage.cost)] : []),
      String(entry.count),
    ]),
    minColumns: MIN_TABLE_COLUMNS,
  };
}

/** A window earns a row only if something happened in it. */
function isActive(entry: UsageEntry) {
  return entry.usage.totalTokens > 0 || entry.count > 0;
}

export function windowRows(
  entryOf: (window: UsageWindow) => UsageEntry,
  countHeader: string,
): UsageRow[] {
  const active: UsageEntry[] = [];
  const idle: string[] = [];
  for (const window of USAGE_WINDOWS) {
    const entry = entryOf(window);
    if (isActive(entry)) active.push(entry);
    else idle.push(entry.label);
  }

  if (active.length === 0) {
    return [{ kind: "text", value: "no recorded activity", dim: true }];
  }

  const rows: UsageRow[] = [
    { kind: "table", spec: windowsTable(active, countHeader) },
  ];
  if (idle.length > 0) {
    rows.push({
      kind: "text",
      value: `no activity: ${idle.join(", ")}`,
      dim: true,
    });
  }
  return rows;
}

export function breakdownRows(
  entries: readonly UsageEntry[],
  total: number,
  countHeader: string,
): UsageRow[] {
  if (entries.length === 0) return [];
  const top = entries.slice(0, MAX_MODEL_ROWS);
  const rows: UsageRow[] = [
    { kind: "table", spec: breakdownTable(top, total, countHeader) },
  ];
  const hidden = entries.length - top.length;
  if (hidden > 0) {
    rows.push({ kind: "text", value: `+${hidden} more`, dim: true });
  }
  return rows;
}

export function sourceRow(path: string, what: string): TextRow {
  return { kind: "text", value: `Source: ${path} — ${what}`, dim: true };
}
