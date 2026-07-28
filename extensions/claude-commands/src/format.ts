/** Display formatting shared by every claude-commands report. */

export function formatTokens(count: number) {
  if (!Number.isFinite(count)) return "?";
  const value = Math.round(count);
  if (Math.abs(value) < 1000) return value.toLocaleString("en-US");
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  if (Math.abs(value) < 1_000_000_000)
    return `${(value / 1_000_000).toFixed(2)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

export function formatCost(cost: number) {
  if (!Number.isFinite(cost)) return "?";
  if (cost === 0) return "$0.00";
  if (Math.abs(cost) < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatPercent(fraction: number | null | undefined, digits = 1) {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return "?%";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Fixed-width label so multi-row sections line up in the transcript. Labels
 * wider than the column still get a separator so they never run into the value.
 */
export function pad(label: string, width: number) {
  return label.length >= width ? `${label}  ` : label.padEnd(width);
}

export function formatBar(fraction: number | null | undefined, width = 20) {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
    return `[${"?".repeat(width)}]`;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export function formatRelativeToNow(target: Date, now: Date) {
  const deltaMs = target.getTime() - now.getTime();
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);
  const rendered =
    minutes < 60
      ? `${minutes}m`
      : minutes < 60 * 24
        ? `${Math.round(minutes / 60)}h`
        : `${Math.round(minutes / (60 * 24))}d`;
  return deltaMs >= 0 ? `in ${rendered}` : `${rendered} ago`;
}
