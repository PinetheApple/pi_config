/**
 * Formatting helpers (self-contained copies of the v1 shared helpers:
 * context-utilization + activity-status).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  formatElapsed,
  type SubagentSnapshot,
  type SubagentStatus,
} from "./domain.ts";

export interface ContextUtilization {
  /** Current conversation context occupancy; undefined while unknown. */
  tokens?: number | null;
  /** Capacity of the model currently serving the conversation. */
  contextWindow?: number | null;
}

function usableTokens(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usableCapacity(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function contextPercent(usage: ContextUtilization) {
  const tokens = usableTokens(usage.tokens);
  const capacity = usableCapacity(usage.contextWindow);
  if (tokens === undefined || capacity === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, (tokens / capacity) * 100)));
}

export function formatCompactTokens(count: number) {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Render `%/capacity`. If occupancy is unknown, retain the useful capacity
 * as `?%/capacity`; with no valid capacity, omit the statistic entirely.
 */
export function formatContextUtilization(usage: ContextUtilization) {
  const capacity = usableCapacity(usage.contextWindow);
  if (capacity === undefined) return "";
  const percent = contextPercent(usage);
  return `${percent === undefined ? "?" : percent}%/${formatCompactTokens(capacity)}`;
}

interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
}

const SQUARE = "■";

export function formatActivityStatus(theme: Theme, counts: ActivityCounts) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(theme.fg("warning", `${SQUARE} ${counts.running} running`));
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `${SQUARE} ${counts.done} done`));
  }
  if (counts.failed > 0) {
    parts.push(theme.fg("error", `${SQUARE} ${counts.failed} failed`));
  }
  parts.push(theme.fg("accent", "/subagents") + theme.fg("dim", " to view"));

  return `${theme.fg("muted", "subagents:")} ${parts.join(theme.fg("dim", " · "))}`;
}

/** Status colour shared by the above-editor widget and the takeover list. */
export function statusGlyph(theme: Theme, status: SubagentStatus) {
  switch (status) {
    case "running":
      return theme.fg("warning", SQUARE);
    case "done":
      return theme.fg("success", SQUARE);
    case "error":
      return theme.fg("error", SQUARE);
  }
}

/** Rows the widget shows in full before collapsing the rest into "+N more". */
const WIDGET_MAX_ROWS = 5;
const WIDGET_TITLE_MAX = 36;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Running first, then in spawn order, so live work never falls off the cap. */
const activityRank = (snap: SubagentSnapshot) =>
  snap.status === "running" ? 0 : 1;

function formatWidgetRow(theme: Theme, snap: SubagentSnapshot) {
  return `  ${[
    statusGlyph(theme, snap.status),
    theme.fg("dim", snap.id),
    theme.fg("text", clip(snap.title, WIDGET_TITLE_MAX)),
    theme.fg("muted", `${snap.backend}/${snap.meta.modelLabel ?? "?"}`),
    theme.fg("dim", formatElapsed(snap)),
  ].join(" ")}`;
}

/**
 * The above-editor widget: a counts header carrying the `/subagents` hint,
 * then one compact row per subagent. `undefined` when there is nothing to
 * show, which is also how the widget is cleared.
 */
export function formatSubagentWidget(
  theme: Theme,
  subs: readonly SubagentSnapshot[],
) {
  if (subs.length === 0) return undefined;
  const running = subs.filter((snap) => snap.status === "running").length;
  const failed = subs.filter((snap) => snap.status === "error").length;
  const ordered = subs
    .map((snap, index) => ({ snap, index }))
    .sort(
      (a, b) =>
        activityRank(a.snap) - activityRank(b.snap) || a.index - b.index,
    )
    .map((entry) => entry.snap);

  const lines = [
    formatActivityStatus(theme, {
      running,
      done: subs.length - running - failed,
      failed,
    }),
    ...ordered
      .slice(0, WIDGET_MAX_ROWS)
      .map((snap) => formatWidgetRow(theme, snap)),
  ];
  const hidden = ordered.length - WIDGET_MAX_ROWS;
  if (hidden > 0) lines.push(theme.fg("dim", `   +${hidden} more`));
  return lines;
}
