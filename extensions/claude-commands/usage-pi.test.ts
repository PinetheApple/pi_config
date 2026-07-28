import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sumEntryUsage } from "../shared/usage-totals.ts";
import { accumulateJsonl, scanSessionDir } from "./src/usage/pi.ts";
import { inWindow, windowStart } from "./src/usage/window.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 6, 27, 12, 0, 0);

function usage(input: number, output: number, cost: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistantLine(at: Date, input: number, output: number, cost: number) {
  return JSON.stringify({
    type: "message",
    id: `a-${at.getTime()}`,
    parentId: null,
    timestamp: at.toISOString(),
    message: {
      role: "assistant",
      content: [],
      usage: usage(input, output, cost),
    },
  });
}

test("sumEntryUsage adds only assistant usage", () => {
  const entries = [
    {
      type: "message",
      id: "1",
      parentId: null,
      timestamp: NOW.toISOString(),
      message: { role: "assistant", content: [], usage: usage(10, 5, 0.25) },
    },
    {
      type: "message",
      id: "2",
      parentId: "1",
      timestamp: NOW.toISOString(),
      message: { role: "user", content: "hi" },
    },
    {
      type: "message",
      id: "3",
      parentId: "2",
      timestamp: NOW.toISOString(),
      message: { role: "assistant", content: [], usage: usage(3, 2, 0.75) },
    },
  ] as unknown as SessionEntry[];

  const summary = sumEntryUsage(entries);
  assert.equal(summary.messages, 2);
  assert.equal(summary.input, 13);
  assert.equal(summary.output, 7);
  assert.equal(summary.totalTokens, 20);
  assert.equal(summary.cost, 1);
});

test("windowStart uses local midnight for today", () => {
  const start = windowStart("today", NOW);
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(new Date(start).getDate(), 27);
  assert.equal(windowStart("all", NOW), Number.NEGATIVE_INFINITY);
});

test("inWindow respects today/7d/30d boundaries", () => {
  const todayMidnight = windowStart("today", NOW);
  const yesterdayLate = todayMidnight - 60_000;
  const eightDaysAgo = NOW.getTime() - 8 * DAY_MS;
  const fortyDaysAgo = NOW.getTime() - 40 * DAY_MS;

  assert.equal(inWindow(todayMidnight, "today", NOW), true);
  assert.equal(inWindow(yesterdayLate, "today", NOW), false);
  assert.equal(inWindow(yesterdayLate, "7d", NOW), true);
  assert.equal(inWindow(eightDaysAgo, "7d", NOW), false);
  assert.equal(inWindow(eightDaysAgo, "30d", NOW), true);
  assert.equal(inWindow(fortyDaysAgo, "30d", NOW), false);
  assert.equal(inWindow(fortyDaysAgo, "all", NOW), true);

  // Entries with no usable timestamp only ever count towards all-time.
  assert.equal(inWindow(Number.NaN, "all", NOW), true);
  assert.equal(inWindow(Number.NaN, "7d", NOW), false);
});

test("accumulateJsonl buckets records by window and ignores noise", () => {
  const content = [
    assistantLine(new Date(NOW.getTime() - 60_000), 100, 10, 0.1),
    assistantLine(new Date(NOW.getTime() - 3 * DAY_MS), 200, 20, 0.2),
    assistantLine(new Date(NOW.getTime() - 20 * DAY_MS), 400, 40, 0.4),
    assistantLine(new Date(NOW.getTime() - 90 * DAY_MS), 800, 80, 0.8),
    "not json at all",
    JSON.stringify({ type: "custom", customType: "x", data: {} }),
    JSON.stringify({
      type: "message",
      timestamp: NOW.toISOString(),
      message: { role: "user", content: "hi" },
    }),
    "",
  ].join("\n");

  const windows = accumulateJsonl(content, NOW);
  assert.equal(windows.today.input, 100);
  assert.equal(windows.today.messages, 1);
  assert.equal(windows["7d"].input, 300);
  assert.equal(windows["30d"].input, 700);
  assert.equal(windows.all.input, 1500);
  assert.equal(windows.all.messages, 4);
  assert.equal(windows.all.cost.toFixed(2), "1.50");
});

test("scanSessionDir aggregates jsonl files and reports counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-sessions-"));
  await writeFile(
    join(dir, "a.jsonl"),
    assistantLine(new Date(NOW.getTime() - 60_000), 10, 1, 0.01),
  );
  await writeFile(
    join(dir, "b.jsonl"),
    assistantLine(new Date(NOW.getTime() - 10 * DAY_MS), 20, 2, 0.02),
  );
  await writeFile(join(dir, "ignore.txt"), "not a session");

  const scan = await scanSessionDir(dir, NOW);
  assert.ok(scan);
  assert.equal(scan.filesAvailable, 2);
  assert.equal(scan.filesScanned, 2);
  assert.equal(scan.truncated, false);
  assert.equal(scan.windows.all.input, 30);
  assert.equal(scan.windows["7d"].input, 10);
  assert.equal(scan.windows["30d"].input, 30);
});

test("scanSessionDir returns undefined for a missing directory", async () => {
  assert.equal(
    await scanSessionDir(join(tmpdir(), "cc-missing-dir"), NOW),
    undefined,
  );
});
