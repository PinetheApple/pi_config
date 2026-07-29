import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PERMISSION_MODES,
  PERMISSION_MODE_LABELS,
  cyclePermissionMode,
  type PermissionMode,
} from "../shared/permission-modes.ts";
import { formatPermissionStatus, type StatusTheme } from "./src/status.ts";

/** Marks up the parts the real theme would paint, so tests can read them back. */
const stubTheme: StatusTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<b>${text}</b>`,
};

const colorOf = (mode: PermissionMode) =>
  formatPermissionStatus(stubTheme, mode).match(/^<([a-z]+)>/)?.[1];

const iconOf = (mode: PermissionMode) =>
  formatPermissionStatus(stubTheme, mode)
    .replace(/<[^>]+>/g, "")
    .trim()[0];

// --- footer rendering ------------------------------------------------------------

test("every mode renders with its label, a distinct icon and a colour", () => {
  const icons = new Set<string | undefined>();
  for (const mode of PERMISSION_MODES) {
    const rendered = formatPermissionStatus(stubTheme, mode);
    assert.ok(
      rendered.includes(PERMISSION_MODE_LABELS[mode]),
      `${mode} lost its label`,
    );
    assert.ok(colorOf(mode), `${mode} was not coloured`);
    icons.add(iconOf(mode));
  }
  assert.equal(icons.size, PERMISSION_MODES.length, "icons are not distinct");
});

test("bypassPermissions is the loudest mode, and nothing else shouts", () => {
  assert.equal(colorOf("bypassPermissions"), "error");
  assert.match(
    formatPermissionStatus(stubTheme, "bypassPermissions"),
    /<b>/,
    "the dangerous mode must be bold",
  );
  for (const mode of PERMISSION_MODES) {
    if (mode === "bypassPermissions") continue;
    assert.notEqual(colorOf(mode), "error", `${mode} must not read as danger`);
    assert.doesNotMatch(formatPermissionStatus(stubTheme, mode), /<b>/);
  }
});

test("the safe modes read cooler than the writing one", () => {
  assert.equal(colorOf("plan"), "accent");
  assert.equal(colorOf("default"), "muted");
  assert.equal(colorOf("acceptEdits"), "warning");
});

// --- cycling is silent -----------------------------------------------------------

interface Recorded {
  statuses: (string | undefined)[];
  notifications: string[];
  cycle: () => void;
  runCommand: (args: string) => Promise<void>;
}

/**
 * Boots the extension against a stub host and hands back the two shortcut/command
 * entry points, so the test can drive them the way the TUI does.
 */
async function bootExtension(agentDir: string): Promise<Recorded> {
  const statuses: (string | undefined)[] = [];
  const notifications: string[] = [];
  const ctx = {
    cwd: agentDir,
    hasUI: true,
    ui: {
      setStatus: (_key: string, text?: string) => statuses.push(text),
      notify: (message: string) => notifications.push(message),
      theme: stubTheme,
    },
    sessionManager: {
      getSessionFile: () => path.join(agentDir, "session.jsonl"),
      getEntries: () => [],
    },
  };

  let sessionStart: ((event: unknown, c: typeof ctx) => void) | undefined;
  let shortcut: ((c: typeof ctx) => void) | undefined;
  let command: ((args: string, c: typeof ctx) => Promise<void>) | undefined;

  const pi = {
    on: (name: string, handler: (event: unknown, c: typeof ctx) => void) => {
      if (name === "session_start") sessionStart = handler;
    },
    registerShortcut: (
      _key: string,
      spec: { handler: (c: typeof ctx) => void },
    ) => {
      shortcut ??= spec.handler;
    },
    registerCommand: (
      _name: string,
      spec: { handler: (args: string, c: typeof ctx) => Promise<void> },
    ) => {
      command = spec.handler;
    },
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  const extension = (await import("./index.ts")).default;
  extension(pi);
  assert.ok(sessionStart, "no session_start handler");
  assert.ok(shortcut, "no cycle shortcut");
  assert.ok(command, "no /permissions command");
  const cycle = shortcut;
  const runCommand = command;
  sessionStart({ reason: "startup" }, ctx);

  return {
    statuses,
    notifications,
    cycle: () => cycle(ctx),
    runCommand: (args: string) => runCommand(args, ctx),
  };
}

function withAgentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-"));
  fs.writeFileSync(
    path.join(dir, "permissions.json"),
    JSON.stringify({ permissions: { defaultMode: "default" } }),
  );
  return dir;
}

test("cycling the mode updates the footer and says nothing else", async () => {
  const dir = withAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const app = await bootExtension(dir);
    const start = app.statuses.length;

    app.cycle();
    app.cycle();

    assert.equal(app.statuses.length, start + 2, "the footer must follow");
    assert.deepEqual(app.notifications, [], "cycling must not notify");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the footer text after a cycle is the mode the cycle landed on", async () => {
  const dir = withAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const app = await bootExtension(dir);
    const before = app.statuses[app.statuses.length - 1];
    assert.equal(before, formatPermissionStatus(stubTheme, "default"));

    app.cycle();

    assert.equal(
      app.statuses[app.statuses.length - 1],
      formatPermissionStatus(stubTheme, cyclePermissionMode("default")),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit /permissions invocation still reports, exactly once", async () => {
  const dir = withAgentDir();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const app = await bootExtension(dir);

    await app.runCommand("");
    assert.equal(app.notifications.length, 1);
    assert.match(app.notifications[0], /Mode: /);

    await app.runCommand("plan");
    assert.equal(app.notifications.length, 2);
    assert.equal(
      app.notifications[1],
      `Permission mode: ${PERMISSION_MODE_LABELS.plan}`,
    );

    app.cycle();
    assert.equal(app.notifications.length, 2, "cycling stays silent after use");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
