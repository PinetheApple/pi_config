/** TUI rendering and delivery for Report values. */

import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  asReport,
  REPORT_ENTRY_TYPE,
  renderReportText,
  type Report,
} from "./report.ts";

function buildCard(value: Report, theme: Theme) {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(
      theme.fg("accent", "✦ ") +
        theme.fg("customMessageLabel", theme.bold(value.title)),
      0,
      0,
    ),
  );

  for (const section of value.sections) {
    if (section.heading) {
      box.addChild(
        new Text(theme.bold(theme.fg("accent", section.heading)), 0, 1),
      );
    }
    for (const line of section.lines) {
      box.addChild(new Text(theme.fg("customMessageText", line), 0, 0));
    }
  }

  if (value.footer) box.addChild(new Text(theme.fg("dim", value.footer), 0, 1));
  return box;
}

export function registerReportRenderer(pi: ExtensionAPI) {
  pi.registerEntryRenderer(REPORT_ENTRY_TYPE, (entry, _options, theme) => {
    const value = asReport(entry.data);
    if (!value)
      return new Text(theme.fg("warning", "Report unavailable"), 0, 0);
    return buildCard(value, theme);
  });
}

/**
 * Show a report. In the TUI it becomes a persisted custom entry (never sent to
 * the LLM); everywhere else it degrades to a plain-text notification.
 */
export function present(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  value: Report,
) {
  if (ctx.mode === "tui") {
    pi.appendEntry(REPORT_ENTRY_TYPE, value);
    return;
  }
  ctx.ui.notify(renderReportText(value), "info");
}
