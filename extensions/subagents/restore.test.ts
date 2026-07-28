/**
 * Subagent restoration: persisted `subagent-record` entries -> terminal,
 * inert manager entries after a resume/fork/reload.
 *
 * Driven through the same seam the extension uses (`manager.adopt` on a real
 * ManagedRuntime with the stub backend registry), not through internals.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "./src/domain.ts";
import { MAX_TRACKED } from "./src/manager.ts";
import {
  buildSubagentRecord,
  collectSubagentRecords,
  createRecordWriter,
  type SubagentRecord,
  SUBAGENT_RECORD_TYPE,
} from "./src/record.ts";
import { loadRestoredTranscript } from "./src/restore-transcript.ts";
import { runTool } from "./src/runtime.ts";
import { task, withManager } from "./test-harness.ts";

let entrySeq = 0;

function customEntry(customType: string, data: unknown, at = 0): SessionEntry {
  entrySeq += 1;
  return {
    type: "custom",
    id: `e${entrySeq}`,
    parentId: null,
    timestamp: new Date(1_700_000_000_000 + at).toISOString(),
    customType,
    data,
  };
}

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    v: 1,
    id: "sa-1",
    origin: "model",
    title: "research the thing",
    prompt: "go research",
    cwd: "/tmp/project",
    backend: "claude",
    status: "done",
    modelLabel: "claude/sonnet",
    sessionFilePath: "/tmp/child.jsonl",
    createdAt: 1_000,
    settledAt: 2_000,
    finalText: "the answer",
    ...overrides,
  };
}

// --- collection ---------------------------------------------------------------

test("collect keeps the last record per id and folds in legacy btw results", () => {
  const entries = [
    customEntry(SUBAGENT_RECORD_TYPE, record({ status: "running" }), 1),
    customEntry("message", { role: "user" }, 2),
    customEntry(
      SUBAGENT_RECORD_TYPE,
      record({ status: "done", finalText: "final", settledAt: 5_000 }),
      3,
    ),
    customEntry(
      "btw-result",
      {
        id: "btw-1",
        title: "side question",
        status: "done",
        prompt: "what is it",
        answer: "42",
        sessionFilePath: "/tmp/btw.jsonl",
      },
      4,
    ),
    customEntry("some-other-extension", { id: "sa-1" }, 5),
  ];

  const records = collectSubagentRecords(entries, MAX_TRACKED);
  assert.deepEqual(
    records.map((r) => [r.id, r.status, r.finalText]),
    [
      ["sa-1", "done", "final"],
      ["btw-1", "done", "42"],
    ],
  );
  const btw = records.find((r) => r.id === "btw-1");
  assert.equal(btw?.origin, "btw");
  assert.equal(btw?.backend, "pi");
  assert.equal(btw?.sessionFilePath, "/tmp/btw.jsonl");
});

test("collect drops malformed records and caps to the newest limit", () => {
  const entries = [
    customEntry(SUBAGENT_RECORD_TYPE, { id: "sa-0", backend: "nope" }),
    customEntry(SUBAGENT_RECORD_TYPE, "not an object"),
    customEntry(SUBAGENT_RECORD_TYPE, record({ id: "sa-1", settledAt: 10 })),
    customEntry(SUBAGENT_RECORD_TYPE, record({ id: "sa-2", settledAt: 20 })),
    customEntry(SUBAGENT_RECORD_TYPE, record({ id: "sa-3", settledAt: 30 })),
  ];
  assert.deepEqual(
    collectSubagentRecords(entries, 2).map((r) => r.id),
    ["sa-2", "sa-3"],
  );
});

test("a record round-trips through buildSubagentRecord and collect", () => {
  const built = buildSubagentRecord(
    {
      id: "sa-9",
      origin: "model",
      backend: "codex",
      title: "t",
      prompt: "p",
      cwd: "/w",
      status: "error",
      createdAt: 1,
      settledAt: 2,
      errorText: "boom",
      meta: {
        backend: "codex",
        modelLabel: "gpt-5-codex",
        sessionFilePath: "/tmp/rollout.jsonl",
      },
      usage: {},
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "partial",
      turns: 3,
    },
    "partial",
  );
  const [parsed] = collectSubagentRecords(
    [customEntry(SUBAGENT_RECORD_TYPE, JSON.parse(JSON.stringify(built)))],
    MAX_TRACKED,
  );
  assert.deepEqual(parsed, built);
});

// --- writing --------------------------------------------------------------------

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "t",
    prompt: "p",
    cwd: "/w",
    status: "running",
    createdAt: 1,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

test("the record writer emits one entry per meaningful change", () => {
  const written: SubagentRecord[] = [];
  const writer = createRecordWriter({
    append: (r) => written.push(r),
    truncateFinalText: (snap) => snap.finalText.slice(0, 4),
  });

  // No child session file yet: nothing worth restoring.
  writer.write([snapshot()]);
  assert.equal(written.length, 0);

  const withFile = snapshot({ meta: { backend: "pi", sessionFilePath: "/f" } });
  writer.write([withFile]);
  writer.write([withFile]);
  assert.deepEqual(
    written.map((r) => [r.status, r.finalText]),
    [["running", undefined]],
  );

  const settledSnap = snapshot({
    status: "done",
    settledAt: 9,
    finalText: "abcdefgh",
    meta: { backend: "pi", sessionFilePath: "/f" },
  });
  writer.write([settledSnap]);
  writer.write([settledSnap]);
  assert.deepEqual(
    written.map((r) => [r.status, r.finalText]),
    [
      ["running", undefined],
      ["done", "abcd"],
    ],
  );

  // Restored entries are never written back.
  writer.write([snapshot({ id: "sa-2", status: "done", restored: true })]);
  assert.equal(written.length, 2);
});

test("seeding the writer from records suppresses a rewrite on restore", () => {
  const written: SubagentRecord[] = [];
  const writer = createRecordWriter({
    append: (r) => written.push(r),
    truncateFinalText: (snap) => snap.finalText,
  });
  const persisted = record({ sessionFilePath: "/f" });
  writer.seed([persisted]);
  writer.write([
    snapshot({
      id: persisted.id,
      status: "done",
      settledAt: persisted.settledAt,
      meta: {
        backend: "pi",
        sessionFilePath: "/f",
        modelLabel: persisted.modelLabel,
      },
      finalText: "the answer",
    }),
  ]);
  assert.deepEqual(written, []);
});

// --- adoption -------------------------------------------------------------------

test("adopt inserts terminal restored entries", async () => {
  await withManager(async (manager, runtime) => {
    let notified = 0;
    manager.view.subscribe(() => {
      notified += 1;
    });

    const adopted = await runTool(
      runtime,
      manager.adopt([record({ id: "sa-1" }), record({ id: "btw-2" })]),
    );
    assert.equal(adopted, 2);
    assert.equal(notified, 1, "adoption notifies listeners exactly once");

    const snap = manager.view.get("sa-1");
    assert.ok(snap);
    assert.equal(snap.restored, true);
    assert.equal(snap.status, "done");
    assert.equal(snap.finalText, "the answer");
    assert.equal(snap.meta.sessionFilePath, "/tmp/child.jsonl");
    assert.equal(snap.meta.modelLabel, "claude/sonnet");
    assert.deepEqual(
      manager.view.list().map((s) => s.id),
      ["sa-1", "btw-2"],
    );
  });
});

test("adopt never re-delivers results to the parent", async () => {
  await withManager(async (manager, runtime) => {
    const settled: string[] = [];
    manager.view.setOnSettled((snap) => settled.push(snap.id));
    await runTool(runtime, manager.adopt([record({ id: "sa-1" })]));
    assert.deepEqual(settled, []);
  });
});

test("a record still marked running is adopted as terminally failed", async () => {
  await withManager(async (manager, runtime) => {
    await runTool(
      runtime,
      manager.adopt([
        record({ id: "sa-1", status: "running", settledAt: undefined }),
      ]),
    );
    const snap = manager.view.get("sa-1");
    assert.equal(snap?.status, "error");
    assert.match(snap?.errorText ?? "", /did not survive the session exit/);
    assert.ok(snap?.settledAt, "elapsed time must not tick forever");
  });
});

test("adopt is idempotent and skips ids already tracked", async () => {
  await withManager(async (manager, runtime) => {
    await runTool(runtime, manager.adopt([record({ id: "sa-1" })]));
    const again = await runTool(
      runtime,
      manager.adopt([
        record({ id: "sa-1", title: "clobbered" }),
        record({ id: "sa-2" }),
      ]),
    );
    assert.equal(again, 1);
    assert.equal(manager.view.get("sa-1")?.title, "research the thing");
    assert.equal(manager.view.size(), 2);
  });
});

test("adoption is capped at MAX_TRACKED, newest first", async () => {
  await withManager(async (manager, runtime) => {
    const records = Array.from({ length: MAX_TRACKED + 5 }, (_, i) =>
      record({ id: `sa-${i + 1}`, settledAt: 1_000 + i }),
    );
    const adopted = await runTool(runtime, manager.adopt(records));
    assert.equal(adopted, MAX_TRACKED);
    assert.equal(manager.view.get("sa-1"), undefined, "oldest dropped");
    assert.ok(manager.view.get(`sa-${MAX_TRACKED + 5}`), "newest kept");
  });
});

// --- id collision ----------------------------------------------------------------

test("a spawn after adopt does not reuse an adopted id", async () => {
  await withManager(async (manager, runtime) => {
    await runTool(
      runtime,
      manager.adopt([
        record({ id: "sa-1" }),
        record({ id: "sa-3" }),
        record({ id: "btw-2", origin: "btw" }),
      ]),
    );

    const spawned = await runTool(
      runtime,
      manager.spawn("codex", task("fresh work")),
    );
    assert.equal(spawned.id, "sa-4");
    assert.ok(manager.view.get("sa-3")?.restored);

    const aside = await runTool(
      runtime,
      manager.spawn("codex", { ...task("aside"), origin: "btw" }),
    );
    assert.equal(aside.id, "btw-3");
  });
});

test("ids dropped by the MAX_TRACKED cap still seed the counters", async () => {
  await withManager(async (manager, runtime) => {
    const records = Array.from({ length: MAX_TRACKED + 3 }, (_, i) =>
      record({ id: `sa-${i + 1}`, settledAt: 1_000 + i }),
    );
    await runTool(runtime, manager.adopt(records));
    const spawned = await runTool(runtime, manager.spawn("codex", task("go")));
    assert.equal(spawned.id, `sa-${MAX_TRACKED + 4}`);
  });
});

// --- restored entries are inert ---------------------------------------------------

test("restored entries do not consume running slots", async () => {
  await withManager(async (manager, runtime) => {
    await runTool(
      runtime,
      manager.adopt(
        Array.from({ length: 8 }, (_, i) => record({ id: `sa-${i + 1}` })),
      ),
    );
    // MAX_RUNNING is 4; if restored entries counted, this would reject.
    for (let i = 0; i < 4; i++) {
      await runTool(runtime, manager.spawn("codex", task(`Task ${i}`)));
    }
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("fifth"))),
      /Max 4 subagents/,
    );
  });
});

test("a restored entry cannot be steered or aborted", async () => {
  await withManager(async (manager, runtime) => {
    await runTool(runtime, manager.adopt([record({ id: "sa-1" })]));

    await assert.rejects(
      runTool(runtime, manager.send("sa-1", "keep going")),
      /restored from an earlier session/,
    );

    // Fire-and-forget paths must be silent no-ops, not throws.
    manager.view.requestSend("sa-1", "keep going");
    manager.view.requestAbort("sa-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.view.get("sa-1")?.status, "done");
  });
});

test("forget drops a restored entry without touching its transcript file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-restore-"));
  const file = path.join(dir, "child.jsonl");
  fs.writeFileSync(file, "{}\n");
  try {
    await withManager(async (manager, runtime) => {
      await runTool(
        runtime,
        manager.adopt([record({ id: "sa-1", sessionFilePath: file })]),
      );
      manager.view.requestForget("sa-1");
      assert.equal(manager.view.get("sa-1"), undefined);
      assert.equal(manager.view.size(), 0);
      assert.ok(fs.existsSync(file), "forget is memory-only");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- transcript recovery -----------------------------------------------------------

async function transcriptFor(overrides: Partial<SubagentRecord>) {
  let result!: Awaited<ReturnType<typeof loadRestoredTranscript>>;
  await withManager(async (manager, runtime) => {
    await runTool(runtime, manager.adopt([record(overrides)]));
    const snap = manager.view.get(record(overrides).id);
    assert.ok(snap);
    result = await loadRestoredTranscript(snap);
  });
  return result;
}

test("a pi child transcript is replayed from its real session file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-child-"));
  try {
    // A real file-backed child session, written exactly as the pi backend does.
    const session = SessionManager.create(dir, dir);
    session.appendSessionInfo("subagent: research the thing");
    session.appendMessage({
      role: "user",
      content: "go research",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "looking now" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet",
      usage: {} as never,
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    session.appendMessage({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "file body\nsecond line" }],
      isError: false,
      timestamp: Date.now(),
    });
    const file = session.getSessionFile();
    assert.ok(file, "child session must be file-backed");

    const restored = await transcriptFor({
      backend: "pi",
      sessionFilePath: file,
    });
    assert.match(restored.note, /replayed from/);
    assert.deepEqual(
      restored.items.map((item) => item.kind),
      ["user", "assistant", "toolResult"],
    );
    const [user, assistant, toolResult] = restored.items;
    assert.equal(user.kind === "user" && user.text, "go research");
    assert.deepEqual(
      assistant.kind === "assistant" &&
        assistant.parts.map((part) => part.type),
      ["text", "toolCall"],
    );
    assert.equal(
      toolResult.kind === "toolResult" && toolResult.outputPreview,
      "file body",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing pi transcript falls back to the persisted text", async () => {
  const restored = await transcriptFor({
    backend: "pi",
    sessionFilePath: path.join(os.tmpdir(), "definitely-not-here.jsonl"),
  });
  assert.match(restored.note, /file no longer exists/);
  assert.deepEqual(
    restored.items.map((item) => item.kind),
    ["user", "assistant"],
  );
});

test("non-pi backends show persisted output, not a faked transcript", async () => {
  const restored = await transcriptFor({
    backend: "codex",
    sessionFilePath: "/tmp/rollout.jsonl",
  });
  assert.match(restored.note, /codex transcript not replayed/);
  assert.match(restored.note, /rollout\.jsonl/);
  assert.deepEqual(
    restored.items.map((item) => item.kind),
    ["user", "assistant"],
  );
});
