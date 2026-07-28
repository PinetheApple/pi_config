/** Dismissable /usage overlay. Nothing is written to the transcript. */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Severity } from "./bar.ts";
import { layoutTable } from "./table.ts";
import {
  gaugeLines,
  layoutGauge,
  textRowLine,
  type UsageRow,
  type UsageView,
} from "./view.ts";

const SCROLL_STEP = 3;
const BORDER_COLUMNS = 2;
const MIN_BODY_WIDTH = 20;
const MIN_BODY_HEIGHT = 8;
const BODY_HEIGHT_RATIO = 0.8;
const CHROME_ROWS = 2;
const HINTS =
  "j/k or ↑/↓ scroll · ctrl-d/u page · g/G top/bottom · esc/q close";

/** The slice of Theme the usage body needs, so it can be stubbed in tests. */
export type UsageTheme = Pick<Theme, "fg" | "bold">;

const SEVERITY_COLORS: Record<Severity, Parameters<Theme["fg"]>[0]> = {
  unknown: "muted",
  normal: "success",
  high: "warning",
  critical: "error",
};

function styleRow(row: UsageRow, width: number, theme: UsageTheme) {
  if (row.kind === "text") {
    return wrapTextWithAnsi(textRowLine(row), width).map((line) =>
      theme.fg(row.dim ? "dim" : "text", line),
    );
  }

  if (row.kind === "table") {
    const table = layoutTable(row.spec, width);
    return [
      theme.fg("dim", table.head),
      ...table.rows.map((line) => theme.fg("text", line)),
    ];
  }

  const layout = layoutGauge(row, width);
  const [label, meter, note] = gaugeLines(layout);
  const color = SEVERITY_COLORS[layout.severity];
  const lines = [
    theme.fg("text", truncateToWidth(label ?? "", width, "…")),
    theme.fg(color, truncateToWidth(meter ?? "", width, "")),
  ];
  if (note) lines.push(theme.fg("dim", truncateToWidth(note, width, "…")));
  return lines;
}

export function buildOverlayLines(
  view: UsageView,
  width: number,
  theme: UsageTheme,
) {
  const lines: string[] = [];
  for (const section of view.sections) {
    if (lines.length > 0) lines.push("");
    lines.push(theme.bold(theme.fg("accent", section.heading)));
    for (const row of section.rows) lines.push(...styleRow(row, width, theme));
  }
  lines.push("");
  for (const line of wrapTextWithAnsi(view.footer, width)) {
    lines.push(theme.fg("dim", line));
  }
  return lines;
}

function border(theme: Theme, width: number, label: string, top: boolean) {
  const left = top ? "┌" : "└";
  const right = top ? "┐" : "┘";
  const text = `─ ${label} `;
  const remaining = Math.max(0, width - visibleWidth(text) - BORDER_COLUMNS);
  return theme.fg(
    "borderAccent",
    truncateToWidth(
      `${left}${text}${"─".repeat(remaining)}${right}`,
      width,
      "",
    ),
  );
}

export async function showUsageOverlay(ctx: ExtensionContext, view: UsageView) {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let offset = 0;
      let viewport = MIN_BODY_HEIGHT;
      let total = 0;

      function bodyHeight() {
        return Math.max(
          MIN_BODY_HEIGHT,
          Math.floor(tui.terminal.rows * BODY_HEIGHT_RATIO) - CHROME_ROWS,
        );
      }

      function scrollBy(amount: number) {
        const max = Math.max(0, total - viewport);
        offset = Math.max(0, Math.min(max, offset + amount));
        tui.requestRender();
      }

      function handleInput(data: string) {
        if (matchesKey(data, Key.escape) || data === "q") {
          done(undefined);
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") scrollBy(SCROLL_STEP);
        else if (matchesKey(data, Key.up) || data === "k")
          scrollBy(-SCROLL_STEP);
        else if (matchesKey(data, Key.ctrl("d"))) scrollBy(viewport);
        else if (matchesKey(data, Key.ctrl("u"))) scrollBy(-viewport);
        else if (matchesKey(data, Key.home) || data === "g") scrollBy(-total);
        else if (matchesKey(data, Key.end) || data === "G") scrollBy(total);
      }

      function render(width: number) {
        const bodyWidth = Math.max(MIN_BODY_WIDTH, width - BORDER_COLUMNS);
        const content = buildOverlayLines(view, bodyWidth, theme);
        const height = bodyHeight();

        total = content.length;
        viewport = height;
        offset = Math.min(offset, Math.max(0, total - height));

        const title =
          total > height
            ? `${view.title} · ${offset + 1}-${Math.min(total, offset + height)}/${total}`
            : view.title;
        const lines = [border(theme, width, title, true)];

        for (let index = 0; index < height; index += 1) {
          const line = content[offset + index] ?? "";
          const padding = " ".repeat(
            Math.max(0, bodyWidth - visibleWidth(line)),
          );
          const edge = theme.fg("borderMuted", "│");
          lines.push(`${edge}${line}${padding}${edge}`);
        }

        lines.push(border(theme, width, HINTS, false));
        return lines;
      }

      return { handleInput, invalidate() {}, render };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        margin: 1,
        maxHeight: "90%",
        minWidth: 40,
        width: "90%",
      },
    },
  );
}
