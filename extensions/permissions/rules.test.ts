import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstMatch,
  globToRegExp,
  parseRule,
  parseRules,
  ruleMatches,
} from "./src/rules.ts";

const CWD = "/home/pineapple/project";

function call(toolName: string, input: Record<string, unknown>) {
  return { toolName, input, cwd: CWD };
}

function rule(source: string, effect: "allow" | "ask" | "deny" = "allow") {
  const parsed = parseRule(source, effect);
  assert.ok(parsed, `expected ${source} to parse`);
  return parsed;
}

// --- Tool(glob) ---------------------------------------------------------------

test("Tool(glob) matches paths under the glob and nothing outside it", () => {
  const read = rule("Read(/home/pineapple/.config/ai/**)");
  assert.equal(
    ruleMatches(
      read,
      call("read", { path: "/home/pineapple/.config/ai/persona.md" }),
    ),
    true,
  );
  assert.equal(
    ruleMatches(
      read,
      call("read", { path: "/home/pineapple/.config/ai/memory/a/b.md" }),
    ),
    true,
  );
  assert.equal(
    ruleMatches(
      read,
      call("read", { path: "/home/pineapple/.config/other/x.md" }),
    ),
    false,
  );
});

test("a trailing /** also covers the directory itself", () => {
  const read = rule("Read(/home/pineapple/.claude/**)");
  assert.equal(
    ruleMatches(read, call("read", { path: "/home/pineapple/.claude" })),
    true,
  );
});

test("a mid-pattern ** crosses segments but a single * does not", () => {
  const edit = rule("Edit(/home/pineapple/.config/ai/projects/**/memory/**)");
  assert.equal(
    ruleMatches(
      edit,
      call("edit", {
        path: "/home/pineapple/.config/ai/projects/-home-x/memory/MEMORY.md",
      }),
    ),
    true,
  );
  assert.equal(
    ruleMatches(
      edit,
      call("edit", {
        path: "/home/pineapple/.config/ai/projects/-home-x/notes/MEMORY.md",
      }),
    ),
    false,
  );
  assert.equal(globToRegExp("/a/*/c").test("/a/b/c"), true);
  assert.equal(globToRegExp("/a/*/c").test("/a/b/x/c"), false);
});

test("an exact-file rule matches only that file", () => {
  const edit = rule("Edit(/home/pineapple/.config/ai/persona.md)");
  assert.equal(
    ruleMatches(
      edit,
      call("edit", { path: "/home/pineapple/.config/ai/persona.md" }),
    ),
    true,
  );
  assert.equal(
    ruleMatches(
      edit,
      call("edit", { path: "/home/pineapple/.config/ai/persona.md.bak" }),
    ),
    false,
  );
});

test("relative tool paths are resolved against the session cwd before matching", () => {
  const read = rule(`Read(${CWD}/**)`);
  assert.equal(ruleMatches(read, call("read", { path: "src/index.ts" })), true);
  assert.equal(
    ruleMatches(read, call("read", { path: "../elsewhere/x.ts" })),
    false,
  );
});

// --- Bash(cmd:*) --------------------------------------------------------------

test("Bash(cmd:*) is a prefix match, not a glob", () => {
  const bash = rule(
    "Bash(python3 /home/pineapple/.config/ai/skills/memory-init/scripts/extract_candidates.py:*)",
  );
  assert.equal(
    ruleMatches(
      bash,
      call("bash", {
        command:
          "python3 /home/pineapple/.config/ai/skills/memory-init/scripts/extract_candidates.py --limit 5",
      }),
    ),
    true,
  );
  assert.equal(
    ruleMatches(bash, call("bash", { command: "python3 /etc/evil.py" })),
    false,
  );
});

test("Bash(cmd) without :* is exact, so it cannot be extended with extra arguments", () => {
  const bash = rule("Bash(git status)");
  assert.equal(
    ruleMatches(bash, call("bash", { command: "git status" })),
    true,
  );
  assert.equal(
    ruleMatches(bash, call("bash", { command: "git status && rm -rf /" })),
    false,
  );
});

// --- bare Tool ----------------------------------------------------------------

test("a bare Tool matches any call to it, whatever the arguments", () => {
  const search = rule("WebSearch");
  assert.equal(
    ruleMatches(search, call("web_search", { query: "anything" })),
    true,
  );
  assert.equal(ruleMatches(search, call("web_fetch", { url: "x" })), false);
});

test("a bare Tool on a path tool ignores the path", () => {
  const read = rule("Read");
  assert.equal(ruleMatches(read, call("read", { path: "/etc/shadow" })), true);
});

// --- mcp__server --------------------------------------------------------------

test("mcp__server matches that server's direct tools in either naming form", () => {
  const mcp = rule("mcp__pencil");
  assert.equal(ruleMatches(mcp, call("mcp__pencil_draw", {})), true);
  assert.equal(ruleMatches(mcp, call("pencil_draw", {})), true);
  assert.equal(ruleMatches(mcp, call("mcp__other_draw", {})), false);
  assert.equal(ruleMatches(mcp, call("other_draw", {})), false);
});

test("mcp__server matches the pi-mcp-adapter gateway only when the call names that server", () => {
  const mcp = rule("mcp__pencil");
  assert.equal(ruleMatches(mcp, call("mcp", { server: "pencil" })), true);
  assert.equal(ruleMatches(mcp, call("mcp", { server: "other" })), false);
  // A gateway call that names no server must not inherit one server's rule.
  assert.equal(ruleMatches(mcp, call("mcp", {})), false);
});

test("mcp__server__tool narrows to the single tool", () => {
  const mcp = rule("mcp__pencil__draw");
  assert.equal(ruleMatches(mcp, call("mcp__pencil__draw", {})), true);
  assert.equal(ruleMatches(mcp, call("mcp__pencil__erase", {})), false);
});

// --- tool-name mapping ---------------------------------------------------------

test("rule heads go through the Claude -> pi tool-name mapping", () => {
  assert.equal(ruleMatches(rule("Read"), call("read", {})), true);
  assert.equal(ruleMatches(rule("Edit"), call("edit", {})), true);
  assert.equal(ruleMatches(rule("Write"), call("write", {})), true);
  assert.equal(ruleMatches(rule("Bash"), call("bash", { command: "x" })), true);
  assert.equal(ruleMatches(rule("WebFetch"), call("web_fetch", {})), true);
});

test("one Claude name can gate several pi tools", () => {
  const grep = rule("Grep");
  assert.equal(ruleMatches(grep, call("grep", {})), true);
  assert.equal(ruleMatches(grep, call("rg", {})), true);
  const glob = rule("Glob");
  for (const tool of ["find", "fd", "ls"]) {
    assert.equal(ruleMatches(glob, call(tool, {})), true, tool);
  }
});

test("MultiEdit maps onto pi's edit, and an unmapped head stays a literal pi tool name", () => {
  assert.equal(ruleMatches(rule("MultiEdit"), call("edit", {})), true);
  assert.equal(ruleMatches(rule("web_search"), call("web_search", {})), true);
  assert.equal(ruleMatches(rule("Read"), call("Read", {})), false);
});

test("a Tool(glob) rule cannot match a tool that exposes no path or command", () => {
  const custom = rule("subagent_spawn(/anything/**)");
  assert.equal(
    ruleMatches(custom, call("subagent_spawn", { title: "x" })),
    false,
  );
  assert.equal(
    ruleMatches(rule("subagent_spawn"), call("subagent_spawn", { title: "x" })),
    true,
  );
});

// --- parsing edge cases --------------------------------------------------------

test("blank and unparseable entries are skipped rather than becoming catch-all rules", () => {
  assert.equal(parseRule("   ", "allow"), undefined);
  assert.equal(parseRule("mcp__", "allow"), undefined);
  assert.deepEqual(parseRules(["", "  ", "Read"], "allow").length, 1);
  assert.deepEqual(parseRules(undefined, "allow"), []);
});

test("firstMatch returns the first matching rule in order", () => {
  const rules = [rule("Read(/a/**)"), rule("Read(/b/**)")];
  assert.equal(
    firstMatch(rules, call("read", { path: "/b/x" }))?.source,
    "Read(/b/**)",
  );
  assert.equal(firstMatch(rules, call("read", { path: "/c/x" })), undefined);
});
