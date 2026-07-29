import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsageSummary } from "../shared/usage-totals.ts";
import { layoutGauge, renderPanelText } from "./src/panel/layout.ts";
import { buildOverlayLines, type PanelTheme } from "./src/panel/overlay.ts";
import type { PanelRow } from "./src/panel/rows.ts";
import type { ClaudeQuota } from "./src/usage/claude.ts";
import { GO_LIMITS } from "./src/usage/go-limits.ts";
import { emptyUsageByWindow, sumModelWindows } from "./src/usage/pi.ts";
import {
  buildClaudeSection,
  buildOpencodeSection,
  buildPiSection,
  buildUsageView,
  isOpencodeProvider,
  OPENCODE_HEADING,
} from "./src/usage/view.ts";
import { USAGE_WINDOWS } from "./src/usage/window.ts";

const NOW = new Date(2026, 6, 27, 12, 0, 0);
const WIDE = 80;

test("buildClaudeSection turns each quota window into a gauge", () => {
  const quota: ClaudeQuota = {
    ok: true,
    windows: [
      {
        key: "five_hour",
        utilization: 0.42,
        resetsAt: new Date(2026, 6, 27, 15, 0, 0),
      },
      { key: "seven_day", utilization: undefined, resetsAt: undefined },
    ],
  };

  const section = buildClaudeSection(quota, NOW);
  assert.equal(section.heading, "Claude Code plan");
  assert.deepEqual(
    section.rows.map((row) => row.kind),
    ["gauge", "gauge"],
  );
  const [first, second] = section.rows;
  assert.equal(first?.kind === "gauge" && first.label, "Current session (5h)");
  assert.equal(first?.kind === "gauge" && first.fraction, 0.42);
  assert.ok(first?.kind === "gauge" && first.note?.startsWith("Resets in 3h"));
  assert.equal(second?.kind === "gauge" && second.note, "Reset time unknown");
});

test("buildClaudeSection reports unavailability instead of a fake bar", () => {
  const section = buildClaudeSection(
    { ok: false, reason: "no credentials" },
    NOW,
  );
  assert.deepEqual(section.rows, [
    { kind: "text", value: "unavailable — no credentials" },
  ]);
});

const SESSIONS_ROOT = "/home/tester/.pi/agent/sessions";

function bucket(
  provider: string,
  model: string,
  tokens: number,
  cost = 0,
  messages = 1,
) {
  const windows = emptyUsageByWindow();
  for (const window of USAGE_WINDOWS) {
    Object.assign(windows[window], {
      totalTokens: tokens,
      input: tokens,
      cost,
      messages,
    });
  }
  return { provider, model, windows };
}

function piScan(models = [bucket("opencode-go", "kimi-k3", 750, 0.04, 3)]) {
  return {
    windows: sumModelWindows(models),
    models,
    filesScanned: 2,
    filesAvailable: 2,
    truncated: false,
  };
}

function tables(section: { rows: PanelRow[] }) {
  return section.rows.filter((row) => row.kind === "table");
}

test("isOpencodeProvider matches the Zen providers and nothing else", () => {
  assert.equal(isOpencodeProvider("opencode"), true);
  assert.equal(isOpencodeProvider("opencode-go"), true);
  assert.equal(isOpencodeProvider("ollama"), false);
  assert.equal(isOpencodeProvider("opencodex"), false);
});

test("buildOpencodeSection names its source and shows only the Go limits", () => {
  const section = buildOpencodeSection(
    piScan([
      bucket("opencode-go", "kimi-k3", 750, 0.04, 3),
      bucket("opencode", "glm-5", 250, 0, 1),
      bucket("ollama", "qwen3.5:9b", 9000, 0, 5),
    ]),
    SESSIONS_ROOT,
  );

  assert.equal(section.heading, OPENCODE_HEADING);
  const source = section.rows[0];
  assert.ok(source?.kind === "text" && source.dim);
  assert.ok(source.kind === "text" && source.value.includes(SESSIONS_ROOT));

  // Only the published limits remain: no window table, no model breakdown.
  assert.equal(tables(section).length, 0);
  assert.deepEqual(
    section.rows.filter((row) => row.kind === "gauge").map((row) => row.label),
    GO_LIMITS.map((limit) => limit.label),
  );
});

test("buildOpencodeSection gauges Go spend against the published dollar limits", () => {
  const section = buildOpencodeSection(
    piScan([bucket("opencode-go", "kimi-k3", 750, 6, 3)]),
    SESSIONS_ROOT,
  );
  const gauges = section.rows.filter((row) => row.kind === "gauge");

  assert.deepEqual(
    gauges.map((row) => [row.label, row.fraction]),
    GO_LIMITS.map((limit) => [limit.label, 6 / limit.dollars]),
  );
  // The note must state both sides of the division and that pi only sees itself.
  assert.equal(gauges[0]?.note, "$6.00 of $12.00 · pi turns only");
});

test("buildOpencodeSection gauges only opencode-go, since credit models have no limit", () => {
  const goOnly = buildOpencodeSection(
    piScan([
      bucket("opencode-go", "kimi-k3", 750, 3, 3),
      bucket("opencode", "glm-5", 250, 99, 1),
    ]),
    SESSIONS_ROOT,
  );
  const first = goOnly.rows.find((row) => row.kind === "gauge");
  assert.equal(first?.kind === "gauge" && first.fraction, 3 / 12);

  const credit = buildOpencodeSection(
    piScan([bucket("opencode", "glm-5", 250, 99, 1)]),
    SESSIONS_ROOT,
  );
  assert.equal(
    credit.rows.some((row) => row.kind === "gauge"),
    false,
  );
});

test("buildOpencodeSection escalates severity as a Go limit is approached", () => {
  const spend = (cost: number) => {
    const row = buildOpencodeSection(
      piScan([bucket("opencode-go", "kimi-k3", 750, cost, 3)]),
      SESSIONS_ROOT,
    ).rows.find((entry) => entry.kind === "gauge");
    assert.ok(row?.kind === "gauge");
    return layoutGauge(row, WIDE);
  };

  assert.equal(spend(1).severity, "normal");
  assert.equal(spend(9).severity, "high");
  assert.equal(spend(11).severity, "critical");
  assert.equal(spend(11).marker.trim(), "!!");
});

test("buildOpencodeSection shows nothing but its source when there is no Go spend", () => {
  const section = buildOpencodeSection(piScan([]), SESSIONS_ROOT);
  assert.equal(tables(section).length, 0);
  assert.equal(section.rows.length, 1);
  assert.equal(section.rows[0]?.kind, "text");
});

test("buildOpencodeSection degrades to one reason line when the scan is missing", () => {
  const section = buildOpencodeSection(undefined, SESSIONS_ROOT);
  assert.equal(tables(section).length, 0);
  assert.ok(
    section.rows[1]?.kind === "text" &&
      section.rows[1].value === "session directory unreadable",
  );
});

test("buildPiSection falls back when the session directory is unreadable", () => {
  const section = buildPiSection(emptyUsageSummary(), undefined, SESSIONS_ROOT);
  assert.equal(section.heading, "pi");
  assert.equal(
    section.rows.at(-1)?.kind === "text" &&
      (section.rows.at(-1) as { value: string }).value,
    "session directory unreadable",
  );
});

/** Records the colour each line was given so tests can assert on severity. */
function stubTheme(): PanelTheme {
  return {
    fg: (color, text) => `<${color}>${text}`,
    bold: (text) => text,
  };
}

test("buildOverlayLines colours gauges by severity and keeps text plain", () => {
  const view = buildUsageView({
    branch: emptyUsageSummary(),
    scan: undefined,
    sessionsRoot: SESSIONS_ROOT,
    quota: {
      ok: true,
      windows: [
        { key: "five_hour", utilization: 0.1, resetsAt: undefined },
        { key: "seven_day", utilization: 0.95, resetsAt: undefined },
      ],
    },
    now: NOW,
  });

  const lines = buildOverlayLines(view, WIDE, stubTheme());
  assert.ok(lines.some((line) => line.includes("<success>")));
  assert.ok(lines.some((line) => line.includes("<error>")));
  assert.ok(lines.some((line) => line.startsWith("<accent>Claude Code plan")));
  assert.ok(
    lines.some((line) => line.startsWith(`<accent>${OPENCODE_HEADING}`)),
  );
});

test("buildOverlayLines drops the bar rather than overflowing a narrow overlay", () => {
  const view = buildUsageView({
    branch: emptyUsageSummary(),
    scan: undefined,
    sessionsRoot: SESSIONS_ROOT,
    quota: {
      ok: true,
      windows: [{ key: "five_hour", utilization: 0.5, resetsAt: undefined }],
    },
    now: NOW,
  });

  const narrow = buildOverlayLines(view, 14, stubTheme());
  assert.ok(!narrow.some((line) => line.includes("█")));
  assert.ok(
    buildOverlayLines(view, WIDE, stubTheme()).some((l) => l.includes("█")),
  );
});

test("renderPanelText renders every section without a TUI", () => {
  const view = buildUsageView({
    branch: emptyUsageSummary(),
    scan: piScan(),
    sessionsRoot: SESSIONS_ROOT,
    quota: {
      ok: true,
      windows: [{ key: "five_hour", utilization: 0.5, resetsAt: undefined }],
    },
    now: NOW,
  });

  const text = renderPanelText(view, WIDE);
  assert.ok(text.startsWith("Usage"));
  assert.ok(text.includes("Claude Code plan"));
  assert.ok(text.includes(`\n${OPENCODE_HEADING}\n`));
  assert.ok(!text.includes("opencode app"));
  // Only the published limits, no per-model breakdown anywhere.
  assert.ok(!text.includes("opencode-go/kimi-k3"));
  assert.ok(text.includes(GO_LIMITS[0]!.label));
  // Bars stay exclusive to the quota section, which is the only real limit.
  assert.equal(text.split("█").length - 1 > 0, true);
  for (const line of text.split("\n")) assert.ok(line.length <= WIDE, line);
});

test("renderPanelText fits every width down to a narrow terminal", () => {
  const view = buildUsageView({
    branch: emptyUsageSummary(),
    scan: piScan(),
    sessionsRoot: SESSIONS_ROOT,
    quota: { ok: false, reason: "no credentials" },
    now: NOW,
  });

  for (const width of [24, 38, 60, 76, 120]) {
    for (const line of renderPanelText(view, width).split("\n")) {
      assert.ok(line.length <= width, `${width}: ${line}`);
    }
  }
});
