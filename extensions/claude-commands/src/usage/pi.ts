/**
 * pi's own token/cost usage: the live branch, plus a capped recursive scan of
 * the session JSONLs so windowed and per-model totals are available.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { UNKNOWN_MODEL_FIELD } from "../format.ts";
import {
  addUsage,
  emptyUsageSummary,
  mergeUsage,
  sumEntryUsage,
  type UsageSummary,
} from "../../../shared/usage-totals.ts";
import {
  USAGE_WINDOWS,
  inWindow,
  toEpochMs,
  type UsageWindow,
} from "./window.ts";

/** Caps keep the scan bounded as the session directory grows. */
export const MAX_SCANNED_FILES = 100;
export const MAX_SCANNED_BYTES = 32 * 1024 * 1024;

export type UsageByWindow = Record<UsageWindow, UsageSummary>;

export function emptyUsageByWindow(): UsageByWindow {
  return Object.fromEntries(
    USAGE_WINDOWS.map((window) => [window, emptyUsageSummary()]),
  ) as UsageByWindow;
}

export function summarizeBranch(entries: readonly SessionEntry[]) {
  return sumEntryUsage(entries);
}

/** Minimal projection of a session JSONL line; everything else is ignored. */
interface ScannedRecord {
  timestampMs: number;
  provider: string;
  model: string;
  usage: Parameters<typeof addUsage>[1];
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

function readRecord(line: string): ScannedRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const entry = parsed as Record<string, unknown>;
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (!message || typeof message !== "object") return undefined;

  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") return undefined;
  const usage = record.usage;
  if (!usage || typeof usage !== "object") return undefined;

  return {
    timestampMs: toEpochMs(
      typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    ),
    provider: text(record.provider, UNKNOWN_MODEL_FIELD),
    model: text(record.model, UNKNOWN_MODEL_FIELD),
    usage: usage as ScannedRecord["usage"],
  };
}

/** One provider/model pair, windowed the same way the totals are. */
export interface ModelBucket {
  provider: string;
  model: string;
  windows: UsageByWindow;
}

export type ModelBuckets = Map<string, ModelBucket>;

export function accumulateRecords(
  records: Iterable<ScannedRecord>,
  now: Date,
  into: ModelBuckets = new Map(),
) {
  for (const record of records) {
    const id = `${record.provider}/${record.model}`;
    let bucket = into.get(id);
    if (!bucket) {
      bucket = {
        provider: record.provider,
        model: record.model,
        windows: emptyUsageByWindow(),
      };
      into.set(id, bucket);
    }
    for (const window of USAGE_WINDOWS) {
      if (!inWindow(record.timestampMs, window, now)) continue;
      addUsage(bucket.windows[window], record.usage);
    }
  }
  return into;
}

/** Fold per-model buckets back into a single windowed total. */
export function sumModelWindows(buckets: Iterable<ModelBucket>) {
  const windows = emptyUsageByWindow();
  for (const bucket of buckets) {
    for (const window of USAGE_WINDOWS) {
      mergeUsage(windows[window], bucket.windows[window]);
    }
  }
  return windows;
}

/** Exported for tests: bucket the raw lines of a session JSONL by model. */
export function accumulateJsonl(
  content: string,
  now: Date,
  into?: ModelBuckets,
) {
  const records: ScannedRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = readRecord(line);
    if (record) records.push(record);
  }
  return accumulateRecords(records, now, into);
}

export interface SessionScan {
  windows: UsageByWindow;
  /** Sorted by all-time tokens, descending. */
  models: ModelBucket[];
  filesScanned: number;
  filesAvailable: number;
  truncated: boolean;
}

async function collectSessionFiles(root: string) {
  const stats: { path: string; mtimeMs: number; size: number }[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop() as string;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (info.isDirectory()) pending.push(path);
        else if (info.isFile() && name.endsWith(".jsonl"))
          stats.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // Entry vanished between readdir and stat; skip it.
      }
    }
  }
  return stats;
}

/** Recursive, capped scan of every session JSONL under `sessionsRoot`. */
export async function scanSessionDir(
  sessionsRoot: string,
  now: Date,
): Promise<SessionScan | undefined> {
  try {
    if (!(await stat(sessionsRoot)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const stats = await collectSessionFiles(sessionsRoot);
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const buckets: ModelBuckets = new Map();
  let filesScanned = 0;
  let bytes = 0;
  let truncated = false;

  for (const candidate of stats) {
    if (
      filesScanned >= MAX_SCANNED_FILES ||
      bytes + candidate.size > MAX_SCANNED_BYTES
    ) {
      truncated = true;
      break;
    }
    let content: string;
    try {
      content = await readFile(candidate.path, "utf8");
    } catch {
      continue;
    }
    bytes += candidate.size;
    filesScanned += 1;
    accumulateJsonl(content, now, buckets);
  }

  const models = [...buckets.values()].sort(
    (a, b) =>
      b.windows.all.totalTokens - a.windows.all.totalTokens ||
      `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
  );

  return {
    windows: sumModelWindows(models),
    models,
    filesScanned,
    filesAvailable: stats.length,
    truncated,
  };
}
