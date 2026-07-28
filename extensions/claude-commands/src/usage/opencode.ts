/**
 * Read-only usage aggregation from opencode's SQLite store.
 *
 * The database is opened read-only and never written. A WAL database opened
 * read-only, a missing file, or a schema that has moved on all degrade to a
 * skipped section with a one-line reason.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { UNKNOWN_MODEL_FIELD } from "../format.ts";
import {
  emptyUsageSummary,
  mergeUsage,
  type UsageSummary,
} from "../../../shared/usage-totals.ts";
import { USAGE_WINDOWS, inWindow, type UsageWindow } from "./window.ts";

export const OPENCODE_DB_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "opencode.db",
);

export interface OpencodeSessionRow {
  model: unknown;
  cost: unknown;
  tokens_input: unknown;
  tokens_output: unknown;
  tokens_reasoning: unknown;
  tokens_cache_read: unknown;
  tokens_cache_write: unknown;
  time_updated: unknown;
}

export interface OpencodeModelKey {
  provider: string;
  model: string;
}

export interface OpencodeBucket extends OpencodeModelKey {
  usage: UsageSummary;
  sessions: number;
}

export interface OpencodeTotals {
  windows: Record<UsageWindow, { usage: UsageSummary; sessions: number }>;
  byModel: OpencodeBucket[];
  rows: number;
}

const UNKNOWN: OpencodeModelKey = {
  provider: UNKNOWN_MODEL_FIELD,
  model: UNKNOWN_MODEL_FIELD,
};

/** The `model` column is a JSON blob; anything else is bucketed as unknown. */
export function parseModelColumn(raw: unknown): OpencodeModelKey {
  if (typeof raw !== "string" || raw.trim() === "") return UNKNOWN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNKNOWN;
  }
  if (!parsed || typeof parsed !== "object") return UNKNOWN;
  const record = parsed as Record<string, unknown>;
  const provider =
    typeof record.providerID === "string" && record.providerID
      ? record.providerID
      : UNKNOWN.provider;
  const model =
    typeof record.id === "string" && record.id ? record.id : UNKNOWN.model;
  return { provider, model };
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rowUsage(row: OpencodeSessionRow) {
  const input = num(row.tokens_input);
  const output = num(row.tokens_output);
  const cacheRead = num(row.tokens_cache_read);
  const cacheWrite = num(row.tokens_cache_write);
  return {
    messages: 0,
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: num(row.tokens_reasoning),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: num(row.cost),
  } satisfies UsageSummary;
}

export function aggregateOpencodeRows(
  rows: readonly OpencodeSessionRow[],
  now: Date,
): OpencodeTotals {
  const windows = Object.fromEntries(
    USAGE_WINDOWS.map((window) => [
      window,
      { usage: emptyUsageSummary(), sessions: 0 },
    ]),
  ) as OpencodeTotals["windows"];

  const byModel = new Map<string, OpencodeBucket>();

  for (const row of rows) {
    const usage = rowUsage(row);
    const updatedAt = num(row.time_updated);

    for (const window of USAGE_WINDOWS) {
      if (!inWindow(updatedAt, window, now)) continue;
      mergeUsage(windows[window].usage, usage);
      windows[window].sessions += 1;
    }

    const key = parseModelColumn(row.model);
    const id = `${key.provider}/${key.model}`;
    let bucket = byModel.get(id);
    if (!bucket) {
      bucket = { ...key, usage: emptyUsageSummary(), sessions: 0 };
      byModel.set(id, bucket);
    }
    mergeUsage(bucket.usage, usage);
    bucket.sessions += 1;
  }

  return {
    windows,
    byModel: [...byModel.values()].sort(
      (a, b) =>
        b.usage.totalTokens - a.usage.totalTokens ||
        `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
    ),
    rows: rows.length,
  };
}

const SELECT_SESSIONS = `
  select model, cost, tokens_input, tokens_output, tokens_reasoning,
         tokens_cache_read, tokens_cache_write, time_updated
  from session
`;

export type OpencodeRead =
  { ok: true; totals: OpencodeTotals } | { ok: false; reason: string };

export async function readOpencodeUsage(
  dbPath: string,
  now: Date,
): Promise<OpencodeRead> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ok: false, reason: "node:sqlite is unavailable in this runtime" };
  }

  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(SELECT_SESSIONS)
      .all() as unknown as OpencodeSessionRow[];
    return { ok: true, totals: aggregateOpencodeRows(rows, now) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // A failed open leaves nothing to close.
    }
  }
}
