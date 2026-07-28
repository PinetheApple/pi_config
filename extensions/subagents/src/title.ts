/** Compact, one-line-safe titles for dashboard rows and takeover headers. */

/** Build a title from the first non-empty prompt line. */
export function deriveTitleFromPrompt(
  prompt: string,
  options: { fallback: string; maxLength: number },
) {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const title = firstLine?.replace(/\s+/g, " ") ?? "";
  if (!title) return options.fallback;
  const codePoints = Array.from(title);
  if (codePoints.length <= options.maxLength) return title;
  return `${codePoints.slice(0, options.maxLength - 1).join("")}…`;
}

/**
 * Bound a user- or model-supplied title. Whitespace is collapsed because a
 * newline inside a fixed-height TUI row desyncs the renderer.
 */
export function normalizeTitle(
  title: string,
  options: { fallback: string; maxLength: number },
) {
  const collapsed = title.replace(/\s+/g, " ").trim();
  if (!collapsed) return options.fallback;
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= options.maxLength) return collapsed;
  return `${codePoints.slice(0, options.maxLength - 1).join("")}…`;
}
