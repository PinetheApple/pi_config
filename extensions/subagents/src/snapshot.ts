/**
 * Snapshot state and event folding.
 *
 * The manager owns lifecycle (scopes, concurrency, wait interest, pruning);
 * this module owns the shape of a tracked subagent and the pure-ish fold from
 * a normalized `SubagentEvent` into it. Split out of manager.ts to keep both
 * files readable.
 */

import type { Fiber, Scope } from "effect";
import type { SubagentSession } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  SubagentEvent,
  SubagentMeta,
  SubagentOrigin,
  SubagentSnapshot,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import type { SubagentRecord } from "./record.ts";

export const ERROR_TEXT_MAX_LENGTH = 4_096;
export const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
export const MAX_TRANSCRIPT_ITEMS = 512;

/** Shown instead of "running" for a subagent whose parent process is gone. */
export const ABANDONED_ERROR_TEXT =
  "Subagent did not survive the session exit; it was still running when pi closed.";

export function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedTranscriptText(text: string) {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
export interface MutableSnapshot {
  id: string;
  origin: SubagentOrigin;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
  restored?: true;
}

export interface Entry {
  snapshot: MutableSnapshot;
  /**
   * Absent for restored entries: the child process/session died with the
   * parent, so there is nothing left to steer, interrupt, or close.
   */
  session?: SubagentSession;
  scope?: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
}

export function appendTranscript(
  snapshot: MutableSnapshot,
  item: TranscriptItem,
) {
  snapshot.transcript.push(item);
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(
      0,
      snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS,
    );
  }
}

/**
 * Build a terminal, inert entry from a persisted record.
 *
 * A record still marked `running` means the parent exited mid-run: that child
 * is definitively gone, so it is adopted as `error` rather than pretending it
 * may still report back.
 */
export function createRestoredEntry(record: SubagentRecord): Entry {
  const abandoned = record.status === "running";
  return {
    snapshot: {
      id: record.id,
      origin: record.origin,
      backend: record.backend,
      title: record.title,
      prompt: record.prompt,
      cwd: record.cwd,
      status: abandoned ? "error" : record.status,
      createdAt: record.createdAt,
      settledAt: record.settledAt ?? record.createdAt,
      errorText: abandoned
        ? ABANDONED_ERROR_TEXT
        : record.errorText
          ? bounded(record.errorText)
          : undefined,
      meta: {
        backend: record.backend,
        modelLabel: record.modelLabel,
        sessionFilePath: record.sessionFilePath,
      },
      usage: {},
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: (record.finalText ?? "").slice(0, FINAL_TEXT_MAX_LENGTH),
      turns: 0,
      restored: true,
    },
    liveToolMap: new Map(),
  };
}

/**
 * Fold the normalized event stream into the snapshot. `settle` and `notify`
 * are injected because terminal transitions are lifecycle concerns the manager
 * owns (wait interest, result delivery, pruning).
 */
export function makeFoldEvent(hooks: {
  settle: (
    entry: Entry,
    outcome: Extract<SubagentEvent, { _tag: "RunSettled" }>["outcome"],
  ) => void;
  notify: (id: string) => void;
}) {
  return function foldEvent(entry: Entry, event: SubagentEvent) {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        entry.restarting = false;
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        break;
      case "RunSettled":
        hooks.settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        appendTranscript(s, {
          kind: "user",
          text: boundedTranscriptText(event.text),
        });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? {
                ...live,
                text: (live.text + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              }
            : {
                ...live,
                thinking: (live.thinking + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              };
        break;
      }
      case "AssistantMessage":
        appendTranscript(s, {
          kind: "assistant",
          parts: event.parts.map((part) =>
            part.type === "toolCall"
              ? {
                  ...part,
                  argsPreview: part.argsPreview
                    ? boundedTranscriptText(part.argsPreview)
                    : undefined,
                }
              : { ...part, text: boundedTranscriptText(part.text) },
          ),
        });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview
            ? boundedTranscriptText(event.argsPreview)
            : undefined,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        appendTranscript(s, {
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview
            ? boundedTranscriptText(event.outputPreview)
            : undefined,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    hooks.notify(s.id);
  };
}
