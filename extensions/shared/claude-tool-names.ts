/**
 * The one Claude -> pi tool-name table.
 *
 * It lived in `subagents/src/agent-defs.ts`, where it translates an agent
 * definition's `tools:` allowlist. The `permissions` extension needs the same
 * translation for rule heads (`Read(...)` has to gate pi's `read`), and two
 * copies of a security-relevant mapping is exactly the drift worth avoiding —
 * so it moved here and `agent-defs.ts` re-exports it.
 */

/**
 * One Claude tool can cover several pi tools (Claude's Glob spans pi's
 * find/fd/ls), so entries are lists.
 */
export const CLAUDE_TO_PI_TOOLS: Readonly<Record<string, readonly string[]>> = {
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

/** Claude's namespace for MCP servers: `mcp__<server>` or `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * pi tool names a Claude tool name stands for, or undefined when Claude's
 * vocabulary has no pi counterpart.
 */
export function claudeToolToPiTools(claudeTool: string) {
  return CLAUDE_TO_PI_TOOLS[claudeTool];
}
