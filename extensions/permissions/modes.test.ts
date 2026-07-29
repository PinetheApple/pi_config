import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  CYCLED_PERMISSION_MODES,
  PERMISSION_MODES,
  cyclePermissionMode,
  effectiveAgentMode,
  isPermissionMode,
  strictestMode,
  type PermissionMode,
} from "../shared/permission-modes.ts";
import {
  childPermissionMode,
  forgetChildPermissionMode,
  registerChildPermissionMode,
  resetChildPermissionModes,
} from "../shared/child-permission-mode.ts";
import { FALLBACK_MODE, loadPermissionConfig } from "./src/config.ts";
import { decide } from "./src/decide.ts";
import {
  modeEntry,
  PERMISSION_MODE_ENTRY,
  restoreMode,
} from "./src/mode-store.ts";

// --- tighten, never loosen -------------------------------------------------------

test("strictestMode picks the narrower mode whichever order it is given", () => {
  assert.equal(strictestMode("plan", "bypassPermissions"), "plan");
  assert.equal(strictestMode("bypassPermissions", "plan"), "plan");
  assert.equal(strictestMode("default", "acceptEdits"), "default");
  assert.equal(strictestMode("acceptEdits", "default"), "default");
  assert.equal(strictestMode("plan", "plan"), "plan");
});

test("a silent agent definition still gets bypassPermissions, whatever the session is", () => {
  assert.equal(
    effectiveAgentMode({ sessionMode: "plan" }),
    "bypassPermissions",
  );
  assert.equal(
    effectiveAgentMode({ sessionMode: "default" }),
    "bypassPermissions",
  );
  assert.equal(effectiveAgentMode({}), "bypassPermissions");
});

test("an explicit agent mode tightens the session mode", () => {
  assert.equal(
    effectiveAgentMode({
      sessionMode: "bypassPermissions",
      definitionMode: "plan",
    }),
    "plan",
  );
  assert.equal(
    effectiveAgentMode({
      sessionMode: "acceptEdits",
      definitionMode: "default",
    }),
    "default",
  );
});

test("an explicit agent mode can never loosen the session mode", () => {
  assert.equal(
    effectiveAgentMode({
      sessionMode: "plan",
      definitionMode: "bypassPermissions",
    }),
    "plan",
  );
  assert.equal(
    effectiveAgentMode({
      sessionMode: "default",
      definitionMode: "acceptEdits",
    }),
    "default",
  );
});

// --- cycling ----------------------------------------------------------------------

test("shift+tab walks the cycle and returns to the start", () => {
  let mode: PermissionMode = CYCLED_PERMISSION_MODES[0];
  const seen: PermissionMode[] = [mode];
  for (let i = 0; i < CYCLED_PERMISSION_MODES.length; i++) {
    mode = cyclePermissionMode(mode);
    seen.push(mode);
  }
  assert.deepEqual(seen, [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
    "default",
  ]);
});

test("the cycle covers every mode, and cycle order is not strictness order", () => {
  assert.deepEqual(
    [...CYCLED_PERMISSION_MODES].sort(),
    [...PERMISSION_MODES].sort(),
  );
  // `plan` is stricter than `default` but is reached after it.
  assert.equal(strictestMode("plan", "default"), "plan");
  assert.equal(cyclePermissionMode("default"), "plan");
});

test("isPermissionMode rejects unknown values", () => {
  assert.equal(isPermissionMode("acceptEdits"), true);
  assert.equal(isPermissionMode("yolo"), false);
  assert.equal(isPermissionMode(undefined), false);
  assert.equal(isPermissionMode("dontAsk"), false);
});

// --- config loading -----------------------------------------------------------------

function fixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-perm-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("rules are read from config, not compiled in", () => {
  const dir = fixture({
    "claude.json": JSON.stringify({
      permissions: { allow: ["Read(/a/**)"], deny: ["Bash"] },
    }),
    "permissions.json": JSON.stringify({
      defaultMode: "plan",
      permissions: { ask: ["Edit"] },
    }),
  });
  try {
    const config = loadPermissionConfig({
      agentDir: dir,
      claudeSettingsPath: path.join(dir, "claude.json"),
    });
    assert.equal(config.mode, "plan");
    assert.equal(config.rules.allow.length, 1);
    assert.equal(config.rules.deny.length, 1);
    assert.equal(config.rules.ask.length, 1);
    assert.equal(config.sources.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("both layers contribute; neither has to exist", () => {
  const dir = fixture({
    "permissions.json": JSON.stringify({ permissions: { allow: ["Read"] } }),
  });
  try {
    const config = loadPermissionConfig({
      agentDir: dir,
      claudeSettingsPath: path.join(dir, "absent.json"),
    });
    assert.equal(config.rules.allow.length, 1);
    assert.equal(config.sources.length, 1);
    assert.equal(config.mode, FALLBACK_MODE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed config contributes no rules instead of taking the gate down", () => {
  const dir = fixture({ "permissions.json": "{ not json" });
  try {
    const config = loadPermissionConfig({
      agentDir: dir,
      claudeSettingsPath: path.join(dir, "absent.json"),
    });
    assert.deepEqual(config.rules.allow, []);
    assert.equal(config.mode, FALLBACK_MODE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown defaultMode falls back rather than being trusted", () => {
  const dir = fixture({
    "permissions.json": JSON.stringify({ defaultMode: "yolo" }),
  });
  try {
    const config = loadPermissionConfig({
      agentDir: dir,
      claudeSettingsPath: path.join(dir, "absent.json"),
    });
    assert.equal(config.mode, FALLBACK_MODE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- persistence ---------------------------------------------------------------------

test("the last recorded mode is restored, and unknown entries are ignored", () => {
  const entries = [
    {
      type: "custom",
      customType: PERMISSION_MODE_ENTRY,
      data: modeEntry("plan"),
    },
    { type: "message" },
    {
      type: "custom",
      customType: PERMISSION_MODE_ENTRY,
      data: modeEntry("acceptEdits"),
    },
    {
      type: "custom",
      customType: "something-else",
      data: { mode: "bypassPermissions" },
    },
  ];
  assert.equal(restoreMode(entries), "acceptEdits");
});

test("a session with no mode entry restores nothing, and a corrupt entry is not trusted", () => {
  assert.equal(restoreMode([{ type: "message" }]), undefined);
  assert.equal(
    restoreMode([
      {
        type: "custom",
        customType: PERMISSION_MODE_ENTRY,
        data: { mode: "yolo" },
      },
    ]),
    undefined,
  );
  assert.equal(
    restoreMode([
      { type: "custom", customType: PERMISSION_MODE_ENTRY, data: null },
    ]),
    undefined,
  );
});

// --- spawned children -------------------------------------------------------

test("a registered child is pinned to its spawner's mode, and a root session is not", () => {
  resetChildPermissionModes();
  registerChildPermissionMode("/sessions/child.jsonl", "bypassPermissions");
  assert.equal(
    childPermissionMode("/sessions/child.jsonl"),
    "bypassPermissions",
  );
  // A root session is unregistered and falls back to config instead.
  assert.equal(childPermissionMode("/sessions/root.jsonl"), undefined);
  assert.equal(childPermissionMode(undefined), undefined);
  resetChildPermissionModes();
});

test("a child registered with a tightened mode keeps it", () => {
  resetChildPermissionModes();
  registerChildPermissionMode("/sessions/child.jsonl", "plan");
  assert.equal(childPermissionMode("/sessions/child.jsonl"), "plan");
  forgetChildPermissionMode("/sessions/child.jsonl");
  assert.equal(childPermissionMode("/sessions/child.jsonl"), undefined);
  resetChildPermissionModes();
});

test("a child under bypassPermissions never reaches an ask, so it cannot fail closed", () => {
  // The pairing that matters: registered mode -> decision for a normal call.
  const mode =
    childPermissionMode("/sessions/absent.jsonl") ?? "bypassPermissions";
  const decision = decide({
    call: { toolName: "bash", input: { command: "npm test" }, cwd: "/w" },
    rules: { allow: [], ask: [], deny: [] },
    mode,
  });
  assert.equal(decision.effect, "allow");
});
