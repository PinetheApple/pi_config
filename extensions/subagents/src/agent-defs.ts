/**
 * Claude-format agent definitions (`~/.config/ai/agents/*.md`) made spawnable
 * from pi.
 *
 * Three translations happen here, all pure and all lossy in documented ways:
 * - frontmatter -> `AgentDefinition` (a hand-rolled parser; the files only use
 *   scalars and `>-` folded blocks, and the extension has no YAML dependency);
 * - Claude tool names -> the chosen harness's vocabulary, dropping anything
 *   with no equivalent and reporting it rather than silently widening or
 *   narrowing the child's reach;
 * - Claude model aliases -> a concrete model, resolved only inside the
 *   session's own provider so an `opus` agent can never be silently rerouted
 *   onto a metered endpoint the user did not choose.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  claudeToolToPiTools,
  CLAUDE_TO_PI_TOOLS,
  MCP_TOOL_PREFIX,
} from "../../shared/claude-tool-names.ts";
import {
  effectiveAgentMode,
  isPermissionMode,
  STRICTEST_PERMISSION_MODE,
  type PermissionMode,
} from "../../shared/permission-modes.ts";
import { projectConfigDirs } from "../../shared/project-config-roots.ts";
import {
  BACKEND_NAMES,
  DEFAULT_HARNESS,
  REASONING_EFFORTS,
  type AgentSpec,
  type BackendName,
  type ReasoningEffort,
} from "./domain.ts";

/** Default search path. Overridable so tests can point at a fixture dir. */
export const DEFAULT_AGENT_DEFS_DIR = path.join(
  os.homedir(),
  ".config",
  "ai",
  "agents",
);

/** Subdirectory holding agent definitions inside each project config root. */
export const PROJECT_AGENT_DEFS_SUBDIR = "agents";

/**
 * Search path, lowest precedence first: a project agent shadows a global one
 * of the same name, and among the project config roots the earlier root wins —
 * so the list is reversed into layer order.
 */
export function agentDefsSearchPath(cwd: string) {
  return [
    DEFAULT_AGENT_DEFS_DIR,
    ...projectConfigDirs(cwd, PROJECT_AGENT_DEFS_SUBDIR).reverse(),
  ];
}

/** Fragment directory: shared includes, never spawnable agents themselves. */
export const SHARED_FRAGMENT_DIR = "_shared";

/** Claude's "every tool" marker: no allowlist at all. */
export const ALL_TOOLS_MARKER = "*";

const AGENT_FILE_EXTENSION = ".md";
const DESCRIPTION_MAX_LENGTH = 240;

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  /** Body with any `_shared` fragment it references appended. */
  readonly systemPrompt: string;
  /** Raw Claude tool names. Undefined = inherit everything. */
  readonly tools?: readonly string[];
  /** Raw Claude tool names subtracted from `tools` (and from the harness default). */
  readonly disallowedTools?: readonly string[];
  /**
   * Explicit mode for children of this agent. Undefined keeps the long-standing
   * `bypassPermissions` default; see `effectiveAgentMode`.
   */
  readonly permissionMode?: PermissionMode;
  /** Problems found parsing the frontmatter itself, surfaced on resolution. */
  readonly warnings?: readonly string[];
  /** Raw Claude model alias or id. Undefined = harness default. */
  readonly model?: string;
  /** Per-harness overrides from the `harness:` block, when it has any. */
  readonly harness?: HarnessConfig;
  readonly sourcePath: string;
}

export interface AgentResolution {
  readonly spec: AgentSpec;
  readonly warnings: readonly string[];
}

// --- Frontmatter parsing ------------------------------------------------------

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const SCALAR_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const FOLDED_MARKERS = new Set([">", ">-", "|", "|-"]);

function unquote(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Scalars, folded (`>-`/`|`) blocks, and nested mappings. A key with no value
 * keeps its indented lines verbatim in `blocks` for a caller that understands
 * their shape; every other key sees only the flat scalar it always did.
 */
function parseFrontmatter(block: string) {
  const fields = new Map<string, string>();
  const blocks = new Map<string, readonly string[]>();
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = SCALAR_LINE.exec(lines[i]);
    if (!match) continue;
    const [, key, rawValue] = match;
    const marker = rawValue.trim();
    if (marker && !FOLDED_MARKERS.has(marker)) {
      fields.set(key, unquote(rawValue));
      continue;
    }
    const indented: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      indented.push(lines[++i]);
    }
    if (marker) {
      fields.set(key, indented.map((line) => line.trim()).join(" "));
      continue;
    }
    fields.set(key, unquote(rawValue));
    blocks.set(key, indented);
  }
  return { fields, blocks };
}

/**
 * An unrecognised mode lands on the strictest mode, with a warning — it is
 * never dropped.
 *
 * Dropping it looks conservative and is the opposite: an absent
 * `permissionMode` means `bypassPermissions` by design (see
 * `effectiveAgentMode`), so treating `permissionMode: yolo` as "unset" would
 * silently promote a typo to the *loosest* mode in the set. The author asked
 * for something specific and we could not tell what, which is the one case
 * where guessing must go tight rather than convenient.
 */
function parsePermissionMode(raw: string | undefined): {
  readonly mode?: PermissionMode;
  readonly warning?: string;
} {
  const value = raw?.trim();
  if (!value) return {};
  if (isPermissionMode(value)) return { mode: value };
  return {
    mode: STRICTEST_PERMISSION_MODE,
    warning: `unknown permissionMode "${value}"; falling back to "${STRICTEST_PERMISSION_MODE}"`,
  };
}

/** Both `Read, Edit` and `["Read", "Edit"]` occur in the wild; accept either. */
function parseToolList(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const tools = raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((tool) => unquote(tool))
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

// --- The `harness:` block -----------------------------------------------------

/**
 * Per-harness overrides declared in frontmatter:
 *
 * ```yaml
 * harness:
 *   prefer: claude
 *   pi:
 *     model: opencode-go/deepseek-v4-pro
 *     effort: medium
 * ```
 *
 * The file stays a valid Claude Code definition — Claude Code reads
 * `name`/`description`/`model` and ignores keys it does not know — while pi
 * reads its own provider-qualified model out of `harness.pi`.
 *
 * `parseHarnessConfig` is the only thing here that understands the on-disk
 * shape. If Claude Code ever starts rejecting unknown keys, a sidecar loader
 * can produce a `HarnessConfig` by other means and nothing downstream moves.
 */
export interface HarnessOverride {
  /** Already in the harness's own vocabulary; never alias-resolved. */
  readonly model?: string;
  readonly effort?: ReasoningEffort;
}

export interface HarnessConfig {
  /** Default harness; an explicit caller choice outranks it. */
  readonly prefer?: BackendName;
  /** Hard constraint; outranks an explicit caller choice. */
  readonly required?: BackendName;
  readonly overrides: Readonly<Partial<Record<BackendName, HarnessOverride>>>;
  /** Content that was dropped, reported when the definition is projected. */
  readonly warnings: readonly string[];
}

const BLOCK_ENTRY = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;

function asBackendName(value: string) {
  return (BACKEND_NAMES as readonly string[]).includes(value)
    ? (value as BackendName)
    : undefined;
}

function asReasoningEffort(value: string) {
  return (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : undefined;
}

/**
 * Parse the indented lines under `harness:`.
 *
 * Lenient in the same way as the rest of this parser: unknown keys are
 * ignored, but a key whose *value* names a harness or effort that does not
 * exist is dropped with a warning. Silently ignoring a typo'd harness is the
 * exact failure this block exists to prevent, and no amount of bad content
 * costs the user an otherwise-valid agent.
 */
export function parseHarnessConfig(
  lines: readonly string[],
): HarnessConfig | undefined {
  const entries = lines.flatMap((line) => {
    const match = BLOCK_ENTRY.exec(line);
    return match
      ? [{ indent: match[1].length, key: match[2], value: unquote(match[3]) }]
      : [];
  });
  if (entries.length === 0) return undefined;

  const topIndent = Math.min(...entries.map((entry) => entry.indent));
  const overrides: Partial<Record<BackendName, HarnessOverride>> = {};
  const warnings: string[] = [];
  let prefer: BackendName | undefined;
  let required: BackendName | undefined;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.indent !== topIndent) continue;

    if (entry.key === "prefer" || entry.key === "require") {
      const backend = asBackendName(entry.value);
      if (!backend) {
        warnings.push(`harness.${entry.key}: unknown harness "${entry.value}"`);
        continue;
      }
      if (entry.key === "prefer") prefer = backend;
      else required = backend;
      continue;
    }

    const backend = asBackendName(entry.key);
    if (!backend) {
      warnings.push(`harness."${entry.key}": unknown harness`);
      continue;
    }
    const override: { model?: string; effort?: ReasoningEffort } = {};
    while (i + 1 < entries.length && entries[i + 1].indent > topIndent) {
      const nested = entries[++i];
      if (nested.key === "model" && nested.value) {
        override.model = nested.value;
        continue;
      }
      if (nested.key !== "effort") continue;
      const effort = asReasoningEffort(nested.value);
      if (effort) override.effort = effort;
      else {
        warnings.push(
          `harness.${backend}.effort: unknown effort "${nested.value}"`,
        );
      }
    }
    overrides[backend] = override;
  }

  return { prefer, required, overrides, warnings };
}

/** First directory that holds the fragment wins; absent everywhere is fine. */
function readSharedFragment(dirs: readonly string[], name: string) {
  for (const dir of dirs) {
    try {
      return fs.readFileSync(path.join(dir, SHARED_FRAGMENT_DIR, name), "utf8");
    } catch {
      // Try the next layer; a project dir usually has no `_shared` of its own.
    }
  }
  return undefined;
}

/**
 * Bodies reference their shared fragment in prose ("read
 * `.../_shared/base.md`"), which a headless child may not be able to open.
 * Inlining the fragment makes the instruction self-contained.
 */
function inlineSharedFragments(body: string, fragmentDirs: readonly string[]) {
  const pattern = new RegExp(
    `${SHARED_FRAGMENT_DIR}/([A-Za-z0-9._-]+\\.md)`,
    "g",
  );
  const names = [...new Set([...body.matchAll(pattern)].map((m) => m[1]))];
  let result = body;
  for (const name of names) {
    const content = readSharedFragment(fragmentDirs, name);
    if (content === undefined) continue;
    result += `\n\n--- Included from ${SHARED_FRAGMENT_DIR}/${name} ---\n\n${content.trim()}\n`;
  }
  return result;
}

/** Descriptions ride in the tool schema; keep them short and word-aligned. */
function boundDescription(raw: string) {
  const text = raw.trim();
  if (text.length <= DESCRIPTION_MAX_LENGTH) return text;
  const cut = text.slice(0, DESCRIPTION_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

export function parseAgentDefinition(options: {
  readonly content: string;
  readonly sourcePath: string;
  readonly agentsDir: string;
  /** Searched after `agentsDir`, so a project agent can use global fragments. */
  readonly fragmentFallbackDirs?: readonly string[];
}): AgentDefinition | undefined {
  const match = FRONTMATTER.exec(options.content);
  if (!match) return undefined;
  const { fields, blocks } = parseFrontmatter(match[1]);
  const name =
    fields.get("name") ||
    path.basename(options.sourcePath, AGENT_FILE_EXTENSION);
  const body = match[2].trim();
  if (!body) return undefined;
  const permission = parsePermissionMode(fields.get("permissionMode"));
  return {
    name,
    description: boundDescription(fields.get("description") ?? ""),
    systemPrompt: inlineSharedFragments(body, [
      options.agentsDir,
      ...(options.fragmentFallbackDirs ?? []),
    ]),
    tools: parseToolList(fields.get("tools")),
    disallowedTools: parseToolList(fields.get("disallowedTools")),
    permissionMode: permission.mode,
    warnings: permission.warning ? [permission.warning] : undefined,
    model: fields.get("model") || undefined,
    harness: parseHarnessConfig(blocks.get("harness") ?? []),
    sourcePath: options.sourcePath,
  };
}

/** Read every `*.md` in one layer; `_shared/` is a fragment dir, not an agent. */
function readAgentDirectory(
  agentsDir: string,
  fragmentFallbackDirs: readonly string[],
) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    // Most projects have no agents dir under most roots; that is not an error.
    return [];
  }
  const defs: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(AGENT_FILE_EXTENSION)) continue;
    const sourcePath = path.join(agentsDir, entry.name);
    try {
      const parsed = parseAgentDefinition({
        content: fs.readFileSync(sourcePath, "utf8"),
        sourcePath,
        agentsDir,
        fragmentFallbackDirs,
      });
      if (parsed) defs.push(parsed);
    } catch {
      // An unreadable or malformed file must not hide the rest of the catalog.
    }
  }
  return defs;
}

/**
 * Build the catalog from one or more layers, lowest precedence first: a later
 * directory shadows an earlier one for agents of the same name. Every layer
 * can also supply `_shared/` fragments to every other.
 */
export function loadAgentDefinitions(
  agentsDirs: string | readonly string[] = DEFAULT_AGENT_DEFS_DIR,
) {
  const dirs = typeof agentsDirs === "string" ? [agentsDirs] : agentsDirs;
  const byName = new Map<string, AgentDefinition>();
  for (const agentsDir of dirs) {
    for (const def of readAgentDirectory(agentsDir, dirs)) {
      byName.set(def.name, def);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The catalog for one session. Bound to that session's own cwd, which is not
 * the process cwd: a headless child runs inside the parent's process but may
 * have been spawned against a different directory.
 *
 * Project agents are repo-supplied system prompts, and a project `_shared/`
 * fragment is inlined into global agents too, so an untrusted project's
 * directory is left out of the search path rather than filtered afterwards.
 */
export function loadSessionAgentDefinitions(options: {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}) {
  return loadAgentDefinitions(
    options.projectTrusted
      ? agentDefsSearchPath(options.cwd)
      : [DEFAULT_AGENT_DEFS_DIR],
  );
}

// --- Tool mapping -------------------------------------------------------------

/** Tools deliberately refused, with the reason shown to the user. */
const REFUSED_CLAUDE_TOOLS: Readonly<Record<string, string>> = {
  Task: "subagents cannot spawn further subagents",
  Agent: "subagents cannot spawn further subagents",
};

/** The one tool `pi-mcp-adapter` always registers: a gateway over every server. */
const MCP_PROXY_TOOL = "mcp";

/**
 * Claude names an MCP server `mcp__<server>`. pi reaches the same server
 * through whatever `pi-mcp-adapter` registered, which depends on its config:
 * by default a single `mcp` proxy tool, or — with `directTools` enabled —
 * one tool per MCP tool, named `<prefix>_<tool>` where the prefix follows
 * `settings.toolPrefix` (`mcp__<server>`, `<server>`, a short form, or none).
 *
 * So the pi name cannot be derived from the Claude name alone; it has to be
 * matched against the tools actually registered in the target session.
 */
export function resolveMcpTools(
  claudeTool: string,
  availableTools: ReadonlySet<string>,
) {
  const server = claudeTool.slice(MCP_TOOL_PREFIX.length).split("__")[0] ?? "";
  if (!server) return [];
  const sanitized = server.replace(/-/g, "_");
  // Most specific first: an exact direct tool, then that server's direct
  // tools, then the gateway that can reach every server.
  if (availableTools.has(claudeTool)) return [claudeTool];
  const direct = [...availableTools].filter(
    (tool) =>
      tool.startsWith(`${MCP_TOOL_PREFIX}${sanitized}_`) ||
      tool.startsWith(`${sanitized}_`),
  );
  if (direct.length > 0) return direct.sort();
  return availableTools.has(MCP_PROXY_TOOL) ? [MCP_PROXY_TOOL] : [];
}

export interface ToolMapping {
  /** Undefined = no allowlist (the `*` marker or no `tools` field). */
  readonly tools?: readonly string[];
  /**
   * `mcp__*` names that could not be resolved yet because the caller did not
   * know the target session's tools. The pi backend resolves these once the
   * child has bound its extensions.
   */
  readonly deferredMcpTools?: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Translate Claude tool names into pi's vocabulary, reporting every drop.
 *
 * `availableTools` is the tool inventory of the session the agent will run in.
 * Omit it when that is not known yet (building the catalog at load time):
 * MCP tools are then deferred rather than guessed at or wrongly refused.
 */
export function mapClaudeToolsToPi(
  claudeTools: readonly string[] | undefined,
  agentName: string,
  availableTools?: ReadonlySet<string>,
): ToolMapping {
  if (!claudeTools || claudeTools.includes(ALL_TOOLS_MARKER)) {
    return { warnings: [] };
  }
  const tools = new Set<string>();
  const deferred = new Set<string>();
  const warnings: string[] = [];
  for (const claudeTool of claudeTools) {
    const mapped = CLAUDE_TO_PI_TOOLS[claudeTool];
    if (mapped) {
      for (const tool of mapped) tools.add(tool);
      continue;
    }
    if (
      claudeTool.startsWith(MCP_TOOL_PREFIX) &&
      !REFUSED_CLAUDE_TOOLS[claudeTool]
    ) {
      if (!availableTools) {
        deferred.add(claudeTool);
        continue;
      }
      const resolved = resolveMcpTools(claudeTool, availableTools);
      if (resolved.length > 0) {
        for (const tool of resolved) tools.add(tool);
        continue;
      }
      const server = claudeTool.slice(MCP_TOOL_PREFIX.length).split("__")[0];
      warnings.push(
        `agent "${agentName}": dropped tool ${claudeTool} (no MCP tool for server "${server}" is registered here; check that pi-mcp-adapter is installed and the server is configured in mcp.json)`,
      );
      continue;
    }
    const reason = REFUSED_CLAUDE_TOOLS[claudeTool] ?? "no pi equivalent";
    warnings.push(
      `agent "${agentName}": dropped tool ${claudeTool} (${reason})`,
    );
  }
  return {
    tools: [...tools],
    ...(deferred.size > 0 ? { deferredMcpTools: [...deferred] } : {}),
    warnings,
  };
}

/** Remove denylisted names from an allowlist so children can never recurse. */
export function applyToolDenylist(
  tools: readonly string[] | undefined,
  denylist: readonly string[],
) {
  if (!tools) return undefined;
  const denied = new Set(denylist);
  return tools.filter((tool) => !denied.has(tool));
}

// --- Model alias resolution ----------------------------------------------------

/** Claude's capability aliases. Anything else is treated as a literal model id. */
const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

/**
 * Claude Code's default `model:`, meaning "run on the parent session's model".
 * Every backend already spells that "no model hint", so it is normalized to
 * undefined rather than carried — left literal it reaches pi's registry as a
 * model id and fails the spawn.
 */
const INHERIT_MODEL = "inherit";

/** The definition's own model, with the inherit sentinel resolved away. */
function declaredModel(definition: AgentDefinition) {
  return definition.model === INHERIT_MODEL ? undefined : definition.model;
}

export interface ModelResolution {
  readonly model?: string;
  readonly warning?: string;
}

export function isClaudeModelAlias(model: string) {
  return (CLAUDE_MODEL_ALIASES as readonly string[]).includes(model);
}

/**
 * Resolve an alias to `provider/id` *within the session's own provider only*.
 * Searching every provider would happily route an `opus` agent onto a metered
 * Anthropic endpoint the user never opted into, so an unresolvable alias
 * falls back to the session default and says so.
 */
export function resolvePiModelAlias(options: {
  readonly model: string | undefined;
  readonly registry?: Pick<ModelRegistry, "getAll">;
  readonly provider?: string;
  readonly agentName: string;
}): ModelResolution {
  const { model, registry, provider, agentName } = options;
  if (!model) return {};
  if (!isClaudeModelAlias(model)) return { model };
  const fallback = (why: string) => ({
    warning: `agent "${agentName}": model alias "${model}" ${why}; using the session default`,
  });
  if (!registry || !provider) return fallback("cannot be resolved here");
  const match = registry
    .getAll()
    .find((m) => m.provider === provider && m.id.toLowerCase().includes(model));
  if (!match) return fallback(`has no match in provider "${provider}"`);
  return { model: `${match.provider}/${match.id}` };
}

// --- Harness resolution ---------------------------------------------------------

/**
 * Pick the harness a spawn runs on. Highest precedence first:
 *
 * 1. `harness.require` — the definition declares it only works on that harness;
 * 2. the caller's explicit choice (`subagent_spawn`'s `harness` argument);
 * 3. `harness.prefer` — the definition's default;
 * 4. `DEFAULT_HARNESS`.
 *
 * A `require` that overrides an explicit choice says so, rather than quietly
 * running somewhere the caller did not ask for. Availability is not checked
 * here: a required harness whose CLI is missing fails the spawn with the
 * backend's own unavailable error instead of silently downgrading to another
 * harness, which would run the agent under a model the author ruled out.
 */
export function resolveHarness(options: {
  readonly requested?: BackendName;
  readonly definition?: AgentDefinition;
}): { harness: BackendName; warnings: readonly string[] } {
  const config = options.definition?.harness;
  if (!config?.required) {
    return {
      harness: options.requested ?? config?.prefer ?? DEFAULT_HARNESS,
      warnings: [],
    };
  }
  const conflicting =
    options.requested && options.requested !== config.required;
  return {
    harness: config.required,
    warnings: conflicting
      ? [
          `agent "${options.definition?.name}": requires the ${config.required} harness; ignoring the requested ${options.requested} harness`,
        ]
      : [],
  };
}

/**
 * Project a definition onto one harness. Claude Code speaks the source
 * vocabulary natively, so nothing is translated for it; pi gets mapped tool
 * and model names; codex has neither concept beyond the system prompt.
 *
 * A `harness.<name>.model` is authored in that harness's own vocabulary and is
 * used verbatim — running an already provider-qualified id like
 * `opencode-go/deepseek-v4-pro` through Claude's alias table only produces a
 * spurious "cannot be resolved" warning and drops the model the user chose.
 */
export function resolveAgentForHarness(options: {
  readonly definition: AgentDefinition;
  readonly harness: BackendName;
  readonly registry?: Pick<ModelRegistry, "getAll">;
  readonly provider?: string;
  readonly toolDenylist?: readonly string[];
  /** Ceiling for the child's mode; a silent definition ignores it by design. */
  readonly sessionPermissionMode?: PermissionMode;
}): AgentResolution {
  const { definition, harness } = options;
  const override = definition.harness?.overrides[harness];
  const blockWarnings = [
    ...(definition.warnings ?? []),
    ...(definition.harness?.warnings ?? []),
  ].map((warning) => `agent "${definition.name}": ${warning}`);
  const base = {
    name: definition.name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    reasoningEffort: override?.effort,
    permissionMode: effectiveAgentMode({
      sessionMode: options.sessionPermissionMode,
      definitionMode: definition.permissionMode,
    }),
  };
  const declaredDenied = definition.disallowedTools ?? [];

  if (harness === "claude") {
    const refused = Object.keys(REFUSED_CLAUDE_TOOLS);
    const tools = applyToolDenylist(definition.tools, [
      ...refused,
      ...declaredDenied,
    ]);
    return {
      spec: {
        ...base,
        tools,
        // Claude speaks these names natively, so they pass through untranslated.
        ...(declaredDenied.length > 0
          ? { disallowedTools: [...declaredDenied] }
          : {}),
        model: override?.model ?? declaredModel(definition),
      },
      warnings: [
        ...blockWarnings,
        ...(definition.tools ?? [])
          .filter((tool) => refused.includes(tool))
          .map(
            (tool) =>
              `agent "${definition.name}": dropped tool ${tool} (${REFUSED_CLAUDE_TOOLS[tool]})`,
          ),
      ],
    };
  }

  if (harness === "codex") {
    const warnings = [...blockWarnings];
    if (definition.tools || declaredDenied.length > 0) {
      warnings.push(
        `agent "${definition.name}": tool restrictions are not supported on the codex harness`,
      );
    }
    const declared = declaredModel(definition);
    if (!override?.model && declared && isClaudeModelAlias(declared)) {
      warnings.push(
        `agent "${definition.name}": model alias "${declared}" means nothing to codex; declare harness.codex.model to pick one`,
      );
    }
    return { spec: { ...base, model: override?.model }, warnings };
  }

  const mapped = mapClaudeToolsToPi(definition.tools, definition.name);
  // Denied names go through the same table as allowed ones, so `Grep` denies
  // both `grep` and `rg` rather than only the name that happens to be spelled
  // the same. Unmappable names are dropped here without a warning: they are
  // already absent from pi, so denying them is a no-op either way.
  const deniedForPi = declaredDenied.flatMap(
    (tool) => claudeToolToPiTools(tool) ?? [tool],
  );
  const model = override?.model
    ? { model: override.model }
    : resolvePiModelAlias({
        model: declaredModel(definition),
        registry: options.registry,
        provider: options.provider,
        agentName: definition.name,
      });
  return {
    spec: {
      ...base,
      tools: applyToolDenylist(mapped.tools, [
        ...(options.toolDenylist ?? []),
        ...deniedForPi,
      ]),
      ...(deniedForPi.length > 0 ? { disallowedTools: deniedForPi } : {}),
      ...(mapped.deferredMcpTools
        ? { deferredMcpTools: mapped.deferredMcpTools }
        : {}),
      model: model.model,
    },
    warnings: [
      ...blockWarnings,
      ...mapped.warnings,
      ...(model.warning ? [model.warning] : []),
    ],
  };
}

/**
 * Fallback for harnesses with no system-prompt option: fold the persona into
 * the first user turn. Weaker than a real system prompt, but not silent.
 */
export function prefixWithSystemPrompt(
  prompt: string,
  agent: AgentSpec | undefined,
) {
  return agent ? `${agent.systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

// --- Catalog -------------------------------------------------------------------

export function findAgentDefinition(
  definitions: readonly AgentDefinition[],
  name: string,
) {
  return definitions.find((def) => def.name === name);
}

/** One `name — description` line per agent, for prompts and command output. */
export function formatAgentCatalog(definitions: readonly AgentDefinition[]) {
  return definitions
    .map((def) => `- ${def.name} — ${def.description}`)
    .join("\n");
}
