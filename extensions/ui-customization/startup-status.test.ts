import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderableNode } from "./src/component-tree.ts";
import {
  createStartupStatusSection,
  installStartupStatusSection,
  STARTUP_STATUS_HEADING,
  type StartupStatusSource,
} from "./src/startup-status.ts";

const HEADROOM = "✓ Headroom";
const MCP = "🔌 MCP: 1 server enabled";

const theme = { fg: (_color: "mdHeading", text: string) => text };

function textNode(...lines: string[]): RenderableNode {
  return { render: () => lines, invalidate() {} };
}

/** A stand-in for the container pi builds its startup banner in. */
function bannerRoot(...children: RenderableNode[]) {
  let invalidated = 0;
  const container = {
    children,
    render: () => children.flatMap((child) => child.render(200)),
    invalidate() {
      invalidated += 1;
    },
    get invalidated() {
      return invalidated;
    },
  };
  return {
    children: [container],
    render: () => [],
    invalidate() {},
    container,
  };
}

function sourceOf(statuses: Record<string, string>): StartupStatusSource {
  return { getStatuses: () => new Map(Object.entries(statuses)), theme };
}

test("renders a startup section matching pi's banner shape", () => {
  const section = createStartupStatusSection(() =>
    sourceOf({ headroom: HEADROOM, mcp: MCP, permissions: "ask" }),
  );

  assert.deepEqual(section.render(200), [
    STARTUP_STATUS_HEADING,
    `  ${HEADROOM}`,
    `  ${MCP}`,
    "",
  ]);
});

test("renders nothing while no startup status has arrived", () => {
  assert.deepEqual(
    createStartupStatusSection(() => sourceOf({})).render(200),
    [],
  );
  assert.deepEqual(
    createStartupStatusSection(() => sourceOf({ permissions: "ask" })).render(
      200,
    ),
    [],
  );
  assert.deepEqual(createStartupStatusSection(() => undefined).render(200), []);
});

test("picks up statuses reported after insertion without re-inserting", () => {
  const statuses = new Map<string, string>();
  const section = createStartupStatusSection(() => ({
    getStatuses: () => statuses,
    theme,
  }));
  const root = bannerRoot(textNode("[Extensions]", "  ui-customization"));

  assert.equal(installStartupStatusSection(root, section), true);
  assert.deepEqual(section.render(200), []);

  statuses.set("mcp", MCP);
  assert.deepEqual(section.render(200), [
    STARTUP_STATUS_HEADING,
    `  ${MCP}`,
    "",
  ]);
  assert.equal(installStartupStatusSection(root, section), false);
});

test("inserts directly after the extensions section and its spacer", () => {
  const section = createStartupStatusSection(() =>
    sourceOf({ headroom: HEADROOM }),
  );
  const root = bannerRoot(
    textNode("[Skills]", "  a"),
    textNode(""),
    textNode("[Extensions]", "  ui-customization"),
    textNode(""),
    textNode("[Themes]", "  pi-dark"),
  );

  assert.equal(installStartupStatusSection(root, section), true);
  assert.equal(root.container.children[4], section);
  assert.equal(root.container.invalidated, 1);
});

test("inserts right after the extensions section when no spacer follows", () => {
  const section = createStartupStatusSection(() =>
    sourceOf({ headroom: HEADROOM }),
  );
  const root = bannerRoot(
    textNode("[Extensions]", "  ui-customization"),
    textNode("[Themes]", "  pi-dark"),
  );

  assert.equal(installStartupStatusSection(root, section), true);
  assert.equal(root.container.children[1], section);
});

test("does nothing when the banner has no extensions section", () => {
  const section = createStartupStatusSection(() =>
    sourceOf({ headroom: HEADROOM }),
  );
  const root = bannerRoot(textNode("[Skills]", "  a"));

  assert.equal(installStartupStatusSection(root, section), false);
  assert.equal(root.container.children.length, 1);
});

test("re-inserts after pi rebuilds the banner container", () => {
  const section = createStartupStatusSection(() =>
    sourceOf({ headroom: HEADROOM }),
  );
  const root = bannerRoot(textNode("[Extensions]", "  ui-customization"));

  assert.equal(installStartupStatusSection(root, section), true);
  root.container.children.length = 0;
  root.container.children.push(textNode("[Extensions]", "  ui-customization"));

  assert.equal(installStartupStatusSection(root, section), true);
  assert.equal(root.container.children[1], section);
});

test("matches the extensions heading through ansi styling", () => {
  const ESC = String.fromCharCode(27);
  const section = createStartupStatusSection(() =>
    sourceOf({ headroom: HEADROOM }),
  );
  const root = bannerRoot(
    textNode(`${ESC}[1m[Extensions]${ESC}[0m`, "  ui-customization"),
  );

  assert.equal(installStartupStatusSection(root, section), true);
});
