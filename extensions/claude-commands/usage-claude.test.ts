import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchClaudeQuota, parseQuotaResponse } from "./src/usage/claude.ts";

/** Synthetic placeholder; no real credential material appears in this file. */
const FAKE_TOKEN = "fake-oauth-token-for-tests";

async function credentialsFixture(body: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "cc-creds-"));
  const path = join(dir, ".credentials.json");
  await writeFile(path, JSON.stringify(body));
  return path;
}

test("parseQuotaResponse reads every known window", () => {
  const windows = parseQuotaResponse({
    five_hour: { utilization: 42, resets_at: "2026-07-27T15:00:00Z" },
    seven_day: { utilization: 7.5, resets_at: "2026-08-01T00:00:00Z" },
    seven_day_opus: { utilization: 0, resets_at: "2026-08-01T00:00:00Z" },
    seven_day_sonnet: { utilization: 100, resets_at: "2026-08-01T00:00:00Z" },
    extra_usage: { utilization: 3, resets_at: "2026-08-01T00:00:00Z" },
  });

  assert.equal(windows.length, 5);
  assert.equal(windows[0]?.key, "five_hour");
  assert.equal(windows[0]?.utilization, 0.42);
  assert.equal(windows[0]?.resetsAt?.toISOString(), "2026-07-27T15:00:00.000Z");
  assert.equal(windows[2]?.utilization, 0);
});

test("parseQuotaResponse tolerates missing and malformed fields", () => {
  const windows = parseQuotaResponse({
    five_hour: { utilization: 10 },
    seven_day: { resets_at: "2026-08-01T00:00:00Z" },
    seven_day_opus: { utilization: "lots", resets_at: 12345 },
    seven_day_sonnet: null,
    unknown_window: { utilization: 99 },
  });

  assert.deepEqual(
    windows.map((window) => window.key),
    ["five_hour", "seven_day"],
  );
  assert.equal(windows[0]?.resetsAt, undefined);
  assert.equal(windows[1]?.utilization, undefined);
});

test("parseQuotaResponse returns nothing for a non-object body", () => {
  assert.deepEqual(parseQuotaResponse(null), []);
  assert.deepEqual(parseQuotaResponse("nope"), []);
  assert.deepEqual(parseQuotaResponse({}), []);
});

test("fetchClaudeQuota sends the token as a bearer header only", async () => {
  const path = await credentialsFixture({
    claudeAiOauth: { accessToken: FAKE_TOKEN, refreshToken: "unused" },
  });

  let seen: Headers | undefined;
  const result = await fetchClaudeQuota({
    credentialsPath: path,
    url: "https://example.invalid/usage",
    fetchImpl: async (_input, init) => {
      seen = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 12, resets_at: "2026-07-27T18:00:00Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  assert.equal(seen?.get("authorization"), `Bearer ${FAKE_TOKEN}`);
  assert.equal(seen?.get("anthropic-beta"), "oauth-2025-04-20");
  assert.ok(result.ok);
  assert.equal(result.windows[0]?.utilization, 0.12);
});

test("fetchClaudeQuota reports expiry without leaking the token", async () => {
  const path = await credentialsFixture({
    claudeAiOauth: { accessToken: FAKE_TOKEN },
  });

  const result = await fetchClaudeQuota({
    credentialsPath: path,
    fetchImpl: async () => new Response("", { status: 401 }),
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("run `claude` to refresh"));
  assert.ok(!result.ok && !result.reason.includes(FAKE_TOKEN));
});

test("fetchClaudeQuota skips when credentials are missing or unparseable", async () => {
  const missing = await fetchClaudeQuota({
    credentialsPath: join(tmpdir(), "cc-no-creds.json"),
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(missing.ok, false);

  const dir = await mkdtemp(join(tmpdir(), "cc-creds-bad-"));
  const badPath = join(dir, ".credentials.json");
  await writeFile(badPath, "{not json");
  const bad = await fetchClaudeQuota({
    credentialsPath: badPath,
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(bad.ok, false);
});

test("fetchClaudeQuota skips on non-JSON and network failures", async () => {
  const path = await credentialsFixture({ accessToken: FAKE_TOKEN });

  const nonJson = await fetchClaudeQuota({
    credentialsPath: path,
    fetchImpl: async () => new Response("<html>", { status: 200 }),
  });
  assert.equal(nonJson.ok, false);
  assert.ok(!nonJson.ok && nonJson.reason.includes("non-JSON"));

  const network = await fetchClaudeQuota({
    credentialsPath: path,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(network.ok, false);
  assert.ok(!network.ok && network.reason.includes("network error"));

  const serverError = await fetchClaudeQuota({
    credentialsPath: path,
    fetchImpl: async () => new Response("", { status: 500 }),
  });
  assert.equal(serverError.ok, false);
  assert.ok(!serverError.ok && serverError.reason.includes("500"));
});

test("fetchClaudeQuota honours an external AbortSignal", async () => {
  const path = await credentialsFixture({
    claudeAiOauth: { accessToken: FAKE_TOKEN },
  });
  const controller = new AbortController();

  const pending = fetchClaudeQuota({
    credentialsPath: path,
    signal: controller.signal,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }),
  });

  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("timed out"));
});
