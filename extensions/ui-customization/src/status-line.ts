import { truncateToWidth } from "@earendil-works/pi-tui";

const STATUS_SEPARATOR = " · ";
export const STATUS_ELLIPSIS = "...";

/**
 * Statuses that belong in the start-of-session banner rather than the always
 * visible footer row. They report one-off load results, not live state, so
 * pinning them to the footer is pure noise. Add a key here to move it.
 */
export const STARTUP_ONLY_STATUS_KEYS: ReadonlySet<string> = new Set([
  "headroom",
  "mcp",
  "mcp-auth",
]);

/** Split statuses into displayable parts, ordered by key so layout is stable. */
function statusParts(statuses: ReadonlyMap<string, string>) {
  return Array.from(statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, text]) => text.split("\n"))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function selectFooterStatuses(statuses: ReadonlyMap<string, string>) {
  return new Map(
    Array.from(statuses.entries()).filter(
      ([key]) => !STARTUP_ONLY_STATUS_KEYS.has(key),
    ),
  );
}

export function selectStartupStatusParts(
  statuses: ReadonlyMap<string, string>,
) {
  return statusParts(
    new Map(
      Array.from(statuses.entries()).filter(([key]) =>
        STARTUP_ONLY_STATUS_KEYS.has(key),
      ),
    ),
  );
}

/**
 * Extension statuses (ctx.ui.setStatus) each get their own map entry; we render
 * them as one footer row, ordered by key so the layout stays stable.
 */
export function composeStatusLine(
  statuses: ReadonlyMap<string, string>,
  width: number,
  ellipsis: string = STATUS_ELLIPSIS,
) {
  const parts = statusParts(statuses);

  if (parts.length === 0) return "";
  return truncateToWidth(parts.join(STATUS_SEPARATOR), width, ellipsis);
}
