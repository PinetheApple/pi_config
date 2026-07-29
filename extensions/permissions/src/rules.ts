/**
 * Claude Code permission rules, parsed and matched against pi tool calls.
 *
 * Four syntaxes occur in the user's config and all four are supported:
 * - `Tool` — unconditional, any call to that tool;
 * - `Tool(glob)` — matched against the call's path argument;
 * - `Bash(cmd:*)` — prefix match on the command (`Bash(cmd)` is exact);
 * - `mcp__server` / `mcp__server__tool` — an MCP server or one of its tools.
 *
 * Heads are translated through the shared Claude -> pi table, so `Read(...)`
 * gates pi's `read` and `Grep(...)` gates both `grep` and `rg`. A head that is
 * not a Claude name is taken as a literal pi tool name, which lets the same
 * file express pi-native rules such as `bash(...)` or `web_search`.
 */

import * as path from "node:path";
import {
  claudeToolToPiTools,
  MCP_TOOL_PREFIX,
} from "../../shared/claude-tool-names.ts";

export type RuleEffect = "allow" | "ask" | "deny";

/** How a rule's argument is compared against the call's resource. */
type Argument =
  | { readonly kind: "any" }
  | { readonly kind: "glob"; readonly pattern: RegExp }
  | { readonly kind: "prefix"; readonly value: string }
  | { readonly kind: "exact"; readonly value: string };

export interface PermissionRule {
  readonly effect: RuleEffect;
  /** The rule exactly as written, so a decision can name its cause. */
  readonly source: string;
  /** pi tool names this rule governs. Empty = any tool of that MCP server. */
  readonly tools: readonly string[];
  /** Set for `mcp__server` heads; matched structurally, not by name equality. */
  readonly mcpServer?: string;
  readonly argument: Argument;
}

const RULE_HEAD = /^([^(]+)(?:\((.*)\))?$/s;
const BASH_PREFIX_SUFFIX = ":*";

/**
 * pi tools whose "resource" is a filesystem path, and the input field holding
 * it. `bash` is deliberately absent: its resource is a command string, matched
 * as text, never resolved against the filesystem.
 */
const PATH_ARGUMENT_FIELDS: Readonly<Record<string, string>> = {
  read: "path",
  write: "path",
  edit: "path",
  grep: "path",
  rg: "path",
  find: "path",
  fd: "path",
  ls: "path",
};

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * `*` stops at a separator, `**` crosses them, and a trailing `/**` also
 * matches the directory itself — `Read(/a/**)` is meant to cover `/a`.
 */
export function globToRegExp(glob: string) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (out.endsWith("/")) out = `${out.slice(0, -1)}(?:/.*)?`;
        else out += ".*";
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(REGEX_SPECIALS, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function parseArgument(head: string, raw: string | undefined): Argument {
  if (raw === undefined || raw === "" || raw === "*") return { kind: "any" };
  // Command-shaped tools compare text; everything else compares paths. Claude
  // spells "any command starting with" as a `:*` suffix, which is not a glob.
  const commandShaped = claudeToolToPiTools(head)?.includes("bash");
  if (commandShaped || head === "bash") {
    return raw.endsWith(BASH_PREFIX_SUFFIX)
      ? { kind: "prefix", value: raw.slice(0, -BASH_PREFIX_SUFFIX.length) }
      : { kind: "exact", value: raw };
  }
  return { kind: "glob", pattern: globToRegExp(raw) };
}

/** Undefined for a blank or unparseable entry, which is skipped, not guessed at. */
export function parseRule(
  source: string,
  effect: RuleEffect,
): PermissionRule | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  const match = RULE_HEAD.exec(trimmed);
  if (!match) return undefined;
  const head = match[1].trim();
  if (!head) return undefined;
  const argument = parseArgument(head, match[2]);

  if (head.startsWith(MCP_TOOL_PREFIX)) {
    const [server, tool] = head.slice(MCP_TOOL_PREFIX.length).split("__");
    if (!server) return undefined;
    return {
      effect,
      source: trimmed,
      tools: tool ? [head] : [],
      mcpServer: server,
      argument,
    };
  }

  return {
    effect,
    source: trimmed,
    tools: [...(claudeToolToPiTools(head) ?? [head])],
    argument,
  };
}

export function parseRules(
  sources: readonly string[] | undefined,
  effect: RuleEffect,
) {
  return (sources ?? []).flatMap((source) => {
    const rule = parseRule(source, effect);
    return rule ? [rule] : [];
  });
}

export interface ToolCall {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Relative paths in tool input are resolved against this. */
  readonly cwd: string;
}

/**
 * The single value a rule argument is compared against, or undefined when the
 * tool has none. A tool with no resource can only ever be matched by a rule
 * that takes no argument, which is why `Tool(glob)` never matches a custom tool.
 */
export function resourceOf(call: ToolCall) {
  if (call.toolName === "bash") {
    const command = call.input.command;
    return typeof command === "string" ? command : undefined;
  }
  const field = PATH_ARGUMENT_FIELDS[call.toolName];
  if (!field) return undefined;
  const value = call.input[field];
  if (typeof value !== "string") return undefined;
  return path.resolve(call.cwd, value);
}

/**
 * pi reaches an MCP server either through per-server direct tools or through
 * `pi-mcp-adapter`'s single `mcp` gateway, and the naming of the direct form is
 * configurable. So a `mcp__server` rule is matched against the shapes that
 * naming can produce rather than against one fixed string.
 */
function matchesMcpServer(rule: PermissionRule, call: ToolCall) {
  const server = rule.mcpServer;
  if (!server) return false;
  const sanitized = server.replace(/-/g, "_");
  if (rule.tools.length > 0) return rule.tools.includes(call.toolName);
  if (
    call.toolName.startsWith(`${MCP_TOOL_PREFIX}${sanitized}`) ||
    call.toolName.startsWith(`${sanitized}_`)
  ) {
    return true;
  }
  // The gateway serves every server, so it only matches when the call itself
  // names this one. Guessing otherwise would let one server's rule speak for all.
  if (call.toolName !== "mcp") return false;
  const target = call.input.server;
  return typeof target === "string" && target.replace(/-/g, "_") === sanitized;
}

function matchesArgument(rule: PermissionRule, call: ToolCall) {
  if (rule.argument.kind === "any") return true;
  const resource = resourceOf(call);
  if (resource === undefined) return false;
  if (rule.argument.kind === "glob")
    return rule.argument.pattern.test(resource);
  if (rule.argument.kind === "prefix") {
    return resource.startsWith(rule.argument.value);
  }
  return resource === rule.argument.value;
}

export function ruleMatches(rule: PermissionRule, call: ToolCall) {
  const toolMatches = rule.mcpServer
    ? matchesMcpServer(rule, call)
    : rule.tools.includes(call.toolName);
  return toolMatches && matchesArgument(rule, call);
}

export function firstMatch(
  rules: readonly PermissionRule[],
  call: ToolCall,
): PermissionRule | undefined {
  return rules.find((rule) => ruleMatches(rule, call));
}
