import assert from "node:assert/strict";
import { test } from "node:test";
import { PERMISSION_MODES } from "../shared/permission-modes.ts";
import { decide, resolveUnattended } from "./src/decide.ts";
import { parseRules } from "./src/rules.ts";

const CWD = "/home/pineapple/project";

function call(toolName: string, input: Record<string, unknown> = {}) {
  return { toolName, input, cwd: CWD };
}

function rules(sets: { allow?: string[]; ask?: string[]; deny?: string[] }) {
  return {
    allow: parseRules(sets.allow, "allow"),
    ask: parseRules(sets.ask, "ask"),
    deny: parseRules(sets.deny, "deny"),
  };
}

const NO_RULES = rules({});

// --- deny > ask > allow --------------------------------------------------------

test("deny beats ask and allow for the same call", () => {
  const decision = decide({
    call: call("read", { path: "/secret/key" }),
    rules: rules({
      allow: ["Read(/secret/**)"],
      ask: ["Read(/secret/**)"],
      deny: ["Read(/secret/**)"],
    }),
    mode: "default",
  });
  assert.equal(decision.effect, "deny");
  assert.match(decision.reason, /Read\(\/secret\/\*\*\)/);
});

test("ask beats allow for the same call", () => {
  const decision = decide({
    call: call("read", { path: "/secret/key" }),
    rules: rules({ allow: ["Read(/secret/**)"], ask: ["Read(/secret/**)"] }),
    mode: "default",
  });
  assert.equal(decision.effect, "ask");
});

test("allow wins when nothing denies or asks", () => {
  const decision = decide({
    call: call("bash", { command: "git status" }),
    rules: rules({ allow: ["Bash(git status)"] }),
    mode: "default",
  });
  assert.equal(decision.effect, "allow");
});

test("a deny rule for a different path does not shadow an allow", () => {
  const decision = decide({
    call: call("read", { path: "/ok/x" }),
    rules: rules({ allow: ["Read(/ok/**)"], deny: ["Read(/secret/**)"] }),
    mode: "default",
  });
  assert.equal(decision.effect, "allow");
});

// --- modes ---------------------------------------------------------------------

test("default mode asks for mutating tools and allows read-only ones", () => {
  assert.equal(
    decide({
      call: call("bash", { command: "rm x" }),
      rules: NO_RULES,
      mode: "default",
    }).effect,
    "ask",
  );
  assert.equal(
    decide({
      call: call("write", { path: `${CWD}/a` }),
      rules: NO_RULES,
      mode: "default",
    }).effect,
    "ask",
  );
  assert.equal(
    decide({
      call: call("read", { path: "/etc/hosts" }),
      rules: NO_RULES,
      mode: "default",
    }).effect,
    "allow",
  );
  assert.equal(
    decide({
      call: call("ls", { path: "/" }),
      rules: NO_RULES,
      mode: "default",
    }).effect,
    "allow",
  );
});

test("acceptEdits auto-approves edits inside the cwd but still asks outside it", () => {
  const inside = decide({
    call: call("edit", { path: `${CWD}/src/a.ts` }),
    rules: NO_RULES,
    mode: "acceptEdits",
  });
  assert.equal(inside.effect, "allow");
  const outside = decide({
    call: call("edit", { path: "/etc/passwd" }),
    rules: NO_RULES,
    mode: "acceptEdits",
  });
  assert.equal(outside.effect, "ask");
});

test("acceptEdits does not extend to bash", () => {
  assert.equal(
    decide({
      call: call("bash", { command: "rm -rf /" }),
      rules: NO_RULES,
      mode: "acceptEdits",
    }).effect,
    "ask",
  );
});

test("plan mode denies every mutating tool and allows reads", () => {
  assert.equal(
    decide({
      call: call("edit", { path: `${CWD}/a` }),
      rules: NO_RULES,
      mode: "plan",
    }).effect,
    "deny",
  );
  assert.equal(
    decide({
      call: call("bash", { command: "ls" }),
      rules: NO_RULES,
      mode: "plan",
    }).effect,
    "deny",
  );
  assert.equal(
    decide({
      call: call("read", { path: `${CWD}/a` }),
      rules: NO_RULES,
      mode: "plan",
    }).effect,
    "allow",
  );
});

test("an unrecognised tool is treated as mutating, so a new tool arrives gated", () => {
  assert.equal(
    decide({ call: call("some_new_tool"), rules: NO_RULES, mode: "default" })
      .effect,
    "ask",
  );
  assert.equal(
    decide({ call: call("some_new_tool"), rules: NO_RULES, mode: "plan" })
      .effect,
    "deny",
  );
});

// --- bypassPermissions ----------------------------------------------------------

test("bypassPermissions allows what would otherwise ask", () => {
  const decision = decide({
    call: call("bash", { command: "rm -rf /" }),
    rules: rules({ ask: ["Bash"] }),
    mode: "bypassPermissions",
  });
  assert.equal(decision.effect, "allow");
});

test("deny rules still bite under bypassPermissions — a mode may only narrow", () => {
  const decision = decide({
    call: call("read", { path: "/secret/key" }),
    rules: rules({ deny: ["Read(/secret/**)"] }),
    mode: "bypassPermissions",
  });
  assert.equal(decision.effect, "deny");
});

// `bypassPermissions` is now reachable by cycling shift+tab, so the boundary it
// still respects is the only thing between a stray keystroke and an unguarded
// destructive call. Pin it on a mutating tool, in every mode.
test("deny beats every mode, including bypassPermissions, for mutating tools", () => {
  for (const mode of PERMISSION_MODES) {
    assert.equal(
      decide({
        call: call("bash", { command: "rm -rf /etc" }),
        rules: rules({ deny: ["Bash"], allow: ["Bash"] }),
        mode,
      }).effect,
      "deny",
      `mode ${mode} must not widen past a deny rule`,
    );
  }
});

// --- headless -------------------------------------------------------------------

test("an ask with no UI fails closed rather than falling through to allow", () => {
  const asked = decide({
    call: call("bash", { command: "x" }),
    rules: NO_RULES,
    mode: "default",
  });
  assert.equal(asked.effect, "ask");
  const unattended = resolveUnattended(asked);
  assert.equal(unattended.effect, "deny");
  assert.match(unattended.reason, /no interactive UI/);
});

test("resolveUnattended leaves allow and deny untouched", () => {
  const allowed = decide({
    call: call("read", { path: "/a" }),
    rules: NO_RULES,
    mode: "default",
  });
  assert.equal(resolveUnattended(allowed).effect, "allow");
  const denied = decide({
    call: call("edit", { path: "/a" }),
    rules: NO_RULES,
    mode: "plan",
  });
  assert.equal(resolveUnattended(denied).effect, "deny");
});

// --- the user's real rule set ----------------------------------------------------

test("the ported ~/.claude allow list behaves as written", () => {
  const ported = rules({
    allow: [
      "Read(/home/pineapple/.config/ai/**)",
      "Read(/home/pineapple/.claude/**)",
      "Edit(/home/pineapple/.config/ai/memory/**)",
      "Edit(/home/pineapple/.config/ai/skills/**)",
      "Edit(/home/pineapple/.config/ai/projects/**/memory/**)",
      "Edit(/home/pineapple/.config/ai/persona.md)",
      "Bash(python3 /home/pineapple/.config/ai/skills/memory-init/scripts/extract_candidates.py:*)",
      "WebSearch",
      "WebFetch",
      "mcp__pencil",
    ],
  });
  const allowed = (c: ReturnType<typeof call>) =>
    decide({ call: c, rules: ported, mode: "default" }).effect;

  assert.equal(
    allowed(
      call("edit", { path: "/home/pineapple/.config/ai/memory/user_x.md" }),
    ),
    "allow",
  );
  assert.equal(
    allowed(call("edit", { path: "/home/pineapple/.config/ai/persona.md" })),
    "allow",
  );
  assert.equal(
    allowed(
      call("edit", {
        path: "/home/pineapple/.config/ai/projects/-home-x/memory/MEMORY.md",
      }),
    ),
    "allow",
  );
  assert.equal(allowed(call("web_search", { query: "x" })), "allow");
  assert.equal(allowed(call("mcp__pencil_draw", {})), "allow");
  assert.equal(
    allowed(
      call("bash", {
        command:
          "python3 /home/pineapple/.config/ai/skills/memory-init/scripts/extract_candidates.py --n 3",
      }),
    ),
    "allow",
  );

  // Reads are allowed by the mode anyway; the edits outside the listed trees
  // are the ones the list is actually holding back.
  assert.equal(
    allowed(call("edit", { path: "/home/pineapple/.config/ai/agents/x.md" })),
    "ask",
  );
  assert.equal(
    allowed(call("bash", { command: "python3 /tmp/evil.py" })),
    "ask",
  );
});
