import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeStatusLine } from "./src/status-line.ts";

const WIDTH = 80;
const ESC = String.fromCharCode(27);
const HEADROOM = "✓ Headroom";
const MCP = "MCP: 1 server enabled";

test("joins both statuses onto one line ordered by key", () => {
  const statuses = new Map([
    ["mcp", MCP],
    ["headroom", HEADROOM],
  ]);
  assert.equal(composeStatusLine(statuses, WIDTH), `${HEADROOM} · ${MCP}`);
});

test("renders the remaining status alone when the other is absent", () => {
  assert.equal(
    composeStatusLine(new Map([["headroom", HEADROOM]]), WIDTH),
    HEADROOM,
  );
  assert.equal(composeStatusLine(new Map([["mcp", MCP]]), WIDTH), MCP);
});

test("renders nothing when no status is present", () => {
  assert.equal(composeStatusLine(new Map(), WIDTH), "");
});

test("ignores statuses that are empty or whitespace only", () => {
  const statuses = new Map([
    ["headroom", ""],
    ["mcp", "   "],
  ]);
  assert.equal(composeStatusLine(statuses, WIDTH), "");
  assert.equal(
    composeStatusLine(new Map([...statuses, ["zz", MCP]]), WIDTH),
    MCP,
  );
});

test("flattens a multi-line status into the shared line", () => {
  const statuses = new Map([["mcp", `${MCP}\n2 tools`]]);
  assert.equal(composeStatusLine(statuses, WIDTH), `${MCP} · 2 tools`);
});

test("truncates long content to the available width", () => {
  const statuses = new Map([
    ["headroom", HEADROOM],
    ["mcp", "M".repeat(200)],
  ]);
  const line = composeStatusLine(statuses, WIDTH, "...");
  assert.equal(visibleWidth(line), WIDTH);
  assert.ok(line.startsWith(HEADROOM));
  assert.ok(line.includes("..."));
});

test("preserves ansi styling from the source statuses", () => {
  const painted = `${ESC}[32m✓${ESC}[0m${ESC}[2m Headroom${ESC}[0m`;
  const line = composeStatusLine(new Map([["headroom", painted]]), WIDTH);
  assert.equal(line, painted);
  assert.equal(visibleWidth(line), visibleWidth(HEADROOM));
});
