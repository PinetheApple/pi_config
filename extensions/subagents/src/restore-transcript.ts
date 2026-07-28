/**
 * Transcript recovery for restored subagents.
 *
 * A restored entry has no in-memory transcript — the manager only ever folded
 * one from a live event stream. The pi backend, though, gives its children
 * real session files (`SessionManager.create(task.cwd)`), so a pi child's
 * conversation can be replayed from JSONL on disk.
 *
 * Claude and Codex children write their own native formats; rather than fake a
 * transcript from a shape we do not own, those show the persisted final text
 * and a pointer to the file.
 */

import * as fs from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot, TranscriptItem } from "./domain.ts";
import { messageToTranscriptItem } from "./message-transcript.ts";
import { MAX_TRANSCRIPT_ITEMS } from "./snapshot.ts";

/** A child JSONL larger than this is not worth loading into an overlay. */
const MAX_TRANSCRIPT_FILE_BYTES = 32 * 1_024 * 1_024;

export interface RestoredTranscript {
  readonly items: ReadonlyArray<TranscriptItem>;
  /** One dim line explaining where these lines came from, or why they did not. */
  readonly note: string;
}

/** What we can still show when the child's own transcript is unavailable. */
function persistedOnly(snap: SubagentSnapshot, note: string) {
  const items: TranscriptItem[] = [];
  if (snap.prompt.trim()) items.push({ kind: "user", text: snap.prompt });
  if (snap.finalText.trim()) {
    items.push({
      kind: "assistant",
      parts: [{ type: "text", text: snap.finalText }],
    });
  }
  return { items, note } satisfies RestoredTranscript;
}

function describeError(error: unknown) {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "ENOENT") return "file no longer exists";
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load a restored subagent's transcript. Lazy by construction — call it when
 * the takeover view opens, never during `session_start`.
 */
export async function loadRestoredTranscript(
  snap: SubagentSnapshot,
): Promise<RestoredTranscript> {
  const file = snap.meta.sessionFilePath;
  if (!file) {
    return persistedOnly(snap, "restored · no child session file recorded");
  }
  if (snap.backend !== "pi") {
    return persistedOnly(
      snap,
      `restored · ${snap.backend} transcript not replayed · ${file}`,
    );
  }

  let content: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_TRANSCRIPT_FILE_BYTES) {
      return persistedOnly(snap, `restored · transcript too large · ${file}`);
    }
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    return persistedOnly(
      snap,
      `restored · transcript unavailable (${describeError(error)}) · ${file}`,
    );
  }

  const items: TranscriptItem[] = [];
  for (const entry of parseSessionEntries(content)) {
    if (entry.type !== "message") continue;
    const item = messageToTranscriptItem(entry.message as Message);
    if (item) items.push(item);
  }
  if (items.length === 0) {
    return persistedOnly(snap, `restored · transcript was empty · ${file}`);
  }
  return {
    items: items.slice(-MAX_TRANSCRIPT_ITEMS),
    note: `restored · replayed from ${file}`,
  };
}
