/**
 * Reading the conversation half of the context window: session entries in,
 * per-category character counts out.
 *
 * This module also owns `tokensOf()`, the single chars/4 estimator every
 * category is expressed in.
 *
 * The counts mirror pi's own `estimateTokens()` over the messages
 * `sessionEntryToContextMessages()` would hand the provider, except that images
 * are pulled into their own bucket instead of inflating the text categories.
 */

import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** pi's own per-image allowance; mirrors estimateTokens() in compaction.ts. */
export const ESTIMATED_IMAGE_CHARS = 4800;
const CHARS_PER_ESTIMATED_TOKEN = 4;

/** The one estimator in `/context`, shared by every category. */
export function tokensOf(chars: number) {
  return Math.ceil(chars / CHARS_PER_ESTIMATED_TOKEN);
}

/** A named slice of a category: one tool, one instruction file. */
export interface NamedTotal {
  name: string;
  tokens: number;
  count: number;
}

/**
 * The structural slice of an in-context message this file reads. `AgentMessage`
 * itself is declared in a package pi does not vendor separately, so the shape
 * documented in docs/session-format.md is restated here rather than inferred.
 */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: unknown;
}

interface ContextMessage {
  role: string;
  content?: string | ContentBlock[];
  summary?: string;
  command?: string;
  output?: string;
  toolName?: string;
  excludeFromContext?: boolean;
}

/** Text-only chars: images are attributed to their own category instead. */
function textChars(content: ContextMessage["content"]) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text") chars += block.text?.length ?? 0;
  }
  return chars;
}

function imageCount(content: ContextMessage["content"]) {
  if (!Array.isArray(content)) return 0;
  let images = 0;
  for (const block of content) {
    if (block.type === "image") images += 1;
  }
  return images;
}

/** A category accumulator: chars and whatever "how many" means for it. */
export class Bucket {
  chars = 0;
  count = 0;

  add(chars: number, count = 1) {
    this.chars += chars;
    this.count += count;
  }
}

export class NamedBuckets {
  private readonly buckets = new Map<string, Bucket>();

  add(name: string, chars: number, count = 1) {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new Bucket();
      this.buckets.set(name, bucket);
    }
    bucket.add(chars, count);
  }

  get total() {
    let chars = 0;
    let count = 0;
    for (const bucket of this.buckets.values()) {
      chars += bucket.chars;
      count += bucket.count;
    }
    return { chars, count };
  }

  totals(): NamedTotal[] {
    return [...this.buckets]
      .map(([name, bucket]) => ({
        name,
        tokens: tokensOf(bucket.chars),
        count: bucket.count,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  }
}

export interface ConversationTally {
  user: Bucket;
  assistantText: Bucket;
  reasoning: Bucket;
  toolCalls: Bucket;
  toolResults: NamedBuckets;
  bash: Bucket;
  custom: Bucket;
  summaries: Bucket;
  images: Bucket;
}

function emptyTally(): ConversationTally {
  return {
    user: new Bucket(),
    assistantText: new Bucket(),
    reasoning: new Bucket(),
    toolCalls: new Bucket(),
    toolResults: new NamedBuckets(),
    bash: new Bucket(),
    custom: new Bucket(),
    summaries: new Bucket(),
    images: new Bucket(),
  };
}

/** Mirrors convertToLlm(): `!!` bash output never reaches the provider. */
function isExcluded(message: ContextMessage) {
  return (
    message.role === "bashExecution" && message.excludeFromContext === true
  );
}

function tallyMessage(tally: ConversationTally, message: ContextMessage) {
  switch (message.role) {
    case "user": {
      tally.user.add(textChars(message.content));
      tally.images.add(0, imageCount(message.content));
      return;
    }
    case "assistant": {
      const blocks = Array.isArray(message.content) ? message.content : [];
      let text = 0;
      let thinking = 0;
      let calls = 0;
      let callCount = 0;
      for (const block of blocks) {
        if (block.type === "text") text += block.text?.length ?? 0;
        else if (block.type === "thinking")
          thinking += block.thinking?.length ?? 0;
        else if (block.type === "toolCall") {
          calls +=
            (block.name?.length ?? 0) +
            JSON.stringify(block.arguments ?? {}).length;
          callCount += 1;
        }
      }
      if (text > 0) tally.assistantText.add(text);
      if (thinking > 0) tally.reasoning.add(thinking);
      if (callCount > 0) tally.toolCalls.add(calls, callCount);
      return;
    }
    case "toolResult": {
      tally.toolResults.add(
        message.toolName ?? "unknown",
        textChars(message.content),
      );
      tally.images.add(0, imageCount(message.content));
      return;
    }
    case "bashExecution": {
      tally.bash.add(
        (message.command?.length ?? 0) + (message.output?.length ?? 0),
      );
      return;
    }
    case "custom": {
      tally.custom.add(textChars(message.content));
      tally.images.add(0, imageCount(message.content));
      return;
    }
    case "branchSummary":
    case "compactionSummary": {
      tally.summaries.add(message.summary?.length ?? 0);
      return;
    }
  }
}

function contextMessagesOf(entry: SessionEntry): ContextMessage[] {
  return sessionEntryToContextMessages(entry);
}

/** Walk the in-context entries once, bucketing every message by what it is. */
export function tallyEntries(entries: readonly SessionEntry[]) {
  const tally = emptyTally();
  for (const entry of entries) {
    for (const message of contextMessagesOf(entry)) {
      if (isExcluded(message)) continue;
      tallyMessage(tally, message);
    }
  }
  return tally;
}
