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
import type { OpencodeRead } from "./src/usage/opencode.ts";
import { buildOverlayLines, type UsageTheme } from "./src/usage/overlay.ts";
import {
  buildClaudeSection,
  buildOpencodeSection,
  buildPiSection,
  buildUsageView,
  gaugeLines,
  layoutGauge,
  OPENCODE_QUOTA_NOTE,
  renderUsageText,
  type GaugeRow,
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

function opencodeRead(): OpencodeRead {
  const usage = (tokens: number) => ({
    ...emptyUsageSummary(),
    totalTokens: tokens,
    input: tokens,
  });
  return {
    ok: true,
    totals: {
      windows: {
        all: { usage: usage(1000), sessions: 3 },
        today: { usage: usage(100), sessions: 1 },
        "7d": { usage: usage(400), sessions: 2 },
        "30d": { usage: usage(900), sessions: 3 },
      },
      byModel: [
        {
          provider: "opencode-go",
          model: "kimi-k2.6",
          usage: usage(750),
          sessions: 2,
        },
        {
          provider: "opencode",
          model: "glm-5",
          usage: usage(250),
          sessions: 1,
        },
      ],
      rows: 3,
    },
  };
}

test("buildOpencodeSection states quota is unavailable and bars model share", () => {
  const section = buildOpencodeSection(opencodeRead());
  const quotaRow = section.rows[0];
  assert.equal(quotaRow?.kind === "text" && quotaRow.label, "Plan quota");
  assert.equal(
    quotaRow?.kind === "text" && quotaRow.value,
    OPENCODE_QUOTA_NOTE,
  );

  const gauges = section.rows.filter((row) => row.kind === "gauge");
  assert.equal(gauges.length, 2);
  assert.equal(gauges[0]?.kind === "gauge" && gauges[0].fraction, 0.75);
  assert.equal(gauges[1]?.kind === "gauge" && gauges[1].fraction, 0.25);
  assert.equal(
    gauges[0]?.kind === "gauge" && gauges[0].label,
    "opencode-go/kimi-k2.6",
  );
});

test("buildOpencodeSection keeps the quota row when the database is unreadable", () => {
  const section = buildOpencodeSection({ ok: false, reason: "no such file" });
  assert.equal(section.rows.length, 2);
  assert.equal(
    section.rows[0]?.kind === "text" && section.rows[0].label,
    "Plan quota",
  );
  assert.ok(
    section.rows[1]?.kind === "text" &&
      section.rows[1].value.includes("no such file"),
  );
});

test("buildPiSection falls back when the session directory is unreadable", () => {
  const section = buildPiSection(emptyUsageSummary(), undefined);
  assert.equal(section.heading, "pi");
  assert.equal(section.rows.length, 2);
  assert.equal(
    section.rows[1]?.kind === "text" && section.rows[1].value,
    "session directory unreadable",
  );
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
    opencode: { ok: false, reason: "no such file" },
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
  assert.ok(lines.some((line) => line.includes(OPENCODE_QUOTA_NOTE)));
});

test("buildOverlayLines drops the bar rather than overflowing a narrow overlay", () => {
  const view = buildUsageView({
    branch: emptyUsageSummary(),
    scan: undefined,
    opencode: { ok: false, reason: "no such file" },
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
    scan: undefined,
    opencode: opencodeRead(),
    quota: { ok: false, reason: "no credentials" },
    now: NOW,
  });

  const text = renderUsageText(view, WIDE);
  assert.ok(text.startsWith("Usage"));
  assert.ok(text.includes("Claude Code plan"));
  assert.ok(text.includes("unavailable — no credentials"));
  assert.ok(text.includes(OPENCODE_QUOTA_NOTE));
  assert.ok(text.includes("opencode-go/kimi-k2.6"));
  assert.ok(text.includes("█"));
  for (const line of text.split("\n")) assert.ok(line.length <= WIDE, line);
});
