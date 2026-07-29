import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  CORE_DISCOVERED_SKILL_ROOTS,
  PROJECT_CONFIG_ROOTS,
} from "../shared/project-config-roots.ts";
import createExtension from "./index.ts";
import { PROJECT_SKILLS_SUBDIR, projectSkillPaths } from "./src/skill-roots.ts";

function repoWithSkills(roots: Record<string, readonly string[]>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-project-skills-"));
  for (const [configRoot, skills] of Object.entries(roots)) {
    for (const skill of skills) {
      const dir = path.join(root, configRoot, PROJECT_SKILLS_SUBDIR, skill);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${skill}\ndescription: From ${configRoot}.\n---\n\nBody.\n`,
      );
    }
  }
  return root;
}

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

const EXTRA_ROOTS = PROJECT_CONFIG_ROOTS.filter(
  (root) => !CORE_DISCOVERED_SKILL_ROOTS.includes(root),
);

test("every root pi core misses contributes its skills directory", () => {
  const cwd = repoWithSkills(
    Object.fromEntries(PROJECT_CONFIG_ROOTS.map((root) => [root, ["alpha"]])),
  );
  assert.deepEqual(
    projectSkillPaths({ cwd, projectTrusted: true }),
    EXTRA_ROOTS.map((root) => path.join(cwd, root, PROJECT_SKILLS_SUBDIR)),
  );
});

test("roots pi core already loads are not contributed twice", () => {
  const cwd = repoWithSkills({ ".pi": ["alpha"], ".agents": ["beta"] });
  assert.deepEqual(projectSkillPaths({ cwd, projectTrusted: true }), []);
});

test("contributed paths are ordered highest precedence first", () => {
  const cwd = repoWithSkills({ ".ai": ["dup"], ".claude": ["dup"] });
  const paths = projectSkillPaths({ cwd, projectTrusted: true });
  // Core keeps the first declaration of a skill name, so ordering is the
  // dedupe rule: `.claude` must be offered ahead of `.ai`.
  assert.deepEqual(paths, [
    path.join(cwd, ".claude", PROJECT_SKILLS_SUBDIR),
    path.join(cwd, ".ai", PROJECT_SKILLS_SUBDIR),
  ]);
});

test("a root without a skills directory is a silent no-op", () => {
  const cwd = repoWithSkills({ ".claude": ["alpha"] });
  assert.deepEqual(projectSkillPaths({ cwd, projectTrusted: true }), [
    path.join(cwd, ".claude", PROJECT_SKILLS_SUBDIR),
  ]);
});

test("a skill named in both .pi and .claude collapses, .pi winning", () => {
  const cwd = repoWithSkills({ ".pi": ["dup"], ".claude": ["dup", "extra"] });
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-dir-"));
  const loaded = loadSkills({
    cwd,
    agentDir,
    includeDefaults: true,
    skillPaths: projectSkillPaths({ cwd, projectTrusted: true }),
  });
  const dup = loaded.skills.filter((skill) => skill.name === "dup");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].description, "From .pi.");
  // Collapsing a name must not cost the root its other skills.
  assert.ok(loaded.skills.some((skill) => skill.name === "extra"));
});

test("an untrusted project contributes nothing from any root", () => {
  const cwd = repoWithSkills(
    Object.fromEntries(PROJECT_CONFIG_ROOTS.map((root) => [root, ["alpha"]])),
  );
  assert.deepEqual(projectSkillPaths({ cwd, projectTrusted: false }), []);
});

test("discovery binds to the session cwd, not the process cwd", () => {
  const session = repoWithSkills({ ".claude": ["session-scoped"] });
  const other = repoWithSkills({ ".claude": ["process-scoped"] });
  withProcessCwd(other, () => {
    const paths = projectSkillPaths({ cwd: session, projectTrusted: true });
    assert.deepEqual(paths, [
      path.join(session, ".claude", PROJECT_SKILLS_SUBDIR),
    ]);
  });
});

// --- The registered handler ------------------------------------------------------

/** Capture the `resources_discover` handler the extension registers. */
function discoverHandler() {
  let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
  const pi = { on: (_event: string, fn: typeof handler) => (handler = fn) };
  createExtension(pi as never);
  return (options: { cwd: string; projectTrusted: boolean }) =>
    handler?.(
      { type: "resources_discover", cwd: options.cwd, reason: "startup" },
      { isProjectTrusted: () => options.projectTrusted },
    ) as { skillPaths: string[] };
}

test("the handler reads the event cwd and the session's trust decision", () => {
  const session = repoWithSkills({ ".claude": ["session-scoped"] });
  const other = repoWithSkills({ ".claude": ["process-scoped"] });
  const discover = discoverHandler();
  withProcessCwd(other, () => {
    assert.deepEqual(discover({ cwd: session, projectTrusted: true }), {
      skillPaths: [path.join(session, ".claude", PROJECT_SKILLS_SUBDIR)],
    });
    assert.deepEqual(discover({ cwd: session, projectTrusted: false }), {
      skillPaths: [],
    });
  });
});
