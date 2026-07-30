import type { CommandRunner, RunOptions } from "./exec.ts";

const GIT_TIMEOUT_MS = 5_000;

const PR_COMMAND_MARKER = "gh pr ";
const AI_ATTRIBUTION =
  /co-authored-by[^|]*claude|generated with[^|]*claude|claude\.com\/claude-code|🤖/i;

export const PR_ATTRIBUTION_DENIAL =
  "Blocked: this 'gh pr' command carries AI attribution (Co-Authored-By: Claude / " +
  "'Generated with Claude Code' / 🤖 / claude-code URL). Remove it from the PR title " +
  "and body, then retry. User rule: no Claude attribution in PRs or commits.";

export function prAttributionDenial(command: string) {
  if (!command.includes(PR_COMMAND_MARKER)) return undefined;
  return AI_ATTRIBUTION.test(command) ? PR_ATTRIBUTION_DENIAL : undefined;
}

const PUBLISHING_GH_COMMANDS = [
  "gh issue create",
  "gh pr create",
  "gh issue comment",
  "gh pr comment",
  "gh release create",
  "gh gist create",
  "gh repo create",
];

export interface IdentityChecks {
  gh: boolean;
  git: boolean;
}

export function identityChecksFor(command: string): IdentityChecks | undefined {
  if (PUBLISHING_GH_COMMANDS.some((marker) => command.includes(marker))) {
    return { gh: true, git: false };
  }
  if (command.includes("git push")) return { gh: true, git: true };
  if (command.includes("git commit")) return { gh: false, git: true };
  return undefined;
}

/**
 * How the ~/scripts/gh wrapper will resolve a token for this directory. Carries
 * no token material: the comparison happens where the values are read, and only
 * its outcome travels.
 */
export type GhTokenMapping =
  /** The gh check does not apply, so no lookup ran. */
  | { state: "unchecked" }
  /** A token is stored for `wantUser` and the wrapper is free to inject it. */
  | { state: "mapped" }
  /** No token is stored for `wantUser`, so the wrapper cannot map this repo. */
  | { state: "unmapped" }
  /** An inherited env token pre-empts the wrapper's mapping entirely. */
  | { state: "env-token"; variable: string; matchesIdentity: boolean };

export interface GitIdentity {
  repoRoot: string;
  wantUser: string;
  wantEmail: string;
  ghMapping: GhTokenMapping;
  localCommitEmail: string;
}

function ghMappingProblem(mapping: GhTokenMapping, wantUser: string) {
  switch (mapping.state) {
    case "unmapped":
      return (
        `no gh token is stored for '${wantUser}', the account this directory ` +
        "resolves to, so the gh wrapper cannot map it and gh would fall back to " +
        `its global active account (fix: gh auth login as ${wantUser} — not ` +
        "gh auth switch, which is global state that races between sessions)"
      );
    case "env-token":
      return mapping.matchesIdentity
        ? undefined
        : `${mapping.variable} is set in the environment, which the gh wrapper ` +
            "defers to instead of mapping this directory, and it is not the token " +
            `stored for '${wantUser}' (fix: unset ${mapping.variable} and let the ` +
            "wrapper select the account this directory resolves to)";
    default:
      return undefined;
  }
}

export function identityDenial(
  checks: IdentityChecks,
  identity: GitIdentity,
): string | undefined {
  const { repoRoot, wantUser, wantEmail, ghMapping, localCommitEmail } =
    identity;

  if (!wantUser || !wantEmail) {
    return (
      `No git identity resolves for ${repoRoot} — ~/.gitconfig has no includeIf ` +
      "zone covering it, so the correct account cannot be determined. Add one, " +
      "or set user.name/user.email in this repo."
    );
  }

  const problems: string[] = [];
  const ghProblem = checks.gh
    ? ghMappingProblem(ghMapping, wantUser)
    : undefined;
  if (ghProblem) problems.push(ghProblem);
  if (checks.git && localCommitEmail && localCommitEmail !== wantEmail) {
    problems.push(
      `this repo overrides user.email to '${localCommitEmail}', against the ` +
        `'${wantEmail}' its directory resolves to`,
    );
  }
  if (problems.length === 0) return undefined;

  const detail = problems.map((problem) => `${problem}. `).join("");
  return `Wrong identity for ${repoRoot}. ${detail}`.trimEnd();
}

/** gh prefers GH_TOKEN, and the wrapper skips its mapping if either is set. */
const GH_TOKEN_VARIABLES = ["GH_TOKEN", "GITHUB_TOKEN"];

function inheritedGhToken() {
  for (const variable of GH_TOKEN_VARIABLES) {
    const value = process.env[variable];
    if (value) return { variable, value };
  }
  return undefined;
}

/**
 * Verifies the wrapper's mapping rather than gh's global active account: it
 * looks up `wantUser`'s stored token, which is a local keyring read that no env
 * token influences, and never lets that value out of this function.
 */
async function resolveGhMapping(
  run: CommandRunner,
  options: RunOptions,
  wantUser: string,
): Promise<GhTokenMapping> {
  const stored = await run(
    "gh",
    ["auth", "token", "--user", wantUser],
    options,
  );
  const expected = stored.code === 0 ? stored.stdout.trim() : "";
  if (!expected) return { state: "unmapped" };

  const inherited = inheritedGhToken();
  if (!inherited) return { state: "mapped" };
  return {
    state: "env-token",
    variable: inherited.variable,
    matchesIdentity: inherited.value === expected,
  };
}

export async function collectGitIdentity(
  run: CommandRunner,
  cwd: string,
  checks: IdentityChecks,
): Promise<GitIdentity | undefined> {
  const options = { cwd, timeoutMs: GIT_TIMEOUT_MS };
  const root = await run("git", ["rev-parse", "--show-toplevel"], options);
  if (root.code !== 0 || !root.stdout.trim()) return undefined;

  const [user, email, localEmail] = await Promise.all([
    run("git", ["config", "user.name"], options),
    run("git", ["config", "user.email"], options),
    run("git", ["config", "--get", "--local", "user.email"], options),
  ]);
  const wantUser = user.stdout.trim();

  return {
    repoRoot: root.stdout.trim(),
    wantUser,
    wantEmail: email.stdout.trim(),
    ghMapping:
      checks.gh && wantUser
        ? await resolveGhMapping(run, options, wantUser)
        : { state: "unchecked" },
    localCommitEmail: localEmail.stdout.trim(),
  };
}
