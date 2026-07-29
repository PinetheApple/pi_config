import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  BAR_MAX_WIDTH,
  BAR_MIN_WIDTH,
  barWidth,
  CRITICAL_THRESHOLD,
  HIGH_THRESHOLD,
  renderBar,
  severityOf,
} from "./src/panel/bar.ts";
import {
  gaugeLines,
  layoutGauge,
  renderPanelText,
} from "./src/panel/layout.ts";
import { buildOverlayLines } from "./src/panel/overlay.ts";
import type { GaugeRow, PanelView } from "./src/panel/rows.ts";
import { layoutTable } from "./src/panel/table.ts";

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

test("layoutGauge takes its severity from severityFraction when given one", () => {
  const full = layoutGauge(
    { kind: "gauge", label: "Free space", fraction: 1, severityFraction: 0 },
    WIDE,
  );
  assert.equal(full.severity, "normal");
  assert.equal(full.percent.trim(), "100%");

  const empty = layoutGauge(
    {
      kind: "gauge",
      label: "Free space",
      fraction: 0.02,
      severityFraction: 0.98,
    },
    WIDE,
  );
  assert.equal(empty.severity, "critical");
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

test("headings are clipped, not allowed to overflow a narrow panel", () => {
  const view: PanelView = {
    title: "A title far wider than the panel it is rendered into",
    sections: [
      {
        heading: "A heading far wider than the panel it is rendered into",
        rows: [{ kind: "text", value: "x" }],
      },
    ],
    footer: "f",
  };

  for (const line of renderPanelText(view, 24).split("\n")) {
    assert.ok(line.length <= 24, line);
  }
  for (const line of buildOverlayLines(view, 24, {
    fg: (_color, text) => text,
    bold: (text) => text,
  })) {
    assert.ok(visibleWidth(line) <= 24, line);
  }
});

test("renderPanelText renders each row kind and respects the width", () => {
  const view: PanelView = {
    title: "Panel",
    sections: [
      {
        heading: "Section",
        rows: [
          { kind: "text", label: "Label", value: "value" },
          gauge(0.5, "note"),
          {
            kind: "table",
            spec: { head: ["a", "b"], rows: [["x", "1"]], minColumns: 2 },
          },
        ],
      },
    ],
    footer:
      "A footer long enough to need wrapping at the narrower widths used here.",
  };

  const text = renderPanelText(view, WIDE);
  assert.ok(text.startsWith("Panel"));
  assert.ok(text.includes("Section"));
  assert.ok(text.includes("value"));
  assert.ok(text.includes("█"));
  for (const width of [24, 40, WIDE]) {
    for (const line of renderPanelText(view, width).split("\n")) {
      assert.ok(line.length <= width, `${width}: ${line}`);
    }
  }
});
