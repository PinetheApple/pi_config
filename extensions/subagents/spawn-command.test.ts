import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  deriveSpawnTitle,
  parseSpawnCommandArgs,
  type ParsedSpawnCommand,
} from "./src/spawn-command.ts";
import {
  buildSpawnTask,
  type SpawnParentContext,
  SUBAGENT_TITLE_MAX_LENGTH,
} from "./src/spawn.ts";

function parsed(raw: string): ParsedSpawnCommand {
  const result = parseSpawnCommandArgs(raw);
  assert.equal(
    result.ok,
    true,
    `expected a parse, got: ${JSON.stringify(result)}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function parseError(raw: string) {
  const result = parseSpawnCommandArgs(raw);
  assert.equal(result.ok, false, `expected an error for: ${raw}`);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

function parentContext(cwd: string) {
  return {
    cwd,
    model: { provider: "anthropic", id: "claude-opus-4-5" },
    modelRegistry: {},
    isProjectTrusted: () => true,
  } as unknown as SpawnParentContext;
}

test("the full flag form parses into an explicit config", () => {
  assert.deepEqual(
    parsed(
      "--harness codex --model gpt-5-codex --effort high --dir ./src --name 'Audit auth' review the login flow",
    ),
    {
      harness: "codex",
      model: "gpt-5-codex",
      effort: "high",
      dir: "./src",
      name: "Audit auth",
      prompt: "review the login flow",
    },
  );
});

test("the prompt keeps its spacing and any flag-looking text inside it", () => {
  assert.equal(
    parsed("--harness pi   check   the  --force path of deploy.sh").prompt,
    "check   the  --force path of deploy.sh",
  );
  assert.equal(parsed("").prompt, undefined);
  assert.equal(parsed("   ").prompt, undefined);
  assert.deepEqual(parsed("just a prompt"), {
    harness: undefined,
    model: undefined,
    effort: undefined,
    dir: undefined,
    name: undefined,
    prompt: "just a prompt",
  });
});

test("quoted flag values survive as one argument", () => {
  const value = parsed(`--name "Fix the  flaky test" --dir "/tmp/my dir" go`);
  assert.equal(value.name, "Fix the  flaky test");
  assert.equal(value.dir, "/tmp/my dir");
  assert.equal(value.prompt, "go");
});

test("bad flags are reported by name and never silently ignored", () => {
  assert.match(parseError("--agent pi hello"), /Unknown flag "--agent"/);
  assert.match(parseError("--model"), /Flag "--model" needs a value/);
  assert.match(
    parseError("--harness gemini hello"),
    /Unknown --harness "gemini".*pi, claude, codex/s,
  );
  assert.match(
    parseError("--effort turbo hello"),
    /Unknown --effort "turbo".*minimal/s,
  );
});

test("deriveSpawnTitle uses the first prompt line and bounds it", () => {
  assert.equal(
    deriveSpawnTitle("\n  Fix   the parser \nrest"),
    "Fix the parser",
  );
  assert.equal(deriveSpawnTitle("  \n "), "subagent");
  assert.equal(deriveSpawnTitle("x".repeat(200)).length, 60);
});

test("buildSpawnTask validates the directory and names the caller's flag", () => {
  const ctx = parentContext(process.cwd());
  assert.throws(
    () =>
      buildSpawnTask(
        { prompt: "p", title: "t", workingDir: "./definitely-not-here" },
        ctx,
        undefined,
      ),
    /working_dir is not a directory/,
  );
  assert.throws(
    () =>
      buildSpawnTask(
        {
          prompt: "p",
          title: "t",
          workingDir: "./definitely-not-here",
          workingDirLabel: "--dir",
        },
        ctx,
        undefined,
      ),
    /--dir is not a directory/,
  );
});

test("buildSpawnTask inherits parent model, effort, and trust by default", () => {
  const cwd = process.cwd();
  const task = buildSpawnTask(
    { prompt: "p", title: "  a   title  " },
    parentContext(cwd),
    "high",
  );

  assert.equal(task.cwd, cwd);
  assert.equal(task.title, "a title");
  assert.equal(task.model, undefined);
  assert.equal(task.reasoningEffort, undefined);
  assert.equal(task.parent.parentCwd, cwd);
  assert.equal(task.parent.projectTrusted, true);
  assert.equal(task.parent.inheritedThinkingLevel, "high");
  assert.deepEqual(task.parent.inheritedModel, {
    provider: "anthropic",
    id: "claude-opus-4-5",
  });
});

test("an overlong title is bounded and an empty one falls back", () => {
  const ctx = parentContext(process.cwd());
  const long = buildSpawnTask(
    { prompt: "p", title: "x".repeat(SUBAGENT_TITLE_MAX_LENGTH + 40) },
    ctx,
    undefined,
  );
  assert.equal(Array.from(long.title).length, SUBAGENT_TITLE_MAX_LENGTH);
  assert.equal(
    buildSpawnTask({ prompt: "p", title: " \n " }, ctx, undefined).title,
    "subagent",
  );
});

test("an alternate, untrusted directory does not inherit parent trust", () => {
  const parentCwd = process.cwd();
  const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-spawn-"));
  try {
    const task = buildSpawnTask(
      { prompt: "p", title: "t", workingDir: childCwd },
      parentContext(parentCwd),
      undefined,
    );
    assert.equal(task.cwd, fs.realpathSync(childCwd));
    assert.equal(task.parent.projectTrusted, false);
  } finally {
    fs.rmSync(childCwd, { recursive: true, force: true });
  }
});
