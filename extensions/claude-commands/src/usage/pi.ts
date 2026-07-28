/**
 * pi's own token/cost usage: the live branch, plus a capped scan of the
 * session JSONLs for this cwd so windowed totals are available.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  addUsage,
  emptyUsageSummary,
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
  usage: Parameters<typeof addUsage>[1];
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
    usage: usage as ScannedRecord["usage"],
  };
}

export function accumulateRecords(
  records: Iterable<ScannedRecord>,
  now: Date,
  into = emptyUsageByWindow(),
) {
  for (const record of records) {
    for (const window of USAGE_WINDOWS) {
      if (!inWindow(record.timestampMs, window, now)) continue;
      addUsage(into[window], record.usage);
    }
  }
  return into;
}

/** Exported for tests: window-bucket the raw lines of a session JSONL. */
export function accumulateJsonl(
  content: string,
  now: Date,
  into?: UsageByWindow,
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
  filesScanned: number;
  filesAvailable: number;
  truncated: boolean;
}

export async function scanSessionDir(
  sessionDir: string,
  now: Date,
): Promise<SessionScan | undefined> {
  let names: string[];
  try {
    names = (await readdir(sessionDir)).filter((name) =>
      name.endsWith(".jsonl"),
    );
  } catch {
    return undefined;
  }

  const stats = [];
  for (const name of names) {
    const path = join(sessionDir, name);
    try {
      const info = await stat(path);
      if (info.isFile())
        stats.push({ path, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // Session file vanished between readdir and stat; skip it.
    }
  }
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const windows = emptyUsageByWindow();
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
    accumulateJsonl(content, now, windows);
  }

  return {
    windows,
    filesScanned,
    filesAvailable: stats.length,
    truncated,
  };
}
