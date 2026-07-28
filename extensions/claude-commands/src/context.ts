/** `/context` — context-window breakdown for the active branch. */

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type {
  ContextUsage,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { formatBar, formatPercent, formatTokens, pad } from "./format.ts";
import { report } from "./report.ts";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LABEL_WIDTH = 22;

export interface ContextInput {
  usage: ContextUsage | undefined;
  modelLabel: string;
  fallbackContextWindow: number | undefined;
  systemPrompt: string;
  contextEntries: readonly SessionEntry[];
}

function row(label: string, value: string) {
  return `${pad(label, LABEL_WIDTH)}${value}`;
}

/**
 * Measured vs estimated is kept explicit: `usage.tokens` comes from the last
 * real provider usage report, everything in the breakdown is a chars/4
 * approximation of the same text pi itself uses for compaction thresholds.
 */
export function buildContextReport(input: ContextInput) {
  const window = input.usage?.contextWindow ?? input.fallbackContextWindow ?? 0;
  const tokens = input.usage?.tokens ?? null;
  const fraction = window > 0 && tokens !== null ? tokens / window : null;

  const overview = [
    row("Model", input.modelLabel),
    row(
      "Context window",
      window > 0 ? `${formatTokens(window)} tokens` : "unknown",
    ),
    row(
      "Used",
      tokens === null
        ? "unknown (no provider usage since the last compaction)"
        : `${formatTokens(tokens)} tokens`,
    ),
    row(
      "Remaining",
      tokens === null || window <= 0
        ? "unknown"
        : `${formatTokens(Math.max(0, window - tokens))} tokens`,
    ),
    row("Fill", `${formatBar(fraction)} ${formatPercent(fraction)}`),
  ];

  const systemPromptTokens = Math.ceil(
    input.systemPrompt.length / CHARS_PER_ESTIMATED_TOKEN,
  );

  let messageEntries = 0;
  let messageTokens = 0;
  for (const entry of input.contextEntries) {
    if (entry.type !== "message") continue;
    messageEntries += 1;
    messageTokens += estimateTokens(entry.message);
  }

  const breakdown = [
    row(
      "System prompt",
      `~${formatTokens(systemPromptTokens)} tokens (estimate)`,
    ),
    row(
      "Conversation",
      `~${formatTokens(messageTokens)} tokens (estimate, ${messageEntries} messages)`,
    ),
    row("Context entries", `${input.contextEntries.length} (exact)`),
  ];

  return report(
    "Context usage",
    [
      { heading: "Overview (measured)", lines: overview },
      { heading: "Breakdown", lines: breakdown },
    ],
    "Overview figures come from the provider's last reported usage. Breakdown figures are ~4-chars-per-token estimates over the same text and do not add up to the measured total (tool results, cached blocks and provider overhead are not attributed).",
  );
}
