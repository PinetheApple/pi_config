/**
 * Durable subagent records.
 *
 * A subagent's live state dies with the parent process: the manager's registry
 * is in-memory and `session_shutdown` disposes every child scope. To make
 * `/subagents` survive a resume/fork/reload we mirror each subagent into a
 * `subagent-record` custom session entry. Custom entries are durable, are
 * excluded from LLM context, and are the documented channel for extension
 * state (docs/extensions.md, `pi.appendEntry`).
 *
 * Records are written twice per subagent (once when the child's session file
 * path is known, once on settle) and read back last-write-wins per id.
 */

import type {
  CustomEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  BACKEND_NAMES,
  type BackendName,
  type SubagentOrigin,
  type SubagentSnapshot,
  type SubagentStatus,
} from "./domain.ts";

export const SUBAGENT_RECORD_TYPE = "subagent-record";
/** Bump when the persisted shape changes incompatibly; readers migrate on `v`. */
export const SUBAGENT_RECORD_VERSION = 1;

/** Pre-record sessions only persisted by-the-way children under this type. */
export const LEGACY_BTW_RESULT_TYPE = "btw-result";

/**
 * The persisted shape. This is a compatibility surface: older sessions on disk
 * carry earlier versions, so every field except `v`/`id` must stay optional to
 * a reader and `parseSubagentRecord` must fail closed on anything unexpected.
 */
export interface SubagentRecord {
  readonly v: number;
  readonly id: string;
  readonly origin: SubagentOrigin;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly backend: BackendName;
  readonly status: SubagentStatus;
  readonly modelLabel?: string;
  /** pi session file / Claude projects JSONL / Codex rollout path. */
  readonly sessionFilePath?: string;
  readonly createdAt: number;
  readonly settledAt?: number;
  /** Truncated by the caller; never persist megabytes into the parent session. */
  readonly finalText?: string;
  readonly errorText?: string;
}

/**
 * Snapshot -> record. `finalText` is passed in already truncated so the caller
 * owns the budget (the tool layer's `truncatedOutput` is the single truncator).
 */
export function buildSubagentRecord(
  snap: SubagentSnapshot,
  finalText?: string,
): SubagentRecord {
  return {
    v: SUBAGENT_RECORD_VERSION,
    id: snap.id,
    origin: snap.origin,
    title: snap.title,
    prompt: snap.prompt,
    cwd: snap.cwd,
    backend: snap.backend,
    status: snap.status,
    modelLabel: snap.meta.modelLabel,
    sessionFilePath: snap.meta.sessionFilePath,
    createdAt: snap.createdAt,
    settledAt: snap.settledAt,
    finalText,
    errorText: snap.errorText,
  };
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isBackendName(value: unknown): value is BackendName {
  return BACKEND_NAMES.includes(value as BackendName);
}

function isStatus(value: unknown): value is SubagentStatus {
  return value === "running" || value === "done" || value === "error";
}

/** Parse untrusted on-disk data. Anything malformed is dropped, not guessed. */
export function parseSubagentRecord(
  data: unknown,
  timestamp: string,
): SubagentRecord | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  const id = optionalString(raw.id);
  if (!id) return undefined;
  if (!isBackendName(raw.backend)) return undefined;
  if (!isStatus(raw.status)) return undefined;
  return {
    v: optionalNumber(raw.v) ?? SUBAGENT_RECORD_VERSION,
    id,
    origin: raw.origin === "btw" ? "btw" : "model",
    title: optionalString(raw.title) ?? id,
    prompt: optionalString(raw.prompt) ?? "",
    cwd: optionalString(raw.cwd) ?? "",
    backend: raw.backend,
    status: raw.status,
    modelLabel: optionalString(raw.modelLabel),
    sessionFilePath: optionalString(raw.sessionFilePath),
    createdAt: optionalNumber(raw.createdAt) ?? parseTimestamp(timestamp),
    settledAt: optionalNumber(raw.settledAt),
    finalText: optionalString(raw.finalText),
    errorText: optionalString(raw.errorText),
  };
}

function parseTimestamp(timestamp: string) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Sessions recorded before `subagent-record` existed still hold a `btw-result`
 * entry per by-the-way child; project it onto the record shape so both origins
 * restore through one path. by-the-way always spawns the pi backend.
 */
function parseLegacyBtwResult(
  data: unknown,
  timestamp: string,
): SubagentRecord | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  const id = optionalString(raw.id);
  if (!id) return undefined;
  const createdAt = parseTimestamp(timestamp);
  return {
    v: SUBAGENT_RECORD_VERSION,
    id,
    origin: "btw",
    title: optionalString(raw.title) ?? id,
    prompt: optionalString(raw.prompt) ?? "",
    cwd: "",
    backend: "pi",
    status: isStatus(raw.status) ? raw.status : "done",
    sessionFilePath: optionalString(raw.sessionFilePath),
    createdAt,
    settledAt: createdAt,
    finalText: optionalString(raw.answer),
    errorText: optionalString(raw.errorText),
  };
}

/**
 * Change-gated writer for the records above.
 *
 * Driven off the manager's read-model notification, which fires on every event
 * a subagent emits; the signature keeps that down to about two entries per
 * subagent — one once its child session file is known, one when it settles.
 */
export function createRecordWriter(options: {
  append: (record: SubagentRecord) => void;
  /** Truncator for `finalText`; records live in the parent session forever. */
  truncateFinalText: (snap: SubagentSnapshot) => string;
}) {
  const signatures = new Map<string, string>();

  const signatureOf = (
    parts: Pick<
      SubagentRecord,
      "status" | "settledAt" | "sessionFilePath" | "modelLabel"
    >,
  ) =>
    [
      parts.status,
      parts.settledAt ?? "",
      parts.sessionFilePath ?? "",
      parts.modelLabel ?? "",
    ].join("|");

  return {
    write(snapshots: ReadonlyArray<SubagentSnapshot>) {
      for (const snap of snapshots) {
        // Adopted entries came from these very records; re-persisting would
        // duplicate history and overwrite it with a degraded copy.
        if (snap.restored) continue;
        const settled = snap.status !== "running";
        // Before the child's session file is known there is nothing worth
        // restoring; wait for meta rather than write a useless first record.
        if (!settled && !snap.meta.sessionFilePath) continue;
        const signature = signatureOf({
          status: snap.status,
          settledAt: snap.settledAt,
          sessionFilePath: snap.meta.sessionFilePath,
          modelLabel: snap.meta.modelLabel,
        });
        if (signatures.get(snap.id) === signature) continue;
        signatures.set(snap.id, signature);
        options.append(
          buildSubagentRecord(
            snap,
            settled ? options.truncateFinalText(snap) : undefined,
          ),
        );
      }
    },
    /** Adopt the records' own signatures so restoration writes nothing back. */
    seed(records: ReadonlyArray<SubagentRecord>) {
      for (const record of records) {
        signatures.set(record.id, signatureOf(record));
      }
    },
    clear() {
      signatures.clear();
    },
  };
}

function recordTime(record: SubagentRecord) {
  return record.settledAt ?? record.createdAt;
}

/**
 * Collect the restorable records from a branch of session entries, newest
 * `limit` kept, returned oldest-first so adoption preserves spawn order.
 *
 * Callers pass `sessionManager.getBranch()` — the active path. `getEntries()`
 * would resurrect subagents from abandoned branches the user forked away from.
 */
export function collectSubagentRecords(
  entries: ReadonlyArray<SessionEntry>,
  limit: number,
): SubagentRecord[] {
  const byId = new Map<string, SubagentRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const custom = entry as CustomEntry;
    if (custom.customType === SUBAGENT_RECORD_TYPE) {
      const record = parseSubagentRecord(custom.data, custom.timestamp);
      if (record) byId.set(record.id, record);
      continue;
    }
    if (custom.customType !== LEGACY_BTW_RESULT_TYPE) continue;
    const legacy = parseLegacyBtwResult(custom.data, custom.timestamp);
    // A real record always wins: it is strictly richer than the legacy shape.
    if (legacy && !byId.has(legacy.id)) byId.set(legacy.id, legacy);
  }
  return [...byId.values()]
    .sort((a, b) => recordTime(b) - recordTime(a))
    .slice(0, Math.max(0, limit))
    .reverse();
}
