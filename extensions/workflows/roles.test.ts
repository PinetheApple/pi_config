/**
 * The role setup hook: in-house agent definitions win for a matching workflow
 * role, and only ever narrow what the package already prepared.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentSetup } from "../shared/workflow-transport.ts";
import {
  DEFAULT_AGENT_DEFS_DIR,
  loadAgentDefinitions,
} from "../subagents/src/agent-defs.ts";
import { createRoleSetupHook } from "./src/roles.ts";

function agentsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-roles-"));
  fs.mkdirSync(path.join(dir, "_shared"));
  fs.writeFileSync(
    path.join(dir, "_shared", "base.md"),
    "Shared doctrine for every engineer.",
  );
  fs.writeFileSync(
    path.join(dir, "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Reviews a diff.",
      "tools: Read, Grep, Task",
      "---",
      "You review code. First read `_shared/base.md`.",
    ].join("\n"),
  );
  return dir;
}

function hookFor(agentsDirs: string | readonly string[]) {
  const roles = createRoleSetupHook();
  roles.load(loadAgentDefinitions(agentsDirs));
  return roles;
}

function setup(role: string | undefined, tools: string[]): AgentSetup {
  return {
    options: role === undefined ? {} : { role },
    sessionInput: { tools, systemPromptAppend: "package persona" },
  };
}

test("an in-house definition replaces the prompt and narrows the tools", (t) => {
  const dir = agentsFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const roles = hookFor(dir);
  assert.deepEqual(roles.roleNames(), ["reviewer"]);
  // Claude's Task tool has no pi equivalent and is refused, not silently kept.
  assert.ok(
    roles.warningsFor("reviewer").some((warning) => warning.includes("Task")),
  );

  const agent = setup("reviewer", ["read", "grep", "rg", "write", "bash"]);
  roles.hook.setup(agent);

  assert.match(agent.sessionInput.systemPrompt ?? "", /You review code/);
  assert.match(agent.sessionInput.systemPrompt ?? "", /Shared doctrine/);
  assert.equal(agent.sessionInput.systemPromptAppend, "");
  assert.deepEqual(agent.sessionInput.tools, ["read", "grep", "rg"]);
});

test("unknown and absent roles are left to the workflow package", (t) => {
  const dir = agentsFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roles = hookFor(dir);

  for (const role of ["scout", undefined]) {
    const agent = setup(role, ["read", "write"]);
    roles.hook.setup(agent);
    assert.equal(agent.sessionInput.systemPrompt, undefined);
    assert.equal(agent.sessionInput.systemPromptAppend, "package persona");
    assert.deepEqual(agent.sessionInput.tools, ["read", "write"]);
  }
});

test("a role's warnings surface once, at first use, not at load", () => {
  const dir = agentsFixture();
  const roles = hookFor(dir);
  const seen: { role: string; warnings: readonly string[] }[] = [];
  roles.onWarnings((role, warnings) => seen.push({ role, warnings }));

  // Loading alone must be silent.
  assert.equal(seen.length, 0);

  roles.hook.setup(setup("reviewer", ["read"]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, "reviewer");
  assert.ok(seen[0].warnings.some((warning) => warning.includes("Task")));

  // A fan-out on the same role must not repeat itself.
  roles.hook.setup(setup("reviewer", ["read"]));
  roles.hook.setup(setup("reviewer", ["read"]));
  assert.equal(seen.length, 1);

  // An unknown role belongs to the package and warns about nothing.
  roles.hook.setup(setup("scout", ["read"]));
  assert.equal(seen.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Session binding ----------------------------------------------------------

/** A `.claude/agents` layer, optionally with a `_shared/` of its own. */
function projectFixture(agent: string, fragment?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-project-"));
  const dir = path.join(root, ".claude", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${agent}.md`),
    [
      "---",
      `name: ${agent}`,
      "description: Project role.",
      "---",
      "Do project work. First read `_shared/repo.md`.",
    ].join("\n"),
  );
  if (fragment !== undefined) {
    fs.mkdirSync(path.join(dir, "_shared"));
    fs.writeFileSync(path.join(dir, "_shared", "repo.md"), fragment);
  }
  return { root, dir };
}

function withProcessCwd(dir: string, fn: () => void) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(previous);
  }
}

function prompts(roles: ReturnType<typeof createRoleSetupHook>) {
  return roles.roleNames().map((role) => {
    const agent = setup(role, []);
    roles.hook.setup(agent);
    return [role, agent.sessionInput.systemPrompt];
  });
}

function sessionHook(cwd: string, projectTrusted: boolean) {
  const roles = createRoleSetupHook();
  roles.loadForSession({ cwd, projectTrusted });
  return roles;
}

test("roles bind to the session cwd, not the process cwd", (t) => {
  const session = projectFixture("session-scoped-role");
  const other = projectFixture("process-scoped-role");
  t.after(() => {
    fs.rmSync(session.root, { recursive: true, force: true });
    fs.rmSync(other.root, { recursive: true, force: true });
  });

  withProcessCwd(other.root, () => {
    const names = sessionHook(session.root, true).roleNames();
    assert.ok(names.includes("session-scoped-role"));
    assert.ok(!names.includes("process-scoped-role"));
  });
});

test("an untrusted project contributes no roles and no fragments", (t) => {
  const project = projectFixture("untrusted-role", "POISONED DOCTRINE");
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));

  // A role definition is a system prompt, so the trusted case proves the
  // untrusted assertions below are not vacuous.
  const trusted = prompts(sessionHook(project.root, true));
  assert.ok(trusted.some(([role]) => role === "untrusted-role"));
  assert.ok(
    trusted.some(([, prompt]) => /POISONED DOCTRINE/.test(prompt ?? "")),
  );

  const untrusted = prompts(sessionHook(project.root, false));
  assert.ok(!untrusted.some(([role]) => role === "untrusted-role"));
  assert.ok(
    !untrusted.some(([, prompt]) => /POISONED DOCTRINE/.test(prompt ?? "")),
  );
  // Global-only, by construction: the untrusted layer is never searched, so it
  // cannot reach a global role's prompt through `_shared/` either.
  assert.deepEqual(untrusted, prompts(hookFor(DEFAULT_AGENT_DEFS_DIR)));
});

test("a project layer on the search path can rewrite another layer's prompt", (t) => {
  const globalDir = agentsFixture();
  const project = projectFixture("project-role", "POISONED DOCTRINE");
  t.after(() => {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(project.root, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(globalDir, "reviewer.md"),
    [
      "---",
      "name: reviewer",
      "description: Reviews a diff.",
      "---",
      "You review code. First read `_shared/repo.md`.",
    ].join("\n"),
  );

  // Why the trust gate drops the whole layer instead of filtering by
  // sourcePath: the poisoned prompt belongs to the *global* role.
  const layered = prompts(hookFor([globalDir, project.dir]));
  const reviewer = layered.find(([role]) => role === "reviewer");
  assert.match(reviewer?.[1] ?? "", /POISONED DOCTRINE/);
  const globalOnly = prompts(hookFor(globalDir));
  assert.doesNotMatch(
    globalOnly.find(([role]) => role === "reviewer")?.[1] ?? "",
    /POISONED DOCTRINE/,
  );
});
