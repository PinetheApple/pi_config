import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  agentDefsSearchPath,
  applyToolDenylist,
  DEFAULT_AGENT_DEFS_DIR,
  formatAgentCatalog,
  loadAgentDefinitions,
  loadSessionAgentDefinitions,
  mapClaudeToolsToPi,
  parseAgentDefinition,
  parseHarnessConfig,
  prefixWithSystemPrompt,
  PROJECT_AGENT_DEFS_SUBDIR,
  resolveAgentForHarness,
  resolveHarness,
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

// --- Layered directories --------------------------------------------------------

/** Write an agent layer under one project config root of a fresh temp repo. */
function projectDir(agents: Record<string, string>, configRoot = ".claude") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-project-"));
  const dir = writeAgents(root, configRoot, agents);
  return { root, dir };
}

/** Add another config root to an existing repo, for cross-root cases. */
function writeAgents(
  root: string,
  configRoot: string,
  agents: Record<string, string>,
) {
  const dir = path.join(root, configRoot, PROJECT_AGENT_DEFS_SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(agents)) {
    fs.writeFileSync(path.join(dir, `${name}.md`), content);
  }
  return dir;
}

const RN_ENGINEER = `---
name: rn-engineer
description: Builds React Native screens.
tools: Read, Edit
---

You build React Native screens against SPEC.md.
`;

test("a project agent joins the global catalog", () => {
  const global = fixtureDir();
  const project = projectDir({ "rn-engineer": RN_ENGINEER });
  const defs = loadAgentDefinitions([global, project.dir]);
  assert.deepEqual(
    defs.map((def) => def.name),
    ["design-reviewer", "researcher", "rn-engineer"],
  );
  assert.equal(
    defs.find((def) => def.name === "rn-engineer")?.sourcePath,
    path.join(project.dir, "rn-engineer.md"),
  );
});

test("a JSON-style tools array parses to bare tool names", () => {
  const global = fixtureDir();
  const project = projectDir({
    "code-reviewer":
      '---\nname: code-reviewer\ndescription: Reviews.\ntools: ["Read", "Grep", \'Bash\']\n---\n\nReview it.\n',
  });
  const defs = loadAgentDefinitions([global, project.dir]);
  const reviewer = defs.find((def) => def.name === "code-reviewer");
  assert.deepEqual(reviewer?.tools, ["Read", "Grep", "Bash"]);
  // Quoted names would otherwise be dropped, leaving the child with no tools.
  assert.deepEqual(
    resolveAgentForHarness({ definition: reviewer!, harness: "pi" }).spec.tools,
    ["read", "grep", "rg", "bash"],
  );
});

test("a project agent shadows a global one of the same name", () => {
  const global = fixtureDir();
  const project = projectDir({
    researcher:
      "---\nname: researcher\ndescription: Project researcher.\n---\n\nProject body.\n",
  });
  const defs = loadAgentDefinitions([global, project.dir]);
  const researcher = defs.find((def) => def.name === "researcher");
  assert.equal(researcher?.description, "Project researcher.");
  assert.match(researcher!.systemPrompt, /Project body\./);
  assert.equal(defs.filter((def) => def.name === "researcher").length, 1);
});

test("a project agent inlines a fragment from the global _shared", () => {
  const global = fixtureDir();
  const project = projectDir({
    "audio-core-engineer": `---\nname: audio-core-engineer\ndescription: Owns the audio graph.\n---\n\nRead \`${SHARED_FRAGMENT_DIR}/engineer-base.md\` first.\n`,
  });
  const defs = loadAgentDefinitions([global, project.dir]);
  const engineer = defs.find((def) => def.name === "audio-core-engineer");
  assert.match(engineer!.systemPrompt, /Ship working code\./);
});

test("a project without .claude/agents is a silent no-op", () => {
  const global = fixtureDir();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-empty-"));
  assert.deepEqual(
    loadAgentDefinitions(agentDefsSearchPath(empty)).map((def) => def.name),
    loadAgentDefinitions(DEFAULT_AGENT_DEFS_DIR).map((def) => def.name),
  );
  assert.deepEqual(
    loadAgentDefinitions([global, path.join(empty, "nope")]).map((d) => d.name),
    ["design-reviewer", "researcher"],
  );
});

test("the search path layers every config root over the global one", () => {
  assert.deepEqual(agentDefsSearchPath("/repo"), [
    DEFAULT_AGENT_DEFS_DIR,
    path.join("/repo", ".ai", "agents"),
    path.join("/repo", ".claude", "agents"),
    path.join("/repo", ".agents", "agents"),
    path.join("/repo", ".pi", "agents"),
  ]);
});

/** An agent definition whose body identifies the layer it came from. */
function agentFrom(name: string, layer: string) {
  return `---\nname: ${name}\ndescription: From ${layer}.\n---\n\nBody from ${layer}.\n`;
}

const ROOTS_HIGHEST_FIRST = [".pi", ".agents", ".claude", ".ai"];

/** The project layers of the search path, without the real global catalog. */
const projectLayers = (cwd: string) => agentDefsSearchPath(cwd).slice(1);

test("every project config root contributes its own agents", () => {
  const global = fixtureDir();
  const { root } = projectDir({});
  for (const configRoot of ROOTS_HIGHEST_FIRST) {
    const name = `${configRoot.slice(1)}-agent`;
    writeAgents(root, configRoot, { [name]: agentFrom(name, configRoot) });
  }
  const names = loadAgentDefinitions([global, ...projectLayers(root)]).map(
    (def) => def.name,
  );
  assert.deepEqual(names, [
    "agents-agent",
    "ai-agent",
    "claude-agent",
    "design-reviewer",
    "pi-agent",
    "researcher",
  ]);
});

test("a name declared in several roots collapses to the highest root", () => {
  const global = fixtureDir();
  // Drop one root per pass, so each root gets a turn at being the winner.
  for (let i = 0; i < ROOTS_HIGHEST_FIRST.length; i++) {
    const remaining = ROOTS_HIGHEST_FIRST.slice(i);
    const { root } = projectDir({});
    for (const configRoot of remaining) {
      writeAgents(root, configRoot, { dup: agentFrom("dup", configRoot) });
    }
    const defs = loadAgentDefinitions([global, ...projectLayers(root)]);
    const dup = defs.filter((def) => def.name === "dup");
    assert.equal(dup.length, 1, `duplicated across ${remaining.join(", ")}`);
    assert.equal(dup[0].description, `From ${remaining[0]}.`);
  }
});

// --- Session catalog ------------------------------------------------------------

const SESSION_SCOPED = `---
name: session-scoped-agent
description: Reachable only from its own project.
---

Read \`${SHARED_FRAGMENT_DIR}/engineer-base.md\` first.
`;

const PROCESS_SCOPED = `---
name: process-scoped-agent
description: Sits beside the pi process, not the session.
---

Body.
`;

/** Run `fn` with the process cwd moved away from the session cwd. */
function withProcessCwd(dir: string, fn: () => void) {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(previous);
  }
}

test("the session catalog binds to the session cwd, not the process cwd", () => {
  const session = projectDir({ "session-scoped-agent": SESSION_SCOPED }, ".ai");
  const other = projectDir({ "process-scoped-agent": PROCESS_SCOPED }, ".ai");
  withProcessCwd(other.root, () => {
    const names = loadSessionAgentDefinitions({
      cwd: session.root,
      projectTrusted: true,
    }).map((def) => def.name);
    assert.ok(names.includes("session-scoped-agent"));
    assert.ok(!names.includes("process-scoped-agent"));
  });
});

test("an untrusted session project contributes nothing from any root", () => {
  const session = projectDir({});
  const other = projectDir({ "process-scoped-agent": PROCESS_SCOPED });
  for (const configRoot of ROOTS_HIGHEST_FIRST) {
    const name = `${configRoot.slice(1)}-scoped-agent`;
    const dir = writeAgents(session.root, configRoot, {
      [name]: SESSION_SCOPED,
    });
    // A project fragment is inlined into *global* agents too, so it has to be
    // gated by the same trust check the agent files are.
    fs.mkdirSync(path.join(dir, SHARED_FRAGMENT_DIR), { recursive: true });
    fs.writeFileSync(
      path.join(dir, SHARED_FRAGMENT_DIR, "engineer-base.md"),
      `Injected from ${configRoot}.`,
    );
  }
  withProcessCwd(other.root, () => {
    const defs = loadSessionAgentDefinitions({
      cwd: session.root,
      projectTrusted: false,
    });
    // Global-only: an untrusted `_shared/` must not reach a global agent either.
    assert.deepEqual(defs, loadAgentDefinitions(DEFAULT_AGENT_DEFS_DIR));
  });
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

test("an MCP tool is deferred, not dropped, when the inventory is unknown", () => {
  const mapped = mapClaudeToolsToPi(["Read", "mcp__playwright"], "reviewer");
  assert.deepEqual(mapped.tools, ["read"]);
  assert.deepEqual(mapped.deferredMcpTools, ["mcp__playwright"]);
  assert.deepEqual(mapped.warnings, []);
});

test("an MCP tool maps onto the unified adapter gateway", () => {
  // pi-mcp-adapter's default: one `mcp` proxy over every configured server.
  const mapped = mapClaudeToolsToPi(
    ["Read", "mcp__playwright"],
    "reviewer",
    new Set(["read", "bash", "mcp"]),
  );
  assert.deepEqual(mapped.tools, ["read", "mcp"]);
  assert.equal(mapped.deferredMcpTools, undefined);
  assert.deepEqual(mapped.warnings, []);
});

test("direct MCP tools win over the gateway, most specific first", () => {
  // toolPrefix "mcp" — the adapter can spell names exactly like Claude does.
  assert.deepEqual(
    mapClaudeToolsToPi(
      ["mcp__playwright"],
      "reviewer",
      new Set(["mcp", "mcp__playwright"]),
    ).tools,
    ["mcp__playwright"],
  );
  // toolPrefix "mcp" with per-tool registration.
  assert.deepEqual(
    mapClaudeToolsToPi(
      ["mcp__playwright"],
      "reviewer",
      new Set(["mcp", "mcp__playwright_navigate", "mcp__other_thing"]),
    ).tools,
    ["mcp__playwright_navigate"],
  );
  // Default toolPrefix "server": `<server>_<tool>`.
  assert.deepEqual(
    mapClaudeToolsToPi(
      ["mcp__playwright"],
      "reviewer",
      new Set(["mcp", "playwright_navigate", "playwright_click", "read"]),
    ).tools,
    ["playwright_click", "playwright_navigate"],
  );
});

test("an MCP tool with no adapter at all is dropped, saying which server", () => {
  const mapped = mapClaudeToolsToPi(
    ["Read", "mcp__playwright"],
    "reviewer",
    new Set(["read", "bash"]),
  );
  assert.deepEqual(mapped.tools, ["read"]);
  assert.equal(mapped.warnings.length, 1);
  assert.match(mapped.warnings[0], /dropped tool mcp__playwright/);
  assert.match(mapped.warnings[0], /server "playwright"/);
  assert.match(mapped.warnings[0], /pi-mcp-adapter/);
  // The stale blanket claim must never come back.
  assert.doesNotMatch(mapped.warnings[0], /pi has no MCP support/);
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
  // design-reviewer's whole job is driving a real browser: its MCP tool is
  // carried to the child for resolution, never refused up front.
  assert.deepEqual(spec.deferredMcpTools, ["mcp__playwright"]);
  assert.deepEqual(warnings, []);
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
    { harness: "pi", warnings: [] },
  );
});

// --- The `harness:` block --------------------------------------------------------

/**
 * One definition that has to serve both harnesses: Claude Code reads
 * `name`/`description`/`model` and ignores `harness:`, pi reads `harness.pi`.
 */
const PORTABLE = `---
name: portable
description: Serves both harnesses.
tools: Read, Grep
model: inherit
harness:
  prefer: claude
  claude:
    model: opus
    effort: high
  pi:
    model: opencode-go/deepseek-v4-pro
    effort: medium
---

Be portable.
`;

function writeAgent(dir: string, file: string, content: string) {
  fs.writeFileSync(path.join(dir, file), content);
  return parse(dir, file)!;
}

function portableDir() {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, "portable.md"), PORTABLE);
  return dir;
}

test("the harness block parses prefer, require and per-harness overrides", () => {
  const definition = parse(portableDir(), "portable.md")!;
  assert.equal(definition.harness?.prefer, "claude");
  assert.equal(definition.harness?.required, undefined);
  assert.deepEqual(definition.harness?.overrides, {
    claude: { model: "opus", effort: "high" },
    pi: { model: "opencode-go/deepseek-v4-pro", effort: "medium" },
  });
  assert.deepEqual(definition.harness?.warnings, []);
  // The block must not disturb the fields Claude Code itself reads.
  assert.equal(definition.model, "inherit");
  assert.deepEqual(definition.tools, ["Read", "Grep"]);
  assert.match(definition.systemPrompt, /Be portable\./);
});

test("parseHarnessConfig on no lines is undefined", () => {
  assert.equal(parseHarnessConfig([]), undefined);
  assert.equal(parseHarnessConfig(["   ", ""]), undefined);
});

test("a definition with no harness block behaves exactly as before", () => {
  const definition = parse(fixtureDir(), "design-reviewer.md")!;
  assert.equal(definition.harness, undefined);
  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "pi",
    registry,
    provider: "acme",
    toolDenylist: CHILD_EXCLUDED_TOOL_NAMES,
  });
  assert.equal(spec.model, "acme/acme-sonnet-2");
  assert.equal(spec.reasoningEffort, undefined);
  assert.deepEqual(warnings, []);
  assert.deepEqual(resolveHarness({ definition }), {
    harness: "pi",
    warnings: [],
  });
});

test("pi takes its model and effort from harness.pi", () => {
  const definition = parse(portableDir(), "portable.md")!;
  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "pi",
    registry,
    // The provider that has no "opus": exactly the case that used to warn.
    provider: "opencode-go",
    toolDenylist: CHILD_EXCLUDED_TOOL_NAMES,
  });
  assert.equal(spec.model, "opencode-go/deepseek-v4-pro");
  assert.equal(spec.reasoningEffort, "medium");
  assert.deepEqual(warnings, []);
});

test("claude takes its model and effort from harness.claude", () => {
  const definition = parse(portableDir(), "portable.md")!;
  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "claude",
  });
  assert.equal(spec.model, "opus");
  assert.equal(spec.reasoningEffort, "high");
  assert.deepEqual(warnings, []);
});

test("harness.pi.model bypasses Claude alias resolution", () => {
  // "sonnet" would resolve to acme/acme-sonnet-2 if it went through the alias
  // table; a harness-scoped model is already in pi's vocabulary and must not.
  const definition = writeAgent(
    fixtureDir(),
    "verbatim.md",
    "---\nname: verbatim\ndescription: d\nharness:\n  pi:\n    model: sonnet\n---\n\nBody.\n",
  );
  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "pi",
    registry,
    provider: "acme",
  });
  assert.equal(spec.model, "sonnet");
  assert.deepEqual(warnings, []);
});

test("codex can declare its own model instead of dropping the Claude alias", () => {
  const dir = fixtureDir();
  const bare = writeAgent(
    dir,
    "codex-bare.md",
    "---\nname: codex-bare\ndescription: d\nmodel: opus\n---\n\nBody.\n",
  );
  const bareResult = resolveAgentForHarness({
    definition: bare,
    harness: "codex",
  });
  assert.equal(bareResult.spec.model, undefined);
  assert.equal(bareResult.warnings.length, 1);

  const declared = writeAgent(
    dir,
    "codex-declared.md",
    "---\nname: codex-declared\ndescription: d\nmodel: opus\nharness:\n  codex:\n    model: gpt-5-codex\n    effort: xhigh\n---\n\nBody.\n",
  );
  const declaredResult = resolveAgentForHarness({
    definition: declared,
    harness: "codex",
  });
  assert.equal(declaredResult.spec.model, "gpt-5-codex");
  assert.equal(declaredResult.spec.reasoningEffort, "xhigh");
  assert.deepEqual(declaredResult.warnings, []);
});

// --- `model: inherit` ------------------------------------------------------------

test("model: inherit means the parent's model, not a literal model id", () => {
  const definition = writeAgent(
    fixtureDir(),
    "inheriting.md",
    "---\nname: inheriting\ndescription: d\nmodel: inherit\n---\n\nBody.\n",
  );
  for (const harness of ["pi", "claude", "codex"] as const) {
    const { spec, warnings } = resolveAgentForHarness({
      definition,
      harness,
      registry,
      provider: "acme",
    });
    // Undefined is how every backend spells "inherit the parent's model".
    assert.equal(spec.model, undefined, harness);
    assert.deepEqual(warnings, [], harness);
  }
});

test("an inheriting agent leaves the spawn task's model unset", () => {
  const definitions = [
    writeAgent(
      fixtureDir(),
      "inheriting.md",
      "---\nname: inheriting\ndescription: d\nmodel: inherit\n---\n\nBody.\n",
    ),
  ];
  const { spec } = resolveSpawnAgent({
    agentName: "inheriting",
    definitions,
    ctx: parentCtx,
  });
  const task = buildSpawnTask(
    { prompt: "p", title: "t", agent: spec },
    parentCtx,
    undefined,
  );
  assert.equal(task.model, undefined);
});

// --- Harness selection order -------------------------------------------------------

function harnessAgent(name: string, block: string) {
  return writeAgent(
    fixtureDir(),
    `${name}.md`,
    `---\nname: ${name}\ndescription: d\nharness:\n${block}---\n\nBody.\n`,
  );
}

test("with no definition and no request the default harness applies", () => {
  assert.equal(resolveHarness({}).harness, "pi");
  assert.equal(resolveHarness({ requested: "codex" }).harness, "codex");
});

test("prefer supplies the default and an explicit request outranks it", () => {
  const definition = harnessAgent("prefers", "  prefer: claude\n");
  assert.deepEqual(resolveHarness({ definition }), {
    harness: "claude",
    warnings: [],
  });
  assert.deepEqual(resolveHarness({ definition, requested: "codex" }), {
    harness: "codex",
    warnings: [],
  });
});

test("require outranks both an explicit request and prefer, and says so", () => {
  const definition = harnessAgent(
    "requires",
    "  prefer: claude\n  require: pi\n",
  );
  assert.deepEqual(resolveHarness({ definition }), {
    harness: "pi",
    warnings: [],
  });
  const conflict = resolveHarness({ definition, requested: "codex" });
  assert.equal(conflict.harness, "pi");
  assert.deepEqual(conflict.warnings, [
    'agent "requires": requires the pi harness; ignoring the requested codex harness',
  ]);
  // Asking for the harness it already requires is not a conflict.
  assert.deepEqual(
    resolveHarness({ definition, requested: "pi" }).warnings,
    [],
  );
});

test("a spawn with no harness argument runs on the agent's preferred harness", () => {
  const definitions = [
    harnessAgent(
      "prefers-claude",
      "  prefer: claude\n  claude:\n    model: opus\n",
    ),
  ];
  const preferred = resolveSpawnAgent({
    agentName: "prefers-claude",
    definitions,
    ctx: parentCtx,
  });
  assert.equal(preferred.harness, "claude");
  assert.equal(preferred.spec?.model, "opus");

  // Projection follows the settled harness, not the requested one.
  const overridden = resolveSpawnAgent({
    agentName: "prefers-claude",
    definitions,
    harness: "pi",
    ctx: parentCtx,
  });
  assert.equal(overridden.harness, "pi");
  assert.equal(overridden.spec?.model, undefined);
});

test("a required harness wins the projection, not just the routing", () => {
  const definitions = [
    harnessAgent(
      "requires-pi",
      "  require: pi\n  pi:\n    model: opencode-go/deepseek-v4-pro\n    effort: low\n  claude:\n    model: opus\n    effort: high\n",
    ),
  ];
  const resolved = resolveSpawnAgent({
    agentName: "requires-pi",
    definitions,
    harness: "claude",
    ctx: parentCtx,
  });
  assert.equal(resolved.harness, "pi");
  // A child routed to pi but configured from harness.claude would be handed a
  // model id pi cannot resolve, failing the spawn.
  assert.equal(resolved.spec?.model, "opencode-go/deepseek-v4-pro");
  assert.equal(resolved.spec?.reasoningEffort, "low");
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /requires the pi harness/);
});

// --- Effort threading ---------------------------------------------------------------

test("an explicit spawn effort outranks the agent's declared effort", () => {
  const definitions = [
    harnessAgent("effortful", "  pi:\n    effort: medium\n"),
  ];
  const { spec } = resolveSpawnAgent({
    agentName: "effortful",
    definitions,
    harness: "pi",
    ctx: parentCtx,
  });
  assert.equal(
    buildSpawnTask(
      { prompt: "p", title: "t", agent: spec },
      parentCtx,
      undefined,
    ).reasoningEffort,
    "medium",
  );
  assert.equal(
    buildSpawnTask(
      { prompt: "p", title: "t", reasoningEffort: "max", agent: spec },
      parentCtx,
      undefined,
    ).reasoningEffort,
    "max",
  );
});

// --- Malformed content ----------------------------------------------------------------

test("a malformed harness block degrades to warnings, never a lost agent", () => {
  const definition = writeAgent(
    fixtureDir(),
    "botched.md",
    [
      "---",
      "name: botched",
      "description: Still loadable.",
      "tools: Read",
      "harness:",
      "  prefer: gpt5",
      "  pyy:",
      "    model: whatever",
      "  pi:",
      "    model: opencode-go/deepseek-v4-pro",
      "    effort: enormous",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );
  // The agent itself survives intact.
  assert.equal(definition.name, "botched");
  assert.equal(definition.description, "Still loadable.");
  assert.deepEqual(definition.tools, ["Read"]);
  // Only the bad entries are dropped; the good sibling still applies.
  assert.equal(definition.harness?.prefer, undefined);
  assert.deepEqual(definition.harness?.overrides, {
    pi: { model: "opencode-go/deepseek-v4-pro" },
  });
  assert.deepEqual(definition.harness?.warnings, [
    'harness.prefer: unknown harness "gpt5"',
    'harness."pyy": unknown harness',
    'harness.pi.effort: unknown effort "enormous"',
  ]);

  const { spec, warnings } = resolveAgentForHarness({
    definition,
    harness: "pi",
    registry,
    provider: "acme",
  });
  assert.equal(spec.model, "opencode-go/deepseek-v4-pro");
  assert.equal(spec.reasoningEffort, undefined);
  assert.deepEqual(warnings, [
    'agent "botched": harness.prefer: unknown harness "gpt5"',
    'agent "botched": harness."pyy": unknown harness',
    'agent "botched": harness.pi.effort: unknown effort "enormous"',
  ]);
  // An unusable prefer falls back to the default rather than failing.
  assert.equal(resolveHarness({ definition }).harness, "pi");
});

test("an empty harness block is the same as none", () => {
  const definition = writeAgent(
    fixtureDir(),
    "empty-block.md",
    "---\nname: empty-block\ndescription: d\nharness:\nmodel: sonnet\n---\n\nBody.\n",
  );
  assert.equal(definition.harness, undefined);
  assert.equal(definition.model, "sonnet");
});
