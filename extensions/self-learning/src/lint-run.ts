import { join } from "node:path";
import {
  fileExists,
  hasExecutable,
  readOptionalFile,
  type CommandRunner,
  type RunOptions,
} from "./exec.ts";
import {
  buildLintReport,
  jsChecks,
  PYTHON_CONFIG_FILES,
  pythonChecks,
  splitByLanguage,
  VIOLATIONS_FOUND,
  type LanguageChecks,
} from "./lint-check.ts";

const GIT_TIMEOUT_MS = 10_000;
const LINT_TIMEOUT_MS = 90_000;

async function repoRoot(run: CommandRunner, cwd: string) {
  const result = await run("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const root = result.stdout.trim();
  return result.code === 0 && root ? root : undefined;
}

/** Both commands emit bare newline-separated paths, so trimming cannot corrupt one. */
async function changedFiles(run: CommandRunner, root: string) {
  const options = { cwd: root, timeoutMs: GIT_TIMEOUT_MS };
  const results = await Promise.all([
    run("git", ["diff", "--name-only", "HEAD"], options),
    run("git", ["ls-files", "--others", "--exclude-standard"], options),
  ]);

  const names = new Set<string>();
  for (const result of results) {
    if (result.code !== 0) continue;
    for (const line of result.stdout.split("\n")) {
      if (line.trim()) names.add(line.trim());
    }
  }

  const paths = [...names].map((name) => join(root, name));
  const existing = await Promise.all(paths.map(fileExists));
  return paths.filter((_, index) => existing[index]);
}

async function loadPythonChecks(root: string, files: string[]) {
  const configPresence = await Promise.all(
    PYTHON_CONFIG_FILES.map((name) => fileExists(join(root, name))),
  );
  const [hasRuff, hasBlack] = await Promise.all([
    hasExecutable("ruff"),
    hasExecutable("black"),
  ]);
  return pythonChecks(
    { hasConfig: configPresence.includes(true), hasRuff, hasBlack },
    files,
  );
}

async function loadJsChecks(root: string, files: string[]) {
  const packageJsonPath = join(root, "package.json");
  const hasPackageJson = await fileExists(packageJsonPath);
  const packageJson = hasPackageJson
    ? await readOptionalFile(packageJsonPath)
    : "";
  return jsChecks({ hasPackageJson, packageJson }, files);
}

async function applyChecks(
  run: CommandRunner,
  options: RunOptions,
  checks: LanguageChecks,
) {
  for (const [command, ...args] of checks.formats) {
    await run(command, args, options);
  }
  if (!checks.lint) return undefined;

  const [command, ...args] = checks.lint;
  const result = await run(command, args, options);
  if (result.code !== VIOLATIONS_FOUND) return undefined;
  const report = `${result.stdout}${result.stderr}`.trim();
  return report || undefined;
}

/** Formats changed files in place and returns a report when lint still fails. */
export async function runLintCheck(run: CommandRunner, cwd: string) {
  const root = await repoRoot(run, cwd);
  if (!root) return undefined;

  const { python, js } = splitByLanguage(await changedFiles(run, root));
  if (python.length === 0 && js.length === 0) return undefined;

  const options = { cwd: root, timeoutMs: LINT_TIMEOUT_MS };
  const problems: string[] = [];
  if (python.length > 0) {
    const report = await applyChecks(
      run,
      options,
      await loadPythonChecks(root, python),
    );
    if (report) problems.push(report);
  }
  if (js.length > 0) {
    const report = await applyChecks(
      run,
      options,
      await loadJsChecks(root, js),
    );
    if (report) problems.push(report);
  }

  return buildLintReport(problems);
}
