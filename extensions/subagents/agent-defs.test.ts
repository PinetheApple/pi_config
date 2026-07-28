import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  applyToolDenylist,
  formatAgentCatalog,
  loadAgentDefinitions,
  mapClaudeToolsToPi,
  parseAgentDefinition,
  prefixWithSystemPrompt,
  resolveAgentForHarness,
  resolvePiModelAlias,
  SHARED_FRAGMENT_DIR,
} from "./src/agent-defs.ts";
import { CHILD_EXCLUDED_TOOL_NAMES } from "./src/domain.ts";
import {
  buildSpawnTask,
  resolveSpawnAgent,
  type SpawnParentContext,
} from "./src/spawn.ts";

const REVIEWER = `---
name: design-reviewer
description: >-
  Verifies a frontend change by rendering it
  in a real browser.
tools: Read, Grep, Glob, Bash, mcp__playwright
model: sonnet
color: magenta
---

You are a design reviewer.

**First, read \`~/.config/ai/agents/${SHARED_FRAGMENT_DIR}/engineer-base.md\` and follow it.**
`;

const RESEARCHER = `---
name: "researcher"
description: "Researches things."
tools: Read, WebSearch, WebFetch
model: opus
memory: user
---

You are a researcher.
`;

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-defs-"));
  fs.mkdirSync(path.join(dir, SHARED_FRAGMENT_DIR));
  fs.writeFileSync(
    path.join(dir, SHARED_FRAGMENT_DIR, "engineer-base.md"),
    "# Engineer Base\n\nShip working code.\n",
  );
  fs.writeFileSync(path.join(dir, "design-reviewer.md"), REVIEWER);
  fs.writeFileSync(path.join(dir, "researcher.md"), RESEARCHER);
  fs.writeFileSync(path.join(dir, "not-an-agent.md"), "no frontmatter here");
  return dir;
}

function parse(dir: string, file: string) {
  const sourcePath = path.join(dir, file);
  return parseAgentDefinition({
    content: fs.readFileSync(sourcePath, "utf8"),
    sourcePath,
    agentsDir: dir,
  });
}

const registry = {
  getAll: () => [
    { provider: "opencode-go", id: "deepseek-v4-pro" },
    { provider: "anthropic", id: "claude-opus-4-5" },
    { provider: "acme", id: "acme-sonnet-2" },
  ],
} as unknown as Parameters<typeof resolvePiModelAlias>[0]["registry"];

// --- Parsing ------------------------------------------------------------------

test("frontmatter scalars, quoted values and folded blocks all parse", () => {
  const dir = fixtureDir();
  const reviewer = parse(dir, "design-reviewer.md");
  assert.ok(reviewer);
  assert.equal(reviewer.name, "design-reviewer");
  assert.equal(
    reviewer.description,
    "Verifies a frontend change by rendering it in a real browser.",
  );
  assert.deepEqual(reviewer.tools, [
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "mcp__playwright",
  ]);
  assert.equal(reviewer.model, "sonnet");

  const researcher = parse(dir, "researcher.md");
  assert.equal(researcher?.name, "researcher");
  assert.equal(researcher?.description, "Researches things.");
});

test("a referenced _shared fragment is inlined into the system prompt", () => {
  const dir = fixtureDir();
  const reviewer = parse(dir, "design-reviewer.md");
  assert.match(reviewer!.systemPrompt, /You are a design reviewer\./);
  assert.match(reviewer!.systemPrompt, /Ship working code\./);
});

test("an agent without a shared reference gets no fragment appended", () => {
  const dir = fixtureDir();
  const researcher = parse(dir, "researcher.md");
  assert.doesNotMatch(researcher!.systemPrompt, /Ship working code\./);
});

test("loading skips _shared and files without frontmatter", () => {
  const defs = loadAgentDefinitions(fixtureDir());
  assert.deepEqual(
    defs.map((def) => def.name),
    ["design-reviewer", "researcher"],
  );
});

test("a missing agents directory yields an empty catalog", () => {
  assert.deepEqual(loadAgentDefinitions("/nonexistent/agents/dir"), []);
});

test("the catalog lists each agent as name and description", () => {
  const catalog = formatAgentCatalog(loadAgentDefinitions(fixtureDir()));
  assert.match(catalog, /^- design-reviewer — Verifies a frontend change/m);
  assert.match(catalog, /^- researcher — Researches things\.$/m);
});

// --- Tool mapping -------------------------------------------------------------

test("Claude tool names map onto pi's vocabulary", () => {
  const mapped = mapClaudeToolsToPi(
    ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebSearch", "WebFetch"],
    "x",
  );
  assert.deepEqual(mapped.tools, [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "rg",
    "find",
    "fd",
    "ls",
    "web_search",
    "web_fetch",
  ]);
  assert.deepEqual(mapped.warnings, []);
});

test("MCP tools are dropped with a warning naming MCP", () => {
  const mapped = mapClaudeToolsToPi(["Read", "mcp__playwright"], "reviewer");
  assert.deepEqual(mapped.tools, ["read"]);
  assert.deepEqual(mapped.warnings, [
    'agent "reviewer": dropped tool mcp__playwright (pi has no MCP support)',
  ]);
});

test("orchestration tools are dropped with a recursion reason", () => {
  for (const name of ["Task", "Agent"]) {
    const mapped = mapClaudeToolsToPi(["Read", name], "planner");
    assert.deepEqual(mapped.tools, ["read"]);
    assert.match(mapped.warnings[0], /cannot spawn further subagents/);
  }
});

test("an unknown tool is dropped rather than silently granted", () => {
  const mapped = mapClaudeToolsToPi(["TodoWrite"], "x");
  assert.deepEqual(mapped.tools, []);
  assert.match(mapped.warnings[0], /no pi equivalent/);
});

test('"*" and an absent tools field both mean no allowlist', () => {
  assert.equal(mapClaudeToolsToPi(["*"], "x").tools, undefined);
  assert.equal(mapClaudeToolsToPi(undefined, "x").tools, undefined);
});

test("the child denylist is applied on top of any allowlist", () => {
  assert.deepEqual(
    applyToolDenylist(
      ["read", "subagent_spawn", "ask_user", "bash"],
      CHILD_EXCLUDED_TOOL_NAMES,
    ),
    ["read", "bash"],
  );
  assert.equal(
    applyToolDenylist(undefined, CHILD_EXCLUDED_TOOL_NAMES),
    undefined,
  );
});

// --- Model aliases --------------------------------------------------------------

test("an alias resolves only inside the session's own provider", () => {
  assert.deepEqual(
    resolvePiModelAlias({
      model: "sonnet",
      registry,
      provider: "acme",
      agentName: "x",
    }),
    { model: "acme/acme-sonnet-2" },
  );
});

test("an unmatched alias falls back to the session default with a warning", () => {
  const resolved = resolvePiModelAlias({
    model: "opus",
    registry,
    provider: "opencode-go",
    agentName: "pi-extension-engineer",
  });
  assert.equal(resolved.model, undefined);
  assert.match(resolved.warning!, /no match in provider "opencode-go"/);
});

test("an alias is never resolved against a provider the session is not using", () => {
  const resolved = resolvePiModelAlias({
    model: "opus",
    registry,
    provider: "opencode-go",
    agentName: "x",
  });
  assert.notEqual(resolved.model, "anthropic/claude-opus-4-5");
});

test("a non-alias model string passes through as a literal hint", () => {
  assert.deepEqual(
    resolvePiModelAlias({
      model: "opencode-go/glm-5.2",
      registry,
      provider: "opencode-go",
      agentName: "x",
    }),
    { model: "opencode-go/glm-5.2" },
  );
});

// --- Harness projection -----------------------------------------------------------

test("the pi harness gets mapped tools, a resolved model, and warnings", () => {
  const definition = parse(fixtureDir(), "design-reviewer.md")!;
  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "pi",
    registry,
    provider: "acme",
    toolDenylist: CHILD_EXCLUDED_TOOL_NAMES,
  });
  assert.deepEqual(spec.tools, [
    "read",
    "grep",
    "rg",
    "find",
    "fd",
    "ls",
    "bash",
  ]);
  assert.equal(spec.model, "acme/acme-sonnet-2");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mcp__playwright/);
});

test("the claude harness keeps the source vocabulary untranslated", () => {
  const definition = parse(fixtureDir(), "design-reviewer.md")!;
  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "claude",
  });
  assert.deepEqual(spec.tools, definition.tools);
  assert.equal(spec.model, "sonnet");
  assert.deepEqual(warnings, []);
});

test("the claude harness still refuses orchestration tools", () => {
  const dir = fixtureDir();
  fs.writeFileSync(
    path.join(dir, "planner.md"),
    "---\nname: planner\ndescription: d\ntools: Read, Agent, Task\n---\n\nPlan.\n",
  );
  const { spec, warnings } = resolveAgentForHarness({
    definition: parse(dir, "planner.md")!,
    harness: "claude",
  });
  assert.deepEqual(spec.tools, ["Read"]);
  assert.equal(warnings.length, 2);
});

test("a long description is bounded at a word boundary", () => {
  const dir = fixtureDir();
  fs.writeFileSync(
    path.join(dir, "verbose.md"),
    `---\nname: verbose\ndescription: ${"word ".repeat(80)}\n---\n\nBody.\n`,
  );
  const description = parse(dir, "verbose.md")!.description;
  assert.ok(description.length <= 241);
  assert.ok(description.endsWith("word…"));
});

test("the codex harness drops tool and alias semantics it cannot express", () => {
  const definition = parse(fixtureDir(), "design-reviewer.md")!;
  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "codex",
  });
  assert.equal(spec.tools, undefined);
  assert.equal(spec.model, undefined);
  assert.equal(warnings.length, 2);
});

test("a system prompt is folded into the prompt for prompt-only harnesses", () => {
  const spec = { name: "x", description: "", systemPrompt: "Be terse." };
  assert.equal(
    prefixWithSystemPrompt("do the thing", spec),
    "Be terse.\n\n---\n\ndo the thing",
  );
  assert.equal(
    prefixWithSystemPrompt("do the thing", undefined),
    "do the thing",
  );
});

// --- Spawn integration --------------------------------------------------------------

const parentCtx = {
  cwd: process.cwd(),
  model: { provider: "acme", id: "acme-sonnet-2" },
  modelRegistry: registry,
  isProjectTrusted: () => true,
} as unknown as SpawnParentContext;

test("resolving a known agent yields a spec projected for the harness", () => {
  const definitions = loadAgentDefinitions(fixtureDir());
  const { spec } = resolveSpawnAgent({
    agentName: "researcher",
    definitions,
    harness: "pi",
    ctx: parentCtx,
  });
  assert.equal(spec?.name, "researcher");
  assert.deepEqual(spec?.tools, ["read", "web_search", "web_fetch"]);
});

test("an unknown agent name is a hard error listing what is available", () => {
  assert.throws(
    () =>
      resolveSpawnAgent({
        agentName: "nope",
        definitions: loadAgentDefinitions(fixtureDir()),
        harness: "pi",
        ctx: parentCtx,
      }),
    /Unknown agent "nope"\. Available: design-reviewer, researcher\./,
  );
});

test("an explicit spawn model outranks the agent's declared default", () => {
  const { spec } = resolveSpawnAgent({
    agentName: "researcher",
    definitions: loadAgentDefinitions(fixtureDir()),
    harness: "claude",
    ctx: parentCtx,
  });
  const withOverride = buildSpawnTask(
    { prompt: "p", title: "t", model: "haiku", agent: spec },
    parentCtx,
    undefined,
  );
  assert.equal(withOverride.model, "haiku");
  const withoutOverride = buildSpawnTask(
    { prompt: "p", title: "t", agent: spec },
    parentCtx,
    undefined,
  );
  assert.equal(withoutOverride.model, "opus");
  assert.equal(withoutOverride.agent?.name, "researcher");
});

test("no agent name means no spec and no warnings", () => {
  assert.deepEqual(
    resolveSpawnAgent({
      agentName: undefined,
      definitions: [],
      harness: "pi",
      ctx: parentCtx,
    }),
    { warnings: [] },
  );
});
