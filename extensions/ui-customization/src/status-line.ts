import { truncateToWidth } from "@earendil-works/pi-tui";

const STATUS_SEPARATOR = " · ";
export const STATUS_ELLIPSIS = "...";

/**
 * Extension statuses (ctx.ui.setStatus) each get their own map entry; we render
 * them as one footer row, ordered by key so the layout stays stable.
 */
export function composeStatusLine(
  statuses: ReadonlyMap<string, string>,
  width: number,
  ellipsis: string = STATUS_ELLIPSIS,
) {
  const parts = Array.from(statuses.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, text]) => text.split("\n"))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return "";
  return truncateToWidth(parts.join(STATUS_SEPARATOR), width, ellipsis);
}
