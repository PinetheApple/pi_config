/**
 * Report is the single output model for every claude-commands command.
 *
 * It is persisted verbatim as the `data` of a `claude-commands-report` custom
 * entry, so the shape below is a compatibility surface: renderers must keep
 * reading older entries that only carry `title` and `sections`.
 */

export interface ReportSection {
  heading?: string;
  lines: string[];
}

export interface Report {
  title: string;
  sections: ReportSection[];
  footer?: string;
}

export const REPORT_ENTRY_TYPE = "claude-commands-report";

export function report(
  title: string,
  sections: ReportSection[],
  footer?: string,
): Report {
  return footer === undefined
    ? { title, sections }
    : { title, sections, footer };
}

/** Plain-text rendering, used outside the TUI and by tests. */
export function renderReportText(value: Report) {
  const lines: string[] = [value.title];
  for (const section of value.sections) {
    lines.push("");
    if (section.heading) lines.push(section.heading);
    lines.push(...section.lines);
  }
  if (value.footer) {
    lines.push("");
    lines.push(value.footer);
  }
  return lines.join("\n");
}

/** Narrow unknown persisted entry data back to a renderable Report. */
export function asReport(data: unknown): Report | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidate = data as Partial<Report>;
  if (typeof candidate.title !== "string") return undefined;
  if (!Array.isArray(candidate.sections)) return undefined;

  const sections: ReportSection[] = [];
  for (const section of candidate.sections) {
    if (!section || typeof section !== "object") continue;
    const lines = Array.isArray(section.lines)
      ? section.lines.filter((line): line is string => typeof line === "string")
      : [];
    sections.push(
      typeof section.heading === "string"
        ? { heading: section.heading, lines }
        : { lines },
    );
  }

  return {
    title: candidate.title,
    sections,
    ...(typeof candidate.footer === "string"
      ? { footer: candidate.footer }
      : {}),
  };
}
