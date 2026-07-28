/** Aggregation of pi-ai `Usage` records across session entries. */

import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface UsageSummary {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
}

export function emptyUsageSummary(): UsageSummary {
  return {
    messages: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function finite(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function addUsage(summary: UsageSummary, usage: Usage) {
  summary.messages += 1;
  summary.input += finite(usage.input);
  summary.output += finite(usage.output);
  summary.cacheRead += finite(usage.cacheRead);
  summary.cacheWrite += finite(usage.cacheWrite);
  summary.reasoning += finite(usage.reasoning);
  summary.totalTokens += finite(usage.totalTokens);
  summary.cost += finite(usage.cost?.total);
}

export function mergeUsage(target: UsageSummary, source: UsageSummary) {
  target.messages += source.messages;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
}

/**
 * Sum assistant-message usage over session entries. `accept` filters entries
 * (used for time-window bucketing) before their usage is counted.
 */
export function sumEntryUsage(
  entries: readonly SessionEntry[],
  accept?: (entry: SessionEntry) => boolean,
) {
  const summary = emptyUsageSummary();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    if (accept && !accept(entry)) continue;
    addUsage(summary, entry.message.usage);
  }
  return summary;
}
