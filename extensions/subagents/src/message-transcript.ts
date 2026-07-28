/**
 * Translation from raw pi/`@earendil-works/pi-ai` messages into the normalized
 * transcript shapes the manager and UI speak.
 *
 * Shared by two readers of the same data: the pi backend (live
 * `session.subscribe()` events) and the restore path (a dead child's session
 * JSONL, replayed after the parent was resumed).
 */

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { TranscriptItem, TranscriptPart } from "./domain.ts";

export function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text.slice(0, 4_096);
  } catch {
    return undefined;
  }
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
export function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

export function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        redacted: part.redacted,
      });
    } else if (part.type === "toolCall") {
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        argsPreview: safeJson(part.arguments),
      });
    }
  }
  return parts;
}

export function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Fold one persisted message into a transcript item. Returns undefined for
 * messages that carry nothing renderable (empty user turns, unknown roles).
 */
export function messageToTranscriptItem(
  msg: Message,
): TranscriptItem | undefined {
  switch (msg.role) {
    case "user": {
      const text = userText(msg).trim();
      return text ? { kind: "user", text } : undefined;
    }
    case "assistant": {
      const parts = assistantParts(msg);
      return parts.length > 0 ? { kind: "assistant", parts } : undefined;
    }
    case "toolResult":
      return {
        kind: "toolResult",
        toolId: msg.toolCallId,
        name: msg.toolName,
        isError: msg.isError === true,
        outputPreview: toolPreview(msg),
      };
    default:
      return undefined;
  }
}
