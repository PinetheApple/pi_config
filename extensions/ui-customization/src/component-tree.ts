/** Strips SGR/OSC sequences so section headings can be matched as plain text. */
const ANSI_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

/** Width used to probe a component's text; wide enough that headings never wrap. */
const PROBE_WIDTH = 200;

export interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

export interface SectionLocation {
  container: RenderableNode & { children: RenderableNode[] };
  index: number;
}

export function hasChildren(
  node: RenderableNode,
): node is RenderableNode & { children: RenderableNode[] } {
  return Array.isArray(node.children);
}

export function renderedText(node: RenderableNode) {
  try {
    return node.render(PROBE_WIDTH).join("\n").replace(ANSI_PATTERN, "");
  } catch {
    return "";
  }
}

export function isBlank(node: RenderableNode) {
  return renderedText(node).trim() === "";
}

function headingOf(node: RenderableNode) {
  return renderedText(node)
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
}

/**
 * pi builds its startup banner as one child per section ([Extensions],
 * [Themes], ...) inside a shared container. Find a section by its heading line.
 *
 * A container renders its children concatenated, so its own first line is the
 * heading of its first section. We therefore descend before matching, to return
 * the section itself rather than the container that happens to start with it.
 */
export function findSection(
  root: RenderableNode,
  heading: string,
): SectionLocation | undefined {
  if (!hasChildren(root)) return undefined;

  for (let index = 0; index < root.children.length; index += 1) {
    const child = root.children[index]!;

    const nested = findSection(child, heading);
    if (nested) return nested;

    if (headingOf(child) === heading) return { container: root, index };
  }

  return undefined;
}

export function containsNode(
  root: RenderableNode,
  node: RenderableNode,
): boolean {
  if (!hasChildren(root)) return false;
  return root.children.some(
    (child) => child === node || containsNode(child, node),
  );
}
