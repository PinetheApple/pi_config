/** `/help` — list the slash commands ExtensionAPI can actually see. */

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { pad } from "./format.ts";
import { report, type Report, type ReportSection } from "./report.ts";

const GROUP_HEADINGS: Record<SlashCommandInfo["source"], string> = {
  extension: "Extensions",
  prompt: "Prompts",
  skill: "Skills",
};

const GROUP_ORDER: SlashCommandInfo["source"][] = [
  "extension",
  "prompt",
  "skill",
];

/** Skill descriptions are prompt-sized; /help is an index, so keep one line. */
const MAX_NAME_WIDTH = 26;
const MAX_DESCRIPTION_LENGTH = 88;

export function summarizeDescription(description: string | undefined) {
  if (!description) return "";
  const single = description.replace(/\s+/g, " ").trim();
  return single.length <= MAX_DESCRIPTION_LENGTH
    ? single
    : `${single.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

export function buildHelpReport(commands: readonly SlashCommandInfo[]): Report {
  const nameWidth = Math.min(
    MAX_NAME_WIDTH,
    commands.reduce(
      (widest, command) => Math.max(widest, command.name.length + 2),
      10,
    ),
  );

  const sections: ReportSection[] = GROUP_ORDER.flatMap((source) => {
    const group = commands
      .filter((command) => command.source === source)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (group.length === 0) return [];
    return [
      {
        heading: `${GROUP_HEADINGS[source]} (${group.length})`,
        lines: group.map((command) =>
          `${pad(`/${command.name}`, nameWidth)}${summarizeDescription(command.description)}`.trimEnd(),
        ),
      },
    ];
  });

  if (sections.length === 0) {
    sections.push({
      lines: ["No extension, prompt, or skill commands registered."],
    });
  }

  return report(
    "Available commands",
    sections,
    "Built-in interactive commands (/model, /settings, /tree, /resume, …) are handled by the interactive layer and are not exposed to extensions, so they are not listed here. Type / in the editor to see them, and /hotkeys for keyboard shortcuts.",
  );
}
