import { homedir } from "node:os";
import { join } from "node:path";
import { readOptionalFile, type CommandRunner } from "./exec.ts";

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

export interface GitIdentity {
  repoRoot: string;
  wantUser: string;
  wantEmail: string;
  ghActiveUser: string;
  localCommitEmail: string;
}

export function identityDenial(
  checks: IdentityChecks,
  identity: GitIdentity,
): string | undefined {
  const { repoRoot, wantUser, wantEmail, ghActiveUser, localCommitEmail } =
    identity;

  if (!wantUser || !wantEmail) {
    return (
      `No git identity resolves for ${repoRoot} — ~/.gitconfig has no includeIf ` +
      "zone covering it, so the correct account cannot be determined. Add one, " +
      "or set user.name/user.email in this repo."
    );
  }

  const problems: string[] = [];
  if (checks.gh && ghActiveUser && ghActiveUser !== wantUser) {
    problems.push(
      `gh's active account is '${ghActiveUser}' but this directory's git identity ` +
        `is '${wantUser}' (fix: gh auth switch -u ${wantUser})`,
    );
  }
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

/** Mirrors the hook's awk over hosts.yml: the last indented `user:` line wins. */
export function parseGhActiveUser(hostsYaml: string) {
  let user = "";
  for (const line of hostsYaml.split("\n")) {
    const match = /^\s+user:\s+(\S+)/.exec(line);
    if (match) user = match[1];
  }
  return user;
}

function ghHostsPath() {
  const base = process.env.GH_CONFIG_DIR || join(homedir(), ".config", "gh");
  return join(base, "hosts.yml");
}

export async function collectGitIdentity(
  run: CommandRunner,
  cwd: string,
): Promise<GitIdentity | undefined> {
  const options = { cwd, timeoutMs: GIT_TIMEOUT_MS };
  const root = await run("git", ["rev-parse", "--show-toplevel"], options);
  if (root.code !== 0 || !root.stdout.trim()) return undefined;

  const [user, email, localEmail, hostsYaml] = await Promise.all([
    run("git", ["config", "user.name"], options),
    run("git", ["config", "user.email"], options),
    run("git", ["config", "--get", "--local", "user.email"], options),
    readOptionalFile(ghHostsPath()),
  ]);

  return {
    repoRoot: root.stdout.trim(),
    wantUser: user.stdout.trim(),
    wantEmail: email.stdout.trim(),
    ghActiveUser: parseGhActiveUser(hostsYaml),
    localCommitEmail: localEmail.stdout.trim(),
  };
}
