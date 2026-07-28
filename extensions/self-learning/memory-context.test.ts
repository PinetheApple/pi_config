import assert from "node:assert/strict";
import test from "node:test";
import {
  composeBootstrap,
  projectMemoryIndexPath,
  projectSlug,
} from "./src/memory-context.ts";

test("the slug is the cwd with slashes replaced by dashes", () => {
  assert.equal(
    projectSlug("/home/pineapple/Work/github"),
    "-home-pineapple-Work-github",
  );
});

test("a claude worktree resolves to its parent project slug", () => {
  assert.equal(
    projectSlug(
      "/home/pineapple/Work/voice-research--claude-worktrees-turn-deepening",
    ),
    "-home-pineapple-Work-voice-research",
  );
});

test("the project index lives under the ai config projects tree", () => {
  const path = projectMemoryIndexPath("/home/pineapple/Development");
  assert.ok(
    path.endsWith(
      "/.config/ai/projects/-home-pineapple-Development/memory/MEMORY.md",
    ),
    path,
  );
});

test("nothing is injected when no source file has content", () => {
  assert.equal(
    composeBootstrap({
      persona: "",
      globalMemoryIndex: "",
      projectMemoryIndex: "",
    }),
    undefined,
  );
});

test("every present source becomes its own headed section", () => {
  const bootstrap = composeBootstrap({
    persona: "be terse",
    globalMemoryIndex: "- [A](a.md)",
    projectMemoryIndex: "- [B](b.md)",
  });
  assert.ok(bootstrap);
  assert.ok(bootstrap.startsWith("# Agent Session Bootstrap"));
  assert.ok(bootstrap.includes("## Persona\nbe terse"));
  assert.ok(bootstrap.includes("## Memory Index\n- [A](a.md)"));
  assert.ok(bootstrap.includes("## Project Memory Index\n- [B](b.md)"));
  assert.ok(bootstrap.includes("`auto-memory`"));
});

test("absent sources are omitted rather than left as empty headings", () => {
  const bootstrap = composeBootstrap({
    persona: "",
    globalMemoryIndex: "- [A](a.md)",
    projectMemoryIndex: "",
  });
  assert.ok(bootstrap);
  assert.ok(bootstrap.includes("## Memory Index"));
  assert.ok(!bootstrap.includes("## Persona"));
  assert.ok(!bootstrap.includes("## Project Memory Index"));
});
