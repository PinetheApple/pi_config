/** Time-window bucketing shared by every /usage source. */

export type UsageWindow = "all" | "today" | "7d" | "30d";

export const USAGE_WINDOWS: readonly UsageWindow[] = [
  "all",
  "today",
  "7d",
  "30d",
];

export const WINDOW_LABELS: Record<UsageWindow, string> = {
  all: "all time",
  today: "today",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive lower bound (epoch ms) for a window; -Infinity means unbounded. */
export function windowStart(window: UsageWindow, now: Date) {
  switch (window) {
    case "all":
      return Number.NEGATIVE_INFINITY;
    case "today":
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      ).getTime();
    case "7d":
      return now.getTime() - 7 * DAY_MS;
    case "30d":
      return now.getTime() - 30 * DAY_MS;
  }
}

export function inWindow(atMs: number, window: UsageWindow, now: Date) {
  if (!Number.isFinite(atMs)) return window === "all";
  return atMs >= windowStart(window, now) && atMs <= now.getTime();
}

/** Parse an ISO timestamp to epoch ms, or NaN when unusable. */
export function toEpochMs(timestamp: string | number | undefined | null) {
  if (timestamp === undefined || timestamp === null) return Number.NaN;
  const parsed =
    typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
