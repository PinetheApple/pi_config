import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLintReport,
  jsChecks,
  LINT_REPORT_PREAMBLE,
  makeLintNudgeGuard,
  MAX_LINT_NUDGES,
  MAX_OUTPUT_CHARS,
  pythonChecks,
  splitByLanguage,
  truncate,
} from "./src/lint-check.ts";

test("changed files are split by the hook's suffix lists", () => {
  const { python, js } = splitByLanguage([
    "/r/a.py",
    "/r/b.ts",
    "/r/c.tsx",
    "/r/d.mjs",
    "/r/e.md",
    "/r/f.rs",
  ]);
  assert.deepEqual(python, ["/r/a.py"]);
  assert.deepEqual(js, ["/r/b.ts", "/r/c.tsx", "/r/d.mjs"]);
});

test("python checks are skipped when the repo declares no python config", () => {
  const checks = pythonChecks(
    { hasConfig: false, hasRuff: true, hasBlack: true },
    ["a.py"],
  );
  assert.deepEqual(checks, { formats: [], lint: undefined });
});

test("ruff wins over black and is the only python linter", () => {
  const checks = pythonChecks(
    { hasConfig: true, hasRuff: true, hasBlack: true },
    ["a.py"],
  );
  assert.deepEqual(checks.formats, [["ruff", "format", "a.py"]]);
  assert.deepEqual(checks.lint, ["ruff", "check", "a.py"]);
});

test("black formats but contributes no linter", () => {
  const checks = pythonChecks(
    { hasConfig: true, hasRuff: false, hasBlack: true },
    ["a.py"],
  );
  assert.deepEqual(checks.formats, [["black", "-q", "a.py"]]);
  assert.equal(checks.lint, undefined);
});

test("js checks are skipped without a package.json", () => {
  assert.deepEqual(
    jsChecks({ hasPackageJson: false, packageJson: "" }, ["a.ts"]),
    {
      formats: [],
      lint: undefined,
    },
  );
});

test("biome short-circuits prettier and eslint", () => {
  const checks = jsChecks(
    {
      hasPackageJson: true,
      packageJson: '{"devDependencies":{"@biomejs/biome":"1","prettier":"3"}}',
    },
    ["a.ts"],
  );
  assert.deepEqual(checks.formats, [
    ["npx", "--no-install", "biome", "format", "--write", "a.ts"],
  ]);
  assert.deepEqual(checks.lint, [
    "npx",
    "--no-install",
    "biome",
    "lint",
    "a.ts",
  ]);
});

test("prettier formats and eslint lints when both are declared", () => {
  const checks = jsChecks(
    {
      hasPackageJson: true,
      packageJson: '{"devDependencies":{"prettier":"3","eslint":"9"}}',
    },
    ["a.ts"],
  );
  assert.deepEqual(checks.formats, [
    [
      "npx",
      "--no-install",
      "prettier",
      "--write",
      "--log-level",
      "warn",
      "a.ts",
    ],
  ]);
  assert.deepEqual(checks.lint, ["npx", "--no-install", "eslint", "a.ts"]);
});

test("a prettier-only repo formats without ever blocking", () => {
  const checks = jsChecks(
    {
      hasPackageJson: true,
      packageJson: '{"devDependencies":{"prettier":"3"}}',
    },
    ["a.ts"],
  );
  assert.equal(checks.formats.length, 1);
  assert.equal(checks.lint, undefined);
});

test("oversized reports are truncated with a marker", () => {
  const short = "x".repeat(MAX_OUTPUT_CHARS);
  assert.equal(truncate(short), short);

  const long = truncate("x".repeat(MAX_OUTPUT_CHARS + 100));
  assert.ok(long.startsWith("x".repeat(MAX_OUTPUT_CHARS)));
  assert.ok(long.endsWith("(truncated)"));
});

test("no problems means no report", () => {
  assert.equal(buildLintReport([]), undefined);
});

test("the report carries the preamble and every problem", () => {
  const report = buildLintReport(["ruff: E501", "eslint: no-unused-vars"]);
  assert.ok(report);
  assert.ok(report.startsWith(LINT_REPORT_PREAMBLE));
  assert.ok(report.includes("ruff: E501"));
  assert.ok(report.includes("eslint: no-unused-vars"));
});

test("the nudge guard stops after the bounded number of attempts", () => {
  const guard = makeLintNudgeGuard(MAX_LINT_NUDGES);
  assert.equal(MAX_LINT_NUDGES, 2);

  assert.equal(guard.canNudge(), true);
  guard.recordNudge();
  assert.equal(guard.canNudge(), true);
  guard.recordNudge();
  assert.equal(guard.canNudge(), false);
  assert.equal(guard.used(), 2);
});

test("further attempts past the limit never re-open the budget", () => {
  const guard = makeLintNudgeGuard(MAX_LINT_NUDGES);
  for (let attempt = 0; attempt < 10; attempt += 1) guard.recordNudge();
  assert.equal(guard.canNudge(), false);
});

test("a clean settle resets the budget", () => {
  const guard = makeLintNudgeGuard(MAX_LINT_NUDGES);
  guard.recordNudge();
  guard.recordNudge();
  assert.equal(guard.canNudge(), false);
  guard.reset();
  assert.equal(guard.canNudge(), true);
  assert.equal(guard.used(), 0);
});

test("a zero limit disables nudging entirely", () => {
  assert.equal(makeLintNudgeGuard(0).canNudge(), false);
});
