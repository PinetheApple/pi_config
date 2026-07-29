import {
  containsNode,
  findSection,
  isBlank,
  type RenderableNode,
} from "./component-tree.ts";
import { selectStartupStatusParts } from "./status-line.ts";

export const STARTUP_STATUS_HEADING = "[Extension Status]";

/** We render directly below the section pi lists loaded extensions in. */
const ANCHOR_HEADING = "[Extensions]";

/** The slice of pi's Theme this section needs; pi's Theme satisfies it. */
export interface SectionTheme {
  fg(color: "mdHeading", text: string): string;
}

export interface StartupStatusSource {
  getStatuses(): ReadonlyMap<string, string>;
  theme: SectionTheme;
}

/**
 * Mirrors pi's own startup sections: an `mdHeading` bracket title followed by
 * two-space indented entries and a trailing blank line. Renders nothing at all
 * when no startup-only status has arrived yet, so the banner never shows an
 * empty block.
 */
export function buildStartupStatusLines(source: StartupStatusSource) {
  const parts = selectStartupStatusParts(source.getStatuses());
  if (parts.length === 0) return [];

  return [
    source.theme.fg("mdHeading", STARTUP_STATUS_HEADING),
    ...parts.map((part) => `  ${part}`),
    "",
  ];
}

/**
 * The section reads statuses at render time rather than capturing them, so
 * asynchronously reported statuses (MCP connects well after session_start)
 * appear on the next frame without any re-insertion.
 */
export function createStartupStatusSection(
  getSource: () => StartupStatusSource | undefined,
): RenderableNode {
  return {
    render() {
      const source = getSource();
      return source ? buildStartupStatusLines(source) : [];
    },
    invalidate() {},
  };
}

/**
 * Splice the section into the container pi builds the startup banner in, so it
 * scrolls away with the banner instead of pinning to the footer. Idempotent:
 * pi clears and rebuilds that container whenever resources are rediscovered.
 */
export function installStartupStatusSection(
  root: RenderableNode,
  section: RenderableNode,
) {
  if (containsNode(root, section)) return false;

  const anchor = findSection(root, ANCHOR_HEADING);
  if (!anchor) return false;

  const { container, index } = anchor;
  const next = container.children[index + 1];
  const insertAt = next && isBlank(next) ? index + 2 : index + 1;

  container.children.splice(insertAt, 0, section);
  container.invalidate();
  return true;
}
