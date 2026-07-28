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
import type { AgentSpec, BackendName } from "./domain.ts";

/** Default search path. Overridable so tests can point at a fixture dir. */
export const DEFAULT_AGENT_DEFS_DIR = path.join(
  os.homedir(),
  ".config",
  "ai",
  "agents",
);

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
  /** Raw Claude model alias or id. Undefined = harness default. */
  readonly model?: string;
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

/** Scalars and folded (`>-`/`|`) blocks — the only shapes these files use. */
function parseFrontmatter(block: string) {
  const fields = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = SCALAR_LINE.exec(lines[i]);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!FOLDED_MARKERS.has(rawValue.trim())) {
      fields.set(key, unquote(rawValue));
      continue;
    }
    const folded: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      folded.push(lines[++i].trim());
    }
    fields.set(key, folded.join(" "));
  }
  return fields;
}

function parseToolList(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const tools = raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

/**
 * Bodies reference their shared fragment in prose ("read
 * `.../_shared/base.md`"), which a headless child may not be able to open.
 * Inlining the fragment makes the instruction self-contained.
 */
function inlineSharedFragments(body: string, agentsDir: string) {
  const pattern = new RegExp(
    `${SHARED_FRAGMENT_DIR}/([A-Za-z0-9._-]+\\.md)`,
    "g",
  );
  const names = [...new Set([...body.matchAll(pattern)].map((m) => m[1]))];
  let result = body;
  for (const name of names) {
    const file = path.join(agentsDir, SHARED_FRAGMENT_DIR, name);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
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
}): AgentDefinition | undefined {
  const match = FRONTMATTER.exec(options.content);
  if (!match) return undefined;
  const fields = parseFrontmatter(match[1]);
  const name =
    fields.get("name") ||
    path.basename(options.sourcePath, AGENT_FILE_EXTENSION);
  const body = match[2].trim();
  if (!body) return undefined;
  return {
    name,
    description: boundDescription(fields.get("description") ?? ""),
    systemPrompt: inlineSharedFragments(body, options.agentsDir),
    tools: parseToolList(fields.get("tools")),
    model: fields.get("model") || undefined,
    sourcePath: options.sourcePath,
  };
}

/** Read every `*.md` in `agentsDir`; `_shared/` is a fragment dir, not an agent. */
export function loadAgentDefinitions(agentsDir = DEFAULT_AGENT_DEFS_DIR) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
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
      });
      if (parsed) defs.push(parsed);
    } catch {
      // An unreadable or malformed file must not hide the rest of the catalog.
    }
  }
  return defs.sort((a, b) => a.name.localeCompare(b.name));
}

// --- Tool mapping -------------------------------------------------------------

/**
 * Claude tool name -> pi tool names. One Claude tool can cover several pi
 * tools (Claude's Glob spans pi's find/fd/ls), so entries are lists.
 */
const CLAUDE_TO_PI_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  MultiEdit: ["edit"],
  Bash: ["bash"],
  Grep: ["grep", "rg"],
  Glob: ["find", "fd", "ls"],
  WebSearch: ["web_search"],
  WebFetch: ["web_fetch"],
};

/** Tools deliberately refused, with the reason shown to the user. */
const REFUSED_CLAUDE_TOOLS: Readonly<Record<string, string>> = {
  Task: "subagents cannot spawn further subagents",
  Agent: "subagents cannot spawn further subagents",
};

const MCP_TOOL_PREFIX = "mcp__";

export interface ToolMapping {
  /** Undefined = no allowlist (the `*` marker or no `tools` field). */
  readonly tools?: readonly string[];
  readonly warnings: readonly string[];
}

/** Translate Claude tool names into pi's vocabulary, reporting every drop. */
export function mapClaudeToolsToPi(
  claudeTools: readonly string[] | undefined,
  agentName: string,
): ToolMapping {
  if (!claudeTools || claudeTools.includes(ALL_TOOLS_MARKER)) {
    return { warnings: [] };
  }
  const tools = new Set<string>();
  const warnings: string[] = [];
  for (const claudeTool of claudeTools) {
    const mapped = CLAUDE_TO_PI_TOOLS[claudeTool];
    if (mapped) {
      for (const tool of mapped) tools.add(tool);
      continue;
    }
    const reason =
      REFUSED_CLAUDE_TOOLS[claudeTool] ??
      (claudeTool.startsWith(MCP_TOOL_PREFIX)
        ? "pi has no MCP support"
        : "no pi equivalent");
    warnings.push(
      `agent "${agentName}": dropped tool ${claudeTool} (${reason})`,
    );
  }
  return { tools: [...tools], warnings };
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
 * Project a definition onto one harness. Claude Code speaks the source
 * vocabulary natively, so nothing is translated for it; pi gets mapped tool
 * and model names; codex has neither concept beyond the system prompt.
 */
export function resolveAgentForHarness(options: {
  readonly definition: AgentDefinition;
  readonly harness: BackendName;
  readonly registry?: Pick<ModelRegistry, "getAll">;
  readonly provider?: string;
  readonly toolDenylist?: readonly string[];
}): AgentResolution {
  const { definition, harness } = options;
  const base = {
    name: definition.name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
  };

  if (harness === "claude") {
    const refused = Object.keys(REFUSED_CLAUDE_TOOLS);
    const tools = applyToolDenylist(definition.tools, refused);
    return {
      spec: { ...base, tools, model: definition.model },
      warnings: (definition.tools ?? [])
        .filter((tool) => refused.includes(tool))
        .map(
          (tool) =>
            `agent "${definition.name}": dropped tool ${tool} (${REFUSED_CLAUDE_TOOLS[tool]})`,
        ),
    };
  }

  if (harness === "codex") {
    const warnings: string[] = [];
    if (definition.tools) {
      warnings.push(
        `agent "${definition.name}": tool restrictions are not supported on the codex harness`,
      );
    }
    if (definition.model && isClaudeModelAlias(definition.model)) {
      warnings.push(
        `agent "${definition.name}": model alias "${definition.model}" means nothing to codex; using the harness default`,
      );
    }
    return { spec: base, warnings };
  }

  const mapped = mapClaudeToolsToPi(definition.tools, definition.name);
  const model = resolvePiModelAlias({
    model: definition.model,
    registry: options.registry,
    provider: options.provider,
    agentName: definition.name,
  });
  return {
    spec: {
      ...base,
      tools: applyToolDenylist(mapped.tools, options.toolDenylist ?? []),
      model: model.model,
    },
    warnings: model.warning
      ? [...mapped.warnings, model.warning]
      : mapped.warnings,
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
