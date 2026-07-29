/**
 * Pure attribution of the context window: session entries and prompt inputs in,
 * measured categories out.
 *
 * Only two numbers in `/context` are measured: `usage.tokens` (the provider's
 * own count for the last request) and the context window. Everything else here
 * is a chars/4 estimate over exactly the text pi itself measures for its
 * compaction thresholds, so the categories are comparable to each other but
 * never to the provider's total. Categories are derived from real, separable
 * text — nothing is attributed that cannot be pointed at in the session file.
 */

import type {
  ContextUsage,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  ESTIMATED_IMAGE_CHARS,
  NamedBuckets,
  tallyEntries,
  tokensOf,
  type ConversationTally,
  type NamedTotal,
} from "./tally.ts";

export type CategoryGroup = "prompt" | "conversation";

export type { NamedTotal };

export interface ContextCategory {
  key: string;
  label: string;
  group: CategoryGroup;
  chars: number;
  tokens: number;
  /** What the number is made of, in the user's terms. */
  detail: string;
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ContextFile {
  path: string;
  content: string;
}

export interface ContextSources {
  usage: ContextUsage | undefined;
  modelLabel: string;
  fallbackContextWindow: number | undefined;
  systemPrompt: string;
  contextFiles: readonly ContextFile[];
  /** Rendered skills section, exactly as the system prompt would carry it. */
  skillsPrompt: string;
  skillCount: number;
  /** Active tool schemas, or undefined when the runtime does not expose them. */
  tools: readonly ToolSchema[] | undefined;
  entries: readonly SessionEntry[];
}

export interface ContextBreakdown {
  modelLabel: string;
  /** 0 when neither the provider nor the model declares a window. */
  window: number;
  measuredTokens: number | null;
  estimatedTotal: number;
  /** Largest first. Empty categories are dropped. */
  categories: ContextCategory[];
  /** Window minus what is measured or, failing that, estimated. */
  freeTokens: number | null;
  freeIsMeasured: boolean;
  toolResults: NamedTotal[];
  toolSchemas: NamedTotal[];
  instructionFiles: NamedTotal[];
  toolsAvailable: boolean;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function category(
  key: string,
  label: string,
  group: CategoryGroup,
  chars: number,
  detail: string,
): ContextCategory {
  return { key, label, group, chars, tokens: tokensOf(chars), detail };
}

function promptCategories(sources: ContextSources) {
  const files: NamedBuckets = new NamedBuckets();
  for (const file of sources.contextFiles) {
    // Only attribute what is demonstrably in the prompt pi is sending.
    if (!sources.systemPrompt.includes(file.content)) continue;
    files.add(file.path, file.content.length);
  }

  const skillsChars = sources.systemPrompt.includes(sources.skillsPrompt)
    ? sources.skillsPrompt.length
    : 0;

  const toolChars = (sources.tools ?? []).reduce(
    (total, tool) =>
      total +
      tool.name.length +
      (tool.description?.length ?? 0) +
      JSON.stringify(tool.parameters ?? {}).length,
    0,
  );

  const base = Math.max(
    0,
    sources.systemPrompt.length - files.total.chars - skillsChars,
  );

  const categories = [
    category(
      "system",
      "System prompt",
      "prompt",
      base,
      "pi base prompt, tool list and guidelines",
    ),
    category(
      "instructions",
      "Project instructions",
      "prompt",
      files.total.chars,
      `${plural(files.total.count, "file")} (CLAUDE.md / AGENTS.md style)`,
    ),
    category(
      "skills",
      "Skills catalog",
      "prompt",
      skillsChars,
      `${plural(sources.skillCount, "skill")} · names and descriptions only`,
    ),
  ];

  if (sources.tools) {
    categories.push(
      category(
        "tools",
        "Tool schemas",
        "prompt",
        toolChars,
        `${plural(sources.tools.length, "active tool")} · name, description, JSON schema`,
      ),
    );
  }

  return { categories, files };
}

function conversationCategories(tally: ConversationTally) {
  const results = tally.toolResults.total;
  return [
    category(
      "user",
      "User messages",
      "conversation",
      tally.user.chars,
      plural(tally.user.count, "message"),
    ),
    category(
      "assistant",
      "Assistant replies",
      "conversation",
      tally.assistantText.chars,
      plural(tally.assistantText.count, "message"),
    ),
    category(
      "reasoning",
      "Assistant reasoning",
      "conversation",
      tally.reasoning.chars,
      `${plural(tally.reasoning.count, "message")} with thinking blocks`,
    ),
    category(
      "toolCalls",
      "Tool calls",
      "conversation",
      tally.toolCalls.chars,
      `${plural(tally.toolCalls.count, "call")} · arguments only`,
    ),
    category(
      "toolResults",
      "Tool results",
      "conversation",
      results.chars,
      plural(results.count, "result"),
    ),
    category(
      "bash",
      "Terminal commands",
      "conversation",
      tally.bash.chars,
      `${plural(tally.bash.count, "run")} · ! commands and their output`,
    ),
    category(
      "custom",
      "Extension messages",
      "conversation",
      tally.custom.chars,
      plural(tally.custom.count, "message"),
    ),
    category(
      "summaries",
      "Summaries",
      "conversation",
      tally.summaries.chars,
      `${plural(tally.summaries.count, "summary", "summaries")} · compaction and branch`,
    ),
    category(
      "images",
      "Images",
      "conversation",
      tally.images.count * ESTIMATED_IMAGE_CHARS,
      `${plural(tally.images.count, "image")} · flat ${ESTIMATED_IMAGE_CHARS.toLocaleString("en-US")}-char allowance each`,
    ),
  ];
}

export function buildContextBreakdown(
  sources: ContextSources,
): ContextBreakdown {
  const window =
    sources.usage?.contextWindow ?? sources.fallbackContextWindow ?? 0;
  const measuredTokens = sources.usage?.tokens ?? null;

  const tally = tallyEntries(sources.entries);

  const prompt = promptCategories(sources);
  const categories = [
    ...prompt.categories,
    ...conversationCategories(tally),
  ].filter((entry) => entry.chars > 0);
  categories.sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key));

  const estimatedTotal = tokensOf(
    categories.reduce((total, entry) => total + entry.chars, 0),
  );
  const accounted = measuredTokens ?? estimatedTotal;

  return {
    modelLabel: sources.modelLabel,
    window,
    measuredTokens,
    estimatedTotal,
    categories,
    freeTokens: window > 0 ? Math.max(0, window - accounted) : null,
    freeIsMeasured: measuredTokens !== null,
    toolResults: tally.toolResults.totals(),
    toolSchemas: (sources.tools ?? [])
      .map((tool) => ({
        name: tool.name,
        tokens: tokensOf(
          tool.name.length +
            (tool.description?.length ?? 0) +
            JSON.stringify(tool.parameters ?? {}).length,
        ),
        count: 1,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
    instructionFiles: prompt.files.totals(),
    toolsAvailable: sources.tools !== undefined,
  };
}
