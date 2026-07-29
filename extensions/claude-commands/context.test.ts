import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildContextBreakdown,
  type ContextBreakdown,
  type ContextSources,
} from "./src/context/breakdown.ts";
import { ESTIMATED_IMAGE_CHARS } from "./src/context/tally.ts";
import { buildContextView } from "./src/context/view.ts";
import { layoutGauge, renderPanelText } from "./src/panel/layout.ts";
import { buildOverlayLines, type PanelTheme } from "./src/panel/overlay.ts";

const WIDE = 80;
const WINDOW = 200_000;
const BASE_PROMPT = "b".repeat(400);
const SKILLS_PROMPT = "s".repeat(200);
const INSTRUCTIONS = "i".repeat(800);

let nextId = 0;

/** `message` is an AgentMessage; the union lives in a package pi does not vendor. */
function entry(type: string, fields: Record<string, unknown>): SessionEntry {
  nextId += 1;
  return {
    type,
    id: `e${nextId}`,
    parentId: null,
    timestamp: "2026-07-29T00:00:00.000Z",
    ...fields,
  } as SessionEntry;
}

function message(payload: Record<string, unknown>) {
  return entry("message", { message: { timestamp: 0, ...payload } });
}

function sources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    usage: { tokens: 40_000, contextWindow: WINDOW, percent: 20 },
    modelLabel: "anthropic/claude",
    fallbackContextWindow: undefined,
    systemPrompt: BASE_PROMPT + INSTRUCTIONS + SKILLS_PROMPT,
    contextFiles: [{ path: "/repo/AGENTS.md", content: INSTRUCTIONS }],
    skillsPrompt: SKILLS_PROMPT,
    skillCount: 3,
    tools: [
      { name: "read", description: "d".repeat(96), parameters: { a: 1 } },
      { name: "bash", description: "d".repeat(40), parameters: {} },
    ],
    entries: [],
    ...overrides,
  };
}

function categoryOf(breakdown: ContextBreakdown, key: string) {
  return breakdown.categories.find((entry) => entry.key === key);
}

test("prompt inputs are attributed to their own source, not lumped together", () => {
  const breakdown = buildContextBreakdown(sources());

  assert.equal(categoryOf(breakdown, "system")?.tokens, 100);
  assert.equal(categoryOf(breakdown, "instructions")?.tokens, 200);
  assert.equal(categoryOf(breakdown, "skills")?.tokens, 50);
  assert.match(categoryOf(breakdown, "skills")?.detail ?? "", /3 skills/);
  assert.deepEqual(
    breakdown.instructionFiles.map((file) => file.name),
    ["/repo/AGENTS.md"],
  );
});

test("a context file absent from the prompt is not attributed to it", () => {
  const breakdown = buildContextBreakdown(
    sources({
      contextFiles: [{ path: "/repo/UNUSED.md", content: "z".repeat(4000) }],
    }),
  );

  assert.equal(categoryOf(breakdown, "instructions"), undefined);
  assert.deepEqual(breakdown.instructionFiles, []);
  // The whole prompt stays attributed to the base prompt instead of vanishing.
  assert.equal(
    categoryOf(breakdown, "system")?.chars,
    BASE_PROMPT.length + INSTRUCTIONS.length,
  );
});

test("tool schemas are counted per active tool and reported as unavailable when absent", () => {
  const withTools = buildContextBreakdown(sources());
  assert.equal(withTools.toolsAvailable, true);
  assert.deepEqual(
    withTools.toolSchemas.map((tool) => tool.name),
    ["read", "bash"],
  );
  assert.equal(
    categoryOf(withTools, "tools")?.tokens,
    withTools.toolSchemas.reduce((total, tool) => total + tool.tokens, 0),
  );

  const without = buildContextBreakdown(sources({ tools: undefined }));
  assert.equal(without.toolsAvailable, false);
  assert.equal(categoryOf(without, "tools"), undefined);
  assert.deepEqual(without.toolSchemas, []);
});

test("assistant output is split into replies, reasoning and tool-call arguments", () => {
  const breakdown = buildContextBreakdown(
    sources({
      entries: [
        message({
          role: "assistant",
          content: [
            { type: "text", text: "t".repeat(40) },
            { type: "thinking", thinking: "h".repeat(80) },
            { type: "toolCall", name: "read", arguments: { path: "/a" } },
          ],
        }),
      ],
    }),
  );

  assert.equal(categoryOf(breakdown, "assistant")?.tokens, 10);
  assert.equal(categoryOf(breakdown, "reasoning")?.tokens, 20);
  const calls = categoryOf(breakdown, "toolCalls");
  assert.equal(
    calls?.chars,
    "read".length + JSON.stringify({ path: "/a" }).length,
  );
  assert.match(calls?.detail ?? "", /1 call/);
});

test("tool results are grouped by tool, largest first", () => {
  const breakdown = buildContextBreakdown(
    sources({
      entries: [
        message({
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "b".repeat(4000) }],
        }),
        message({
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "r".repeat(8000) }],
        }),
        message({
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "b".repeat(400) }],
        }),
      ],
    }),
  );

  assert.deepEqual(
    breakdown.toolResults.map((tool) => [tool.name, tool.tokens, tool.count]),
    [
      ["read", 2000, 1],
      ["bash", 1100, 2],
    ],
  );
  assert.equal(categoryOf(breakdown, "toolResults")?.tokens, 3100);
  assert.equal(breakdown.categories[0]?.key, "toolResults");
});

test("images are counted once, at pi's own flat allowance", () => {
  const breakdown = buildContextBreakdown(
    sources({
      entries: [
        message({
          role: "user",
          content: [
            { type: "text", text: "u".repeat(40) },
            { type: "image", data: "x".repeat(10_000), mimeType: "image/png" },
          ],
        }),
      ],
    }),
  );

  // The base64 payload never counts as text.
  assert.equal(categoryOf(breakdown, "user")?.tokens, 10);
  assert.equal(categoryOf(breakdown, "images")?.chars, ESTIMATED_IMAGE_CHARS);
});

test("bash output excluded from context with !! is not counted", () => {
  const counted = buildContextBreakdown(
    sources({
      entries: [
        message({
          role: "bashExecution",
          command: "ls",
          output: "o".repeat(38),
        }),
      ],
    }),
  );
  assert.equal(categoryOf(counted, "bash")?.tokens, 10);

  const excluded = buildContextBreakdown(
    sources({
      entries: [
        message({
          role: "bashExecution",
          command: "ls",
          output: "o".repeat(38),
          excludeFromContext: true,
        }),
      ],
    }),
  );
  assert.equal(categoryOf(excluded, "bash"), undefined);
});

test("custom messages and compaction summaries are attributed, custom entries are not", () => {
  const breakdown = buildContextBreakdown(
    sources({
      entries: [
        entry("custom_message", {
          customType: "workflow",
          content: [{ type: "text", text: "c".repeat(80) }],
          display: true,
        }),
        entry("compaction", {
          summary: "s".repeat(200),
          firstKeptEntryId: "e1",
          tokensBefore: 1000,
        }),
        // A custom entry never reaches the model, so it must not be counted.
        entry("custom", { customType: "claude-commands-report", data: {} }),
      ],
    }),
  );

  assert.equal(categoryOf(breakdown, "custom")?.tokens, 20);
  const summaries = categoryOf(breakdown, "summaries");
  // The compaction summary is wrapped in a prefix/suffix before it is sent.
  assert.ok((summaries?.chars ?? 0) >= 200);
  assert.match(summaries?.detail ?? "", /1 summary/);
});

test("free space follows the measured total when there is one", () => {
  const measured = buildContextBreakdown(sources());
  assert.equal(measured.freeIsMeasured, true);
  assert.equal(measured.freeTokens, WINDOW - 40_000);

  const estimated = buildContextBreakdown(
    sources({ usage: { tokens: null, contextWindow: WINDOW, percent: null } }),
  );
  assert.equal(estimated.freeIsMeasured, false);
  assert.equal(estimated.freeTokens, WINDOW - estimated.estimatedTotal);
});

test("a mostly empty window is not painted as an emergency", () => {
  const roomy = buildContextView(buildContextBreakdown(sources()));
  const [breakdown] = roomy.sections.filter((section) =>
    section.heading.startsWith("Breakdown"),
  );
  const free = breakdown?.rows.find(
    (row) => row.kind === "gauge" && row.label === "Free space",
  );
  assert.ok(free?.kind === "gauge");
  assert.equal(layoutGauge(free, WIDE).severity, "normal");

  const tight = buildContextView(
    buildContextBreakdown(
      sources({
        usage: { tokens: 195_000, contextWindow: WINDOW, percent: 97 },
      }),
    ),
  );
  const tightFree = tight.sections
    .flatMap((section) => section.rows)
    .find((row) => row.kind === "gauge" && row.label === "Free space");
  assert.ok(tightFree?.kind === "gauge");
  assert.equal(layoutGauge(tightFree, WIDE).severity, "critical");
});

test("an unknown window leaves free space unknown rather than guessed", () => {
  const breakdown = buildContextBreakdown(
    sources({ usage: undefined, fallbackContextWindow: undefined }),
  );
  assert.equal(breakdown.window, 0);
  assert.equal(breakdown.freeTokens, null);
  assert.equal(breakdown.measuredTokens, null);

  const text = renderPanelText(buildContextView(breakdown), WIDE);
  assert.match(text, /Window\s+unknown/);
  assert.ok(!text.includes("Free space"));
});

test("the view separates the measured total from the estimated breakdown", () => {
  const text = renderPanelText(
    buildContextView(buildContextBreakdown(sources())),
    WIDE,
  );

  assert.ok(text.startsWith("Context"));
  assert.match(text, /Used\s+40\.0k tokens \(measured\)/);
  assert.match(text, /Attributed\s+~[\d.]+k? tokens \(estimated below\)/);
  assert.match(text, /Breakdown \(estimated, largest first\)/);
  // Every estimated figure is marked as one; free space is measured arithmetic.
  for (const line of text.split("\n")) {
    if (line.includes("tok ·") && !line.includes("window minus")) {
      assert.ok(line.includes("~"), line);
    }
  }
  assert.match(text, /window minus the measured total/);
});

test("the view degrades to plain text at any width without overflowing", () => {
  const view = buildContextView(
    buildContextBreakdown(
      sources({
        entries: [
          message({
            role: "toolResult",
            toolName: "read",
            content: [{ type: "text", text: "r".repeat(8000) }],
          }),
        ],
      }),
    ),
  );

  for (const width of [24, 38, 60, WIDE, 120]) {
    for (const line of renderPanelText(view, width).split("\n")) {
      assert.ok(line.length <= width, `${width}: ${line}`);
    }
  }
});

function stubTheme(): PanelTheme {
  return { fg: (color, text) => `<${color}>${text}`, bold: (text) => text };
}

test("the overlay paints a nearly full window as critical", () => {
  const view = buildContextView(
    buildContextBreakdown(
      sources({
        usage: { tokens: 195_000, contextWindow: WINDOW, percent: 97 },
      }),
    ),
  );

  const lines = buildOverlayLines(view, WIDE, stubTheme());
  assert.ok(lines.some((line) => line.startsWith("<accent>Overview")));
  assert.ok(lines.some((line) => line.includes("<error>")));
  assert.ok(lines.some((line) => line.includes("█")));
});
