import type { Theme } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import { formatSubagentWidget } from "./src/format.ts";

/** Colours are irrelevant to layout; tag the role so assertions can see it. */
const theme = {
  fg: (role: string, text: string) => `<${role}>${text}`,
} as unknown as Theme;

const plain = (lines: readonly string[]) =>
  lines.map((line) => line.replace(/<[a-z]+>/g, ""));

function snapshot(
  overrides: Partial<SubagentSnapshot> & { id: string },
): SubagentSnapshot {
  return {
    origin: "model",
    backend: "pi",
    title: "task",
    prompt: "p",
    cwd: "/tmp",
    status: "running",
    createdAt: Date.now() - 5_000,
    settledAt: Date.now(),
    meta: { backend: "pi", modelLabel: "anthropic/claude-opus-4-5" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  } as SubagentSnapshot;
}

test("no subagents clears the widget", () => {
  assert.equal(formatSubagentWidget(theme, []), undefined);
});

test("each subagent gets a row with id, name, harness/model, and a status square", () => {
  const lines = formatSubagentWidget(theme, [
    snapshot({ id: "sa-1", title: "Fix parser", status: "running" }),
    snapshot({
      id: "sa-2",
      title: "Write tests",
      status: "done",
      backend: "claude",
      meta: { backend: "claude", modelLabel: "sonnet" },
    }),
  ]);
  assert.ok(lines);
  const [header, first, second] = plain(lines);
  assert.match(
    header,
    /subagents: ■ 1 running · ■ 1 done · \/subagents to view/,
  );
  assert.match(
    first,
    /^ {2}■ sa-1 Fix parser pi\/anthropic\/claude-opus-4-5 \d+s$/,
  );
  assert.match(second, /^ {2}■ sa-2 Write tests claude\/sonnet \d+s$/);
});

test("status squares carry the running/done/error colours", () => {
  const lines = formatSubagentWidget(theme, [
    snapshot({ id: "sa-1", status: "running" }),
    snapshot({ id: "sa-2", status: "done" }),
    snapshot({ id: "sa-3", status: "error" }),
  ]);
  assert.ok(lines);
  assert.ok(lines[1].includes("<warning>■"));
  assert.ok(lines[2].includes("<success>■"));
  assert.ok(lines[3].includes("<error>■"));
});

test("running subagents win the row budget and the rest collapse into +N more", () => {
  const subs = [
    ...Array.from({ length: 5 }, (_, i) =>
      snapshot({ id: `done-${i}`, status: "done" }),
    ),
    snapshot({ id: "live-1", status: "running" }),
    snapshot({ id: "live-2", status: "running" }),
  ];
  const lines = formatSubagentWidget(theme, subs);
  assert.ok(lines);
  // Header + 5 rows + overflow.
  assert.equal(lines.length, 7);
  const rendered = plain(lines);
  assert.ok(rendered[1].includes("live-1"));
  assert.ok(rendered[2].includes("live-2"));
  assert.ok(rendered[3].includes("done-0"));
  assert.equal(rendered[6].trim(), "+2 more");
});

test("long titles are clipped so a row stays one line", () => {
  const lines = formatSubagentWidget(theme, [
    snapshot({ id: "sa-1", title: "x".repeat(80) }),
  ]);
  assert.ok(lines);
  assert.ok(plain(lines)[1].includes(`${"x".repeat(35)}…`));
  assert.ok(!plain(lines)[1].includes("x".repeat(37)));
});

test("an unknown model label degrades to harness/?", () => {
  const lines = formatSubagentWidget(theme, [
    snapshot({ id: "sa-1", backend: "codex", meta: { backend: "codex" } }),
  ]);
  assert.ok(lines);
  assert.ok(plain(lines)[1].includes("codex/?"));
});
