import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  GIT_INFO_CHANNEL,
  REFRESH_CHANNEL,
  type GitInfoState,
} from "../shared/dashboard-state.ts";
import gitInfo from "./index.ts";

const POLL_INTERVAL_MS = 3_000;

function harness(t: import("node:test").TestContext, cwd: string) {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const published: GitInfoState[] = [];
  let staleReads = 0;
  let stale = false;

  const api = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => handlers.set(event, handler),
    registerCommand: () => {},
    events: {
      on: (channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        return () => {};
      },
      emit: (channel: string, payload: unknown) => {
        if (channel === GIT_INFO_CHANNEL)
          published.push(payload as GitInfoState);
        for (const listener of listeners.get(channel) ?? []) listener(payload);
      },
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    mode: "print",
    hasUI: false,
    get cwd() {
      if (stale) {
        staleReads += 1;
        throw new Error(
          "This extension ctx is stale after session replacement",
        );
      }
      return cwd;
    },
  } as unknown as ExtensionContext;

  gitInfo(api);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));

  const waitForPublish = async (count: number) => {
    for (let tick = 0; tick < 300 && published.length < count; tick += 1) {
      await delay(10);
    }
    assert.ok(published.length >= count, `expected ${count} published states`);
    return published[published.length - 1]!;
  };

  return {
    published,
    waitForPublish,
    staleReads: () => staleReads,
    start: async () => {
      await handlers.get("session_start")?.({}, ctx);
      return waitForPublish(1);
    },
    invalidate: () => {
      stale = true;
    },
    emitRefresh: () => {
      for (const listener of listeners.get(REFRESH_CHANNEL) ?? []) {
        listener(undefined);
      }
    },
  };
}

function tempDir(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "git-info-test-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function detachedRepo(t: import("node:test").TestContext) {
  const dir = tempDir(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q");
  git(
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "root",
  );
  // A detached HEAD keeps the refresh off the `gh pr view` path, so the test
  // never reaches the network.
  git("checkout", "-q", "--detach");
  return dir;
}

test("background refreshes never dereference a replaced session ctx", async (t) => {
  const run = harness(t, tempDir(t));

  await run.start();
  run.invalidate();

  run.emitRefresh();
  await delay(POLL_INTERVAL_MS + 500);

  assert.equal(
    run.staleReads(),
    0,
    "the poll and refresh-channel fibers must not read cwd off the captured ctx",
  );
});

test("refreshes read git state from the session cwd", async (t) => {
  const dir = detachedRepo(t);
  const run = harness(t, dir);

  const initial = await run.start();
  assert.equal(initial.isRepository, true);
  assert.ok(
    initial.branch && /^detached@[0-9a-f]+$/.test(initial.branch),
    `unexpected branch: ${initial.branch}`,
  );
  assert.equal(initial.changedFiles, 0);
  assert.equal(initial.pullRequest, null);

  writeFileSync(join(dir, "untracked.txt"), "x");
  run.emitRefresh();

  for (let tick = 0; tick < 300; tick += 1) {
    if (run.published.at(-1)?.changedFiles === 1) break;
    await delay(10);
  }
  assert.equal(
    run.published.at(-1)?.changedFiles,
    1,
    "the status command ran against the session cwd",
  );
});
