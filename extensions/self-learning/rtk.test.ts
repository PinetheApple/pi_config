import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, CommandRunner } from "./src/exec.ts";
import {
  headCommand,
  isExcluded,
  parseExcludedCommands,
  parseRtkRewrite,
  rewriteWithRtk,
} from "./src/rtk.ts";

const REAL_CONFIG_HOOKS_SECTION = [
  "[hooks]",
  "# rg -> `rtk grep` is a broken mapping: exits 0 on error.",
  '# diff -> observed reporting "Files are identical" for differing files.',
  'exclude_commands = ["rg", "diff"]',
  "transparent_prefixes = []",
].join("\n");

function stubRunner(result: Partial<CommandResult>) {
  const calls: { command: string; args: string[]; stdin?: string }[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, stdin: options.stdin });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

function rewriteResponse(command: string) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecisionReason: "RTK auto-rewrite",
      updatedInput: { command },
    },
  });
}

test("the exclusion list is read from the real config layout", () => {
  assert.deepEqual(parseExcludedCommands(REAL_CONFIG_HOOKS_SECTION), [
    "rg",
    "diff",
  ]);
});

test("a multi-line exclusion array is parsed", () => {
  const config = 'exclude_commands = [\n  "rg",\n  "diff",\n]';
  assert.deepEqual(parseExcludedCommands(config), ["rg", "diff"]);
});

test("a missing, empty, or commented-out list yields no exclusions", () => {
  assert.deepEqual(parseExcludedCommands("[hooks]\n"), []);
  assert.deepEqual(parseExcludedCommands("exclude_commands = []"), []);
  assert.deepEqual(parseExcludedCommands('# exclude_commands = ["rg"]'), []);
});

test("the head command is the first token, basenamed", () => {
  assert.equal(headCommand("  rg --glob '**/*.md' foo "), "rg");
  assert.equal(headCommand("/usr/bin/diff a b"), "diff");
  assert.equal(headCommand(""), "");
});

test("excluded commands are matched on the head only", () => {
  const excluded = ["rg", "diff"];
  assert.equal(isExcluded("rg foo .", excluded), true);
  assert.equal(isExcluded("diff a b", excluded), true);
  assert.equal(isExcluded("git status", excluded), false);
  assert.equal(isExcluded("git diff HEAD", excluded), false);
});

test("an excluded command never reaches rtk", async () => {
  const { run, calls } = stubRunner({
    stdout: rewriteResponse("rtk grep foo"),
  });
  const rewritten = await rewriteWithRtk(run, "rg --glob '*.md' foo", "/repo", [
    "rg",
    "diff",
  ]);
  assert.equal(rewritten, undefined);
  assert.deepEqual(calls, []);
});

test("a non-excluded command is rewritten from rtk's hook response", async () => {
  const { run, calls } = stubRunner({
    stdout: rewriteResponse("rtk git status"),
  });
  const rewritten = await rewriteWithRtk(run, "git status", "/repo", ["rg"]);
  assert.equal(rewritten, "rtk git status");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["hook", "claude"]);
  assert.deepEqual(JSON.parse(calls[0].stdin ?? ""), {
    tool_name: "Bash",
    tool_input: { command: "git status" },
    cwd: "/repo",
  });
});

test("rtk staying silent leaves the command alone", async () => {
  const { run } = stubRunner({ stdout: "" });
  assert.equal(await rewriteWithRtk(run, "echo hi", "/repo", []), undefined);
});

test("an unchanged rewrite is treated as no rewrite", async () => {
  const { run } = stubRunner({ stdout: rewriteResponse("git status") });
  assert.equal(await rewriteWithRtk(run, "git status", "/repo", []), undefined);
});

test("a failing or unparseable rtk invocation leaves the command alone", async () => {
  const failed = stubRunner({ code: 127, stdout: rewriteResponse("rtk ls") });
  assert.equal(await rewriteWithRtk(failed.run, "ls", "/repo", []), undefined);

  const garbage = stubRunner({ stdout: "not json" });
  assert.equal(await rewriteWithRtk(garbage.run, "ls", "/repo", []), undefined);
});

test("a response without an updated command is ignored", () => {
  assert.equal(parseRtkRewrite("{}"), undefined);
  assert.equal(
    parseRtkRewrite(JSON.stringify({ hookSpecificOutput: {} })),
    undefined,
  );
  assert.equal(parseRtkRewrite(rewriteResponse("rtk ls")), "rtk ls");
});

test("a blank command is never sent to rtk", async () => {
  const { run, calls } = stubRunner({ stdout: rewriteResponse("rtk x") });
  assert.equal(await rewriteWithRtk(run, "   ", "/repo", []), undefined);
  assert.deepEqual(calls, []);
});
