export const MAX_LINT_NUDGES = 2;
export const MAX_OUTPUT_CHARS = 3_000;
/** The only exit code that means "the code has lint problems"; 2/127 mean the tool is broken. */
export const VIOLATIONS_FOUND = 1;

export const PYTHON_CONFIG_FILES = [
  "pyproject.toml",
  "setup.cfg",
  "ruff.toml",
  ".ruff.toml",
];

const PY_SUFFIXES = [".py"];
const JS_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const TRUNCATION_MARKER = "\n… (truncated)";

export const LINT_REPORT_PREAMBLE =
  "Formatters have run on the changed files. Lint still reports problems — fix " +
  "the ones your changes caused, then finish. Ignore any that are pre-existing " +
  "and unrelated to this task.";

function hasSuffix(path: string, suffixes: string[]) {
  return suffixes.some((suffix) => path.endsWith(suffix));
}

export function splitByLanguage(paths: string[]) {
  return {
    python: paths.filter((path) => hasSuffix(path, PY_SUFFIXES)),
    js: paths.filter((path) => hasSuffix(path, JS_SUFFIXES)),
  };
}

export interface LanguageChecks {
  formats: string[][];
  lint: string[] | undefined;
}

export interface PythonToolchain {
  hasConfig: boolean;
  hasRuff: boolean;
  hasBlack: boolean;
}

export function pythonChecks(
  toolchain: PythonToolchain,
  files: string[],
): LanguageChecks {
  if (!toolchain.hasConfig) return { formats: [], lint: undefined };
  if (toolchain.hasRuff) {
    return {
      formats: [["ruff", "format", ...files]],
      lint: ["ruff", "check", ...files],
    };
  }
  if (toolchain.hasBlack) {
    return { formats: [["black", "-q", ...files]], lint: undefined };
  }
  return { formats: [], lint: undefined };
}

export interface JsToolchain {
  hasPackageJson: boolean;
  packageJson: string;
}

const NPX = ["npx", "--no-install"];

export function jsChecks(
  toolchain: JsToolchain,
  files: string[],
): LanguageChecks {
  if (!toolchain.hasPackageJson) return { formats: [], lint: undefined };
  const declares = (tool: string) => toolchain.packageJson.includes(tool);

  if (declares("@biomejs/biome")) {
    return {
      formats: [[...NPX, "biome", "format", "--write", ...files]],
      lint: [...NPX, "biome", "lint", ...files],
    };
  }

  const formats = declares("prettier")
    ? [[...NPX, "prettier", "--write", "--log-level", "warn", ...files]]
    : [];
  const lint = declares("eslint") ? [...NPX, "eslint", ...files] : undefined;
  return { formats, lint };
}

export function truncate(text: string) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + TRUNCATION_MARKER;
}

export function buildLintReport(problems: string[]) {
  if (problems.length === 0) return undefined;
  return `${LINT_REPORT_PREAMBLE}\n\n${truncate(problems.join("\n\n"))}`;
}

/**
 * pi has no `stop_hook_active` equivalent, so the re-opened turn would settle
 * into another lint run forever. Bound the consecutive nudges instead.
 */
export function makeLintNudgeGuard(limit: number) {
  let used = 0;
  return {
    canNudge: () => used < limit,
    recordNudge: () => {
      used += 1;
    },
    reset: () => {
      used = 0;
    },
    used: () => used,
  };
}
