import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { TerminalSnapshot } from "./src/domain.ts";
import type { TerminalReadModel } from "./src/manager.ts";
import {
  parseTerminalSpawnArgs,
  resolveTerminalCwd,
  type ParsedTerminalSpawn,
} from "./src/spawn-command.ts";
import {
  normalizeTerminalTitle,
  TERMINAL_TITLE_MAX_LENGTH,
} from "./src/title.ts";
import { openTerminalPicker } from "./src/ui/ps.ts";

function parsed(raw: string): ParsedTerminalSpawn {
  const result = parseTerminalSpawnArgs(raw);
  assert.equal(
    result.ok,
    true,
    `expected a parse, got: ${JSON.stringify(result)}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function parseError(raw: string) {
  const result = parseTerminalSpawnArgs(raw);
  assert.equal(result.ok, false, `expected an error for: ${raw}`);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

test("the command body is preserved verbatim after the flags", () => {
  assert.deepEqual(parsed("npm run dev"), {
    command: "npm run dev",
    name: undefined,
    dir: undefined,
  });

  assert.deepEqual(
    parsed(`--name "web dev" --dir ./api  npm run dev -- --port 3000`),
    {
      command: "npm run dev -- --port 3000",
      name: "web dev",
      dir: "./api",
    },
  );

  // Shell quoting inside the command must reach the shell untouched.
  assert.equal(
    parsed(`sh -c 'while true; do echo "tick  tock"; sleep 1; done'`).command,
    `sh -c 'while true; do echo "tick  tock"; sleep 1; done'`,
  );
});

test("an empty command is a usage message, never a spawn", () => {
  assert.match(parseError(""), /Usage: \/terminal-spawn/);
  assert.match(parseError("   "), /Usage: \/terminal-spawn/);
  assert.match(parseError("--name dev"), /Usage: \/terminal-spawn/);
});

test("bad flags are reported by name", () => {
  assert.match(parseError("--title dev npm start"), /Unknown flag "--title"/);
  assert.match(parseError("--dir"), /Flag "--dir" needs a value/);
});

test("titles derive from the command, collapse whitespace, and are bounded", () => {
  assert.equal(normalizeTerminalTitle("  npm   run \n dev "), "npm run dev");
  assert.equal(normalizeTerminalTitle("  \n\t "), "terminal");
  const long = normalizeTerminalTitle(
    "x".repeat(TERMINAL_TITLE_MAX_LENGTH + 20),
  );
  assert.equal(Array.from(long).length, TERMINAL_TITLE_MAX_LENGTH);
  assert.ok(long.endsWith("…"));
});

test("the cwd is validated before spawning and errors name --dir", () => {
  assert.equal(resolveTerminalCwd(process.cwd(), undefined), process.cwd());
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-spawn-"));
  try {
    assert.equal(resolveTerminalCwd(process.cwd(), real), real);
    assert.throws(
      () => resolveTerminalCwd(process.cwd(), path.join(real, "nope")),
      /--dir is not a directory/,
    );
    const file = path.join(real, "a-file");
    fs.writeFileSync(file, "");
    assert.throws(
      () => resolveTerminalCwd(process.cwd(), file),
      /--dir is not a directory/,
    );
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

// --- Dashboard preselection -------------------------------------------------

function stubView(ids: readonly string[]): TerminalReadModel {
  const snaps = ids.map((id) => ({ id }) as TerminalSnapshot);
  return {
    list: () => snaps,
    get: (id) => snaps.find((snap) => snap.id === id),
    size: () => snaps.length,
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestKill: () => {},
    setOnSettled: () => {},
  };
}

/**
 * Drive the picker's first dashboard: construct it through the real factory,
 * press "confirm", and report which terminal it handed back — i.e. which row
 * the initial selection actually landed on.
 */
function confirmFirstDashboardRow(view: TerminalReadModel) {
  const picks: Array<string | null> = [];
  let opened = 0;

  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      notify: () => {},
      custom: async (
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (value: string | null) => void,
        ) => Component,
      ) => {
        opened++;
        // 1: dashboard (confirm), 2: detail view, 3: dashboard (escape).
        if (opened !== 1) return null;
        let picked: string | null = null;
        // The dashboard owns a 1Hz ticker; dispose clears it so the test exits.
        const component: Component & { dispose?: () => void } = factory(
          { requestRender: () => {} } as unknown as TUI,
          {} as unknown as Theme,
          {
            matches: (_data: string, binding: string) =>
              binding === "tui.select.confirm",
            getKeys: () => [],
          } as unknown as KeybindingsManager,
          (value) => {
            picked = value;
          },
        );
        component.handleInput?.("\r");
        component.dispose?.();
        picks.push(picked);
        return picked;
      },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, picks };
}

test("/terminal-spawn opens the dashboard on the terminal it just started", async () => {
  const view = stubView(["bt-1", "bt-2", "bt-3"]);
  const { ctx, picks } = confirmFirstDashboardRow(view);
  await openTerminalPicker(ctx, view, { initialId: "bt-3" });
  assert.deepEqual(picks, ["bt-3"]);
});

test("/ps keeps starting on the first row when no id is passed", async () => {
  const view = stubView(["bt-1", "bt-2", "bt-3"]);
  const { ctx, picks } = confirmFirstDashboardRow(view);
  await openTerminalPicker(ctx, view);
  assert.deepEqual(picks, ["bt-1"]);
});

test("a preselected id that is already gone falls back to the first row", async () => {
  const view = stubView(["bt-1", "bt-2"]);
  const { ctx, picks } = confirmFirstDashboardRow(view);
  await openTerminalPicker(ctx, view, { initialId: "bt-9" });
  assert.deepEqual(picks, ["bt-1"]);
});
