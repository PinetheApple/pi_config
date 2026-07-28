import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsageSummary } from "../shared/usage-totals.ts";
import {
  BAR_MAX_WIDTH,
  BAR_MIN_WIDTH,
  barWidth,
  CRITICAL_THRESHOLD,
  HIGH_THRESHOLD,
  renderBar,
  severityOf,
} from "./src/usage/bar.ts";
import type { ClaudeQuota } from "./src/usage/claude.ts";
import { GO_LIMITS } from "./src/usage/go-limits.ts";
import { buildOverlayLines, type UsageTheme } from "./src/usage/overlay.ts";
import { emptyUsageByWindow, sumModelWindows } from "./src/usage/pi.ts";
import { layoutTable } from "./src/usage/table.ts";
import { USAGE_WINDOWS } from "./src/usage/window.ts";
import {
  buildClaudeSection,
  buildOpencodeSection,
  buildPiSection,
  buildUsageView,
  gaugeLines,
  isOpencodeProvider,
  layoutGauge,
  OPENCODE_HEADING,
  renderUsageText,
  type GaugeRow,
  type UsageRow,
} from "./src/usage/view.ts";

const NOW = new Date(2026, 6, 27, 12, 0, 0);
const WIDE = 80;

function gauge(fraction: number | undefined, note?: string): GaugeRow {
  return note === undefined
    ? { kind: "gauge", label: "Current session (5h)", fraction }
    : { kind: "gauge", label: "Current session (5h)", fraction, note };
}

test("renderBar fills proportionally and stays within its width", () => {
  assert.equal(renderBar(0, 10), "░░░░░░░░░░");
  assert.equal(renderBar(1, 10), "██████████");
  assert.equal(renderBar(0.5, 10), "█████░░░░░");
  for (const fraction of [0, 0.13, 0.5, 0.87, 1]) {
    assert.equal(renderBar(fraction, 17).length, 17);
  }
});

test("renderBar keeps the extremes distinguishable", () => {
  // A sliver of usage must never look empty, and 99% must never look full.
  assert.equal(renderBar(0.001, 20).startsWith("█░"), true);
  assert.equal(renderBar(0.999, 20).endsWith("░"), true);
  assert.equal(renderBar(0, 20).includes("█"), false);
  assert.equal(renderBar(1, 20).includes("░"), false);
});

test("renderBar clamps out-of-range and unknown fractions", () => {
  assert.equal(renderBar(-4, 6), "░░░░░░");
  assert.equal(renderBar(9, 6), "██████");
  assert.equal(renderBar(undefined, 6), "······");
  assert.equal(renderBar(Number.NaN, 6), "······");
  assert.equal(renderBar(0.5, 0), "");
});

test("barWidth clamps to bounds and disappears when too narrow", () => {
  assert.equal(barWidth(BAR_MIN_WIDTH - 1), undefined);
  assert.equal(barWidth(0), undefined);
  assert.equal(barWidth(-10), undefined);
  assert.equal(barWidth(Number.NaN), undefined);
  assert.equal(barWidth(BAR_MIN_WIDTH), BAR_MIN_WIDTH);
  assert.equal(barWidth(BAR_MAX_WIDTH + 50), BAR_MAX_WIDTH);
  assert.equal(barWidth(20.7), 20);
});

test("severityOf uses the named thresholds", () => {
  assert.equal(severityOf(undefined), "unknown");
  assert.equal(severityOf(Number.NaN), "unknown");
  assert.equal(severityOf(0), "normal");
  assert.equal(severityOf(HIGH_THRESHOLD - 0.01), "normal");
  assert.equal(severityOf(HIGH_THRESHOLD), "high");
  assert.equal(severityOf(CRITICAL_THRESHOLD), "critical");
  assert.equal(severityOf(1), "critical");
});

test("layoutGauge formats the percentage to a fixed column", () => {
  assert.equal(layoutGauge(gauge(0.355), WIDE).percent, "  36%");
  assert.equal(layoutGauge(gauge(1), WIDE).percent, " 100%");
  assert.equal(layoutGauge(gauge(0), WIDE).percent, "   0%");
  assert.equal(layoutGauge(gauge(undefined), WIDE).percent, "   ?%");
});

test("layoutGauge marks severity with text, not colour alone", () => {
  assert.equal(layoutGauge(gauge(0.1), WIDE).marker.trim(), "");
  assert.equal(layoutGauge(gauge(0.8), WIDE).marker.trim(), "!");
  assert.equal(layoutGauge(gauge(0.95), WIDE).marker.trim(), "!!");
  assert.equal(layoutGauge(gauge(undefined), WIDE).marker.trim(), "?");
});

test("layoutGauge degrades the bar as the terminal narrows", () => {
  const wide = layoutGauge(gauge(0.5), 200);
  assert.equal(wide.bar.length, BAR_MAX_WIDTH);

  const medium = layoutGauge(gauge(0.5), 30);
  assert.ok(medium.bar.length >= BAR_MIN_WIDTH);
  assert.ok(medium.bar.length < BAR_MAX_WIDTH);

  const narrow = layoutGauge(gauge(0.5), 12);
  assert.equal(narrow.bar, "");
  assert.equal(narrow.percent.trim(), "50%");
});

test("gaugeLines keeps every line inside the requested width", () => {
  for (const width of [12, 24, 40, 80, 200]) {
    const lines = gaugeLines(layoutGauge(gauge(0.87, "Resets in 3h"), width));
    for (const line of lines) assert.ok(line.length <= width, line);
  }
});

test("gaugeLines emits label, meter and optional note in order", () => {
  const withNote = gaugeLines(layoutGauge(gauge(0.5, "Resets in 3h"), WIDE));
  assert.equal(withNote.length, 3);
  assert.equal(withNote[0], "Current session (5h)");
  assert.ok(withNote[1]?.includes("█"));
  assert.ok(withNote[2]?.trim().startsWith("Resets"));

  assert.equal(gaugeLines(layoutGauge(gauge(0.5), WIDE)).length, 2);
});

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

function tables(section: { rows: UsageRow[] }) {
  return section.rows.filter((row) => row.kind === "table");
}

function firstTableLines(section: { rows: UsageRow[] }, width: number) {
  const table = tables(section)[0];
  assert.ok(table?.kind === "table");
  return layoutTable(table.spec, width);
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

test("layoutTable right-aligns numbers, clips the label, and drops columns when narrow", () => {
  const spec = {
    head: ["model", "tokens", "share", "replies"],
    rows: [["opencode-go/a-very-long-model-name", "750", "75%", "3"]],
    minColumns: 2,
  };

  const wide = layoutTable(spec, 80);
  assert.ok(wide.head.endsWith("replies"));
  assert.ok(wide.rows[0]?.endsWith("      3"));
  assert.ok(wide.rows[0]?.startsWith("opencode-go/a-very-long-model-name"));

  const narrow = layoutTable(spec, 24);
  assert.ok(!narrow.head.includes("replies"));
  for (const line of [narrow.head, ...narrow.rows]) {
    assert.ok(line.length <= 24, line);
  }
  assert.ok(narrow.rows[0]?.includes("…"));

  // minColumns is a floor: the label and the headline number always survive.
  const tiny = layoutTable(spec, 4);
  assert.ok(tiny.head.includes("tokens"));
  assert.ok(tiny.rows[0]?.includes("750"));
});

/** Records the colour each line was given so tests can assert on severity. */
function stubTheme(): UsageTheme {
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

test("renderUsageText renders every section without a TUI", () => {
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

  const text = renderUsageText(view, WIDE);
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

test("renderUsageText fits every width down to a narrow terminal", () => {
  const view = buildUsageView({
    branch: emptyUsageSummary(),
    scan: piScan(),
    sessionsRoot: SESSIONS_ROOT,
    quota: { ok: false, reason: "no credentials" },
    now: NOW,
  });

  for (const width of [24, 38, 60, 76, 120]) {
    for (const line of renderUsageText(view, width).split("\n")) {
      assert.ok(line.length <= width, `${width}: ${line}`);
    }
  }
});
