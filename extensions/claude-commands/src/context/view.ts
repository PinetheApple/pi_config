/**
 * The /context view model: a breakdown in, panel sections out. Nothing here
 * touches the TUI.
 */

import { formatPercent, formatTokens, homeRelative } from "../format.ts";
import type { PanelRow, PanelSection, PanelView } from "../panel/rows.ts";
import type { TableSpec } from "../panel/table.ts";
import type { ContextBreakdown, NamedTotal } from "./breakdown.ts";

/** Detail tables stay readable: everything past this collapses into one row. */
export const MAX_TABLE_ROWS = 8;
/** The name column and its token count survive any terminal width. */
const MIN_TABLE_COLUMNS = 2;

function fractionOf(tokens: number, window: number) {
  return window > 0 ? tokens / window : undefined;
}

function overviewSection(breakdown: ContextBreakdown): PanelSection {
  const { window, measuredTokens } = breakdown;
  const rows: PanelRow[] = [
    { kind: "text", label: "Model", value: breakdown.modelLabel },
    {
      kind: "text",
      label: "Window",
      value: window > 0 ? `${formatTokens(window)} tokens` : "unknown",
    },
    {
      kind: "text",
      label: "Used",
      value:
        measuredTokens === null
          ? "unknown — no provider usage since the last compaction"
          : `${formatTokens(measuredTokens)} tokens (measured)`,
    },
    {
      kind: "text",
      label: "Attributed",
      value: `~${formatTokens(breakdown.estimatedTotal)} tokens (estimated below)`,
    },
  ];

  if (measuredTokens !== null) {
    rows.push({
      kind: "gauge",
      label: "Window fill (measured)",
      fraction: fractionOf(measuredTokens, window),
      note:
        window > 0
          ? `${formatTokens(Math.max(0, window - measuredTokens))} tokens left`
          : "context window unknown",
    });
  }

  return { heading: "Overview", rows };
}

function breakdownSection(breakdown: ContextBreakdown): PanelSection {
  const rows: PanelRow[] = breakdown.categories.map((entry) => ({
    kind: "gauge",
    label: entry.label,
    fraction: fractionOf(entry.tokens, breakdown.window),
    note: `~${formatTokens(entry.tokens)} tok · ${entry.detail}`,
  }));

  if (rows.length === 0) {
    rows.push({ kind: "text", value: "nothing in context yet", dim: true });
  }

  if (breakdown.freeTokens !== null) {
    const free = fractionOf(breakdown.freeTokens, breakdown.window);
    rows.push({
      kind: "gauge",
      label: "Free space",
      fraction: free,
      // Pressure is what deserves a warning, and pressure is the inverse.
      ...(free === undefined ? {} : { severityFraction: 1 - free }),
      note: `${formatTokens(breakdown.freeTokens)} tok · window minus the ${
        breakdown.freeIsMeasured ? "measured" : "estimated"
      } total`,
    });
  }

  if (!breakdown.toolsAvailable) {
    rows.push({
      kind: "text",
      value: "tool schemas unavailable in this mode — not counted above",
      dim: true,
    });
  }

  return { heading: "Breakdown (estimated, largest first)", rows };
}

function shareOf(tokens: number, window: number) {
  return window > 0 ? formatPercent(tokens / window, 1) : "?%";
}

function totalsTable(
  totals: readonly NamedTotal[],
  window: number,
  countHeader: string | undefined,
  nameOf: (name: string) => string = (name) => name,
): TableSpec {
  const shown = totals.slice(0, MAX_TABLE_ROWS);
  const rest = totals.slice(MAX_TABLE_ROWS);
  const head = ["name", "tokens", "share"];
  const rows = shown.map((entry) => [
    nameOf(entry.name),
    `~${formatTokens(entry.tokens)}`,
    shareOf(entry.tokens, window),
    ...(countHeader ? [String(entry.count)] : []),
  ]);

  if (rest.length > 0) {
    const tokens = rest.reduce((total, entry) => total + entry.tokens, 0);
    const count = rest.reduce((total, entry) => total + entry.count, 0);
    rows.push([
      `${rest.length} more`,
      `~${formatTokens(tokens)}`,
      shareOf(tokens, window),
      ...(countHeader ? [String(count)] : []),
    ]);
  }

  return {
    head: countHeader ? [...head, countHeader] : head,
    rows,
    minColumns: MIN_TABLE_COLUMNS,
  };
}

function detailSection(
  heading: string,
  totals: readonly NamedTotal[],
  window: number,
  countHeader: string | undefined,
  nameOf?: (name: string) => string,
): PanelSection | undefined {
  if (totals.length === 0) return undefined;
  return {
    heading,
    rows: [
      { kind: "table", spec: totalsTable(totals, window, countHeader, nameOf) },
    ],
  };
}

const FOOTER =
  "Only two numbers here are measured: the context window and the used total, both reported by the provider for its last request. Every ~ figure is pi's own 4-chars-per-token estimate over the exact text it would send, so categories are comparable to each other but will not add up to the measured total — provider overhead, cached blocks and tokenizer differences are not attributable to any category. Images use a flat allowance rather than a real count.";

export function buildContextView(breakdown: ContextBreakdown): PanelView {
  const sections = [
    overviewSection(breakdown),
    breakdownSection(breakdown),
    detailSection(
      "Tool results by tool",
      breakdown.toolResults,
      breakdown.window,
      "results",
    ),
    detailSection(
      "Instruction files",
      breakdown.instructionFiles,
      breakdown.window,
      undefined,
      homeRelative,
    ),
    detailSection(
      "Tool schemas",
      breakdown.toolSchemas,
      breakdown.window,
      undefined,
    ),
  ];

  return {
    title: "Context",
    sections: sections.filter((section) => section !== undefined),
    footer: FOOTER,
  };
}
