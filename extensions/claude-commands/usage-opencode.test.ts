import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  aggregateOpencodeRows,
  parseModelColumn,
  readOpencodeUsage,
  type OpencodeSessionRow,
} from "./src/usage/opencode.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 6, 27, 12, 0, 0);

function row(overrides: Partial<OpencodeSessionRow> = {}): OpencodeSessionRow {
  return {
    model:
      '{"id":"deepseek-v4-flash-free","providerID":"opencode","variant":"medium"}',
    cost: 0,
    tokens_input: 100,
    tokens_output: 10,
    tokens_reasoning: 5,
    tokens_cache_read: 1000,
    tokens_cache_write: 0,
    time_updated: NOW.getTime() - 60_000,
    ...overrides,
  };
}

test("parseModelColumn reads the JSON blob", () => {
  assert.deepEqual(
    parseModelColumn('{"id":"qwen3.5:cloud","providerID":"ollama"}'),
    { provider: "ollama", model: "qwen3.5:cloud" },
  );
});

test("parseModelColumn falls back to unknown for unusable values", () => {
  const unknown = { provider: "unknown", model: "unknown" };
  assert.deepEqual(parseModelColumn(null), unknown);
  assert.deepEqual(parseModelColumn(""), unknown);
  assert.deepEqual(parseModelColumn("{not json"), unknown);
  assert.deepEqual(parseModelColumn("42"), unknown);
  assert.deepEqual(parseModelColumn(17), unknown);
  assert.deepEqual(parseModelColumn("{}"), unknown);
  assert.deepEqual(parseModelColumn('{"id":"m"}'), {
    provider: "unknown",
    model: "m",
  });
});

test("aggregateOpencodeRows buckets by window and groups by model", () => {
  const totals = aggregateOpencodeRows(
    [
      row(),
      row({ time_updated: NOW.getTime() - 10 * DAY_MS, tokens_input: 7 }),
      row({
        model: '{"id":"qwen3.5:cloud","providerID":"ollama"}',
        time_updated: NOW.getTime() - 100 * DAY_MS,
        tokens_input: 1,
        cost: 2.5,
      }),
      row({ model: null, time_updated: null, tokens_input: 3 }),
    ],
    NOW,
  );

  assert.equal(totals.rows, 4);
  assert.equal(totals.windows.today.usage.input, 100);
  assert.equal(totals.windows.today.sessions, 1);
  assert.equal(totals.windows["7d"].usage.input, 100);
  assert.equal(totals.windows["30d"].usage.input, 107);
  assert.equal(totals.windows.all.usage.input, 111);
  assert.equal(totals.windows.all.sessions, 4);
  assert.equal(totals.windows.all.usage.cost, 2.5);

  const keys = totals.byModel.map(
    (bucket) => `${bucket.provider}/${bucket.model}`,
  );
  assert.deepEqual(
    new Set(keys),
    new Set([
      "opencode/deepseek-v4-flash-free",
      "ollama/qwen3.5:cloud",
      "unknown/unknown",
    ]),
  );
  const primary = totals.byModel.find(
    (bucket) => bucket.model === "deepseek-v4-flash-free",
  );
  assert.equal(primary?.sessions, 2);
  assert.equal(primary?.usage.input, 107);
  // totalTokens is recomputed from the columns, not read from the row.
  assert.equal(primary?.usage.totalTokens, 107 + 20 + 2000);
});

test("aggregateOpencodeRows keeps zero-cost rows visible", () => {
  const totals = aggregateOpencodeRows([row({ cost: 0 })], NOW);
  assert.equal(totals.byModel.length, 1);
  assert.equal(totals.byModel[0]?.usage.cost, 0);
});

test("readOpencodeUsage reads a real database read-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-opencode-"));
  const dbPath = join(dir, "opencode.db");

  const seed = new DatabaseSync(dbPath);
  seed.exec(`create table session (
    id text, model text, cost real, tokens_input integer, tokens_output integer,
    tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer,
    time_updated integer
  )`);
  seed.exec(`insert into session values
    ('s1', '{"id":"m1","providerID":"p1"}', 0.0, 100, 10, 0, 50, 0, ${NOW.getTime() - 60_000}),
    ('s2', 'broken-json', 1.25, 5, 1, 0, 0, 0, ${NOW.getTime() - 40 * DAY_MS})`);
  seed.close();

  const result = await readOpencodeUsage(dbPath, NOW);
  assert.ok(result.ok);
  assert.equal(result.totals.rows, 2);
  assert.equal(result.totals.windows.today.usage.input, 100);
  assert.equal(result.totals.windows.all.usage.cost, 1.25);
  assert.ok(
    result.totals.byModel.some(
      (bucket) => bucket.provider === "unknown" && bucket.model === "unknown",
    ),
  );
});

test("readOpencodeUsage skips a missing file with a reason", async () => {
  const result = await readOpencodeUsage(join(tmpdir(), "cc-no-such.db"), NOW);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.length > 0);
});

test("readOpencodeUsage skips a database whose schema does not match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-opencode-bad-"));
  const dbPath = join(dir, "other.db");
  const seed = new DatabaseSync(dbPath);
  seed.exec("create table unrelated (id text)");
  seed.close();

  const result = await readOpencodeUsage(dbPath, NOW);
  assert.equal(result.ok, false);
});
