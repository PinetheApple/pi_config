/** Compact, one-line-safe terminal titles for dashboard rows and headers. */

export const TERMINAL_TITLE_MAX_LENGTH = 80;

/**
 * Bound a title (explicit, or derived from the command). Whitespace is
 * collapsed because a newline inside a fixed-height TUI row desyncs the
 * renderer.
 */
export function normalizeTerminalTitle(title: string) {
  const collapsed = title.replace(/\s+/g, " ").trim();
  if (!collapsed) return "terminal";
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= TERMINAL_TITLE_MAX_LENGTH) return collapsed;
  return `${codePoints.slice(0, TERMINAL_TITLE_MAX_LENGTH - 1).join("")}…`;
}
