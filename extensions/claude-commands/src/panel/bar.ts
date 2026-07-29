/** Pure progress-bar geometry and severity classification for /usage. */

export const BAR_MAX_WIDTH = 40;
export const BAR_MIN_WIDTH = 8;

const FILLED_CELL = "█";
const EMPTY_CELL = "░";
const UNKNOWN_CELL = "·";

export const HIGH_THRESHOLD = 0.75;
export const CRITICAL_THRESHOLD = 0.9;

export type Severity = "unknown" | "normal" | "high" | "critical";

/** Text marker so severity never depends on colour alone. */
export const SEVERITY_MARKERS: Record<Severity, string> = {
  unknown: "?",
  normal: "",
  high: "!",
  critical: "!!",
};

export const MARKER_WIDTH = 2;

export function severityOf(fraction: number | undefined): Severity {
  if (typeof fraction !== "number" || !Number.isFinite(fraction))
    return "unknown";
  if (fraction >= CRITICAL_THRESHOLD) return "critical";
  if (fraction >= HIGH_THRESHOLD) return "high";
  return "normal";
}

/** Bar width for the columns left over, or undefined when the terminal is too narrow. */
export function barWidth(available: number) {
  if (!Number.isFinite(available) || available < BAR_MIN_WIDTH)
    return undefined;
  return Math.min(BAR_MAX_WIDTH, Math.floor(available));
}

export function renderBar(fraction: number | undefined, width: number) {
  if (width <= 0) return "";
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return UNKNOWN_CELL.repeat(width);
  }

  const clamped = Math.min(1, Math.max(0, fraction));
  let filled = Math.round(clamped * width);
  // Keep "some usage" and "not yet full" visually distinct from the extremes.
  if (clamped > 0 && filled === 0) filled = 1;
  if (clamped < 1 && filled === width) filled = width - 1;

  return FILLED_CELL.repeat(filled) + EMPTY_CELL.repeat(width - filled);
}
