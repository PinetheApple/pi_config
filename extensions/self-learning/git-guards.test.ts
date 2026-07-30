import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRunner } from "./src/exec.ts";
import {
  collectGitIdentity,
  identityChecksFor,
  identityDenial,
  prAttributionDenial,
  PR_ATTRIBUTION_DENIAL,
  type GitIdentity,
} from "./src/git-guards.ts";

const CLEAN_IDENTITY: GitIdentity = {
  repoRoot: "/repo",
  wantUser: "PinetheApple",
  wantEmail: "pinespace889@gmail.com",
  ghMapping: { state: "mapped" },
  localCommitEmail: "pinespace889@gmail.com",
};

test("only `gh pr ` commands are inspected for attribution", () => {
  assert.equal(
    prAttributionDenial("git commit -m 'Co-Authored-By: Claude'"),
    undefined,
  );
  assert.equal(
    prAttributionDenial("gh issue create --body 'Generated with Claude Code'"),
    undefined,
  );
});

test("every attribution form in the hook is denied", () => {
  for (const body of [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "Generated with Claude Code",
    "https://claude.com/claude-code",
    "🤖 generated",
  ]) {
    assert.equal(
      prAttributionDenial(`gh pr create --body "${body}"`),
      PR_ATTRIBUTION_DENIAL,
      body,
    );
  }
});

test("a clean gh pr command passes", () => {
  assert.equal(
    prAttributionDenial("gh pr create --title 'Fix parser' --body 'Fixes #12'"),
    undefined,
  );
});

test("a pipe between the keyword and claude defeats the match, as in the hook", () => {
  assert.equal(
    prAttributionDenial("gh pr create --body 'co-authored-by: x' | claude"),
    undefined,
  );
});

test("identity checks match the hook's case arms, gh list first", () => {
  assert.deepEqual(identityChecksFor("gh pr create"), { gh: true, git: false });
  assert.deepEqual(identityChecksFor("gh repo create x"), {
    gh: true,
    git: false,
  });
  assert.deepEqual(identityChecksFor("git push origin main"), {
    gh: true,
    git: true,
  });
  assert.deepEqual(identityChecksFor("git commit -m x"), {
    gh: false,
    git: true,
  });
  assert.deepEqual(identityChecksFor("gh pr create && git push"), {
    gh: true,
    git: false,
  });
});

test("commands outside the publishing set are not checked", () => {
  assert.equal(identityChecksFor("git status"), undefined);
  assert.equal(identityChecksFor("gh pr view 12"), undefined);
  assert.equal(identityChecksFor("ls -la"), undefined);
});

test("an unresolvable identity is denied regardless of which checks ran", () => {
  const denial = identityDenial(
    { gh: false, git: true },
    { ...CLEAN_IDENTITY, wantUser: "" },
  );
  assert.ok(denial?.startsWith("No git identity resolves for /repo"));
});

test("a matching identity is allowed", () => {
  assert.equal(
    identityDenial({ gh: true, git: true }, CLEAN_IDENTITY),
    undefined,
  );
});

test("an unmapped account is denied only when the gh check applies", () => {
  const unmapped: GitIdentity = {
    ...CLEAN_IDENTITY,
    ghMapping: { state: "unmapped" },
  };
  assert.equal(identityDenial({ gh: false, git: true }, unmapped), undefined);

  const denial = identityDenial({ gh: true, git: false }, unmapped);
  assert.equal(
    denial,
    "Wrong identity for /repo. no gh token is stored for 'PinetheApple', the " +
      "account this directory resolves to, so the gh wrapper cannot map it and " +
      "gh would fall back to its global active account (fix: gh auth login as " +
      "PinetheApple — not gh auth switch, which is global state that races " +
      "between sessions).",
  );
});

test("an env token that is not the identity's own token is denied", () => {
  const denial = identityDenial(
    { gh: true, git: false },
    {
      ...CLEAN_IDENTITY,
      ghMapping: {
        state: "env-token",
        variable: "GITHUB_TOKEN",
        matchesIdentity: false,
      },
    },
  );
  assert.equal(
    denial,
    "Wrong identity for /repo. GITHUB_TOKEN is set in the environment, which " +
      "the gh wrapper defers to instead of mapping this directory, and it is " +
      "not the token stored for 'PinetheApple' (fix: unset GITHUB_TOKEN and let " +
      "the wrapper select the account this directory resolves to).",
  );
});

test("an env token belonging to the identity is allowed", () => {
  assert.equal(
    identityDenial(
      { gh: true, git: true },
      {
        ...CLEAN_IDENTITY,
        ghMapping: {
          state: "env-token",
          variable: "GH_TOKEN",
          matchesIdentity: true,
        },
      },
    ),
    undefined,
  );
});

test("both problems are joined into one denial", () => {
  const denial = identityDenial(
    { gh: true, git: true },
    {
      ...CLEAN_IDENTITY,
      ghMapping: { state: "unmapped" },
      localCommitEmail: "wrong@example.com",
    },
  );
  assert.ok(denial?.includes("no gh token is stored for 'PinetheApple'"));
  assert.ok(denial?.includes("overrides user.email to 'wrong@example.com'"));
  assert.ok(denial?.endsWith("resolves to."));
});

/** Answers the probes `collectGitIdentity` makes; `gh` is scripted per test. */
function stubRunner(gh: { code: number; stdout: string }) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "gh") return { ...gh, stderr: "" };
    const arg = args.join(" ");
    if (arg === "rev-parse --show-toplevel")
      return { code: 0, stdout: "/repo\n", stderr: "" };
    if (arg === "config user.name")
      return { code: 0, stdout: "PinetheApple\n", stderr: "" };
    if (arg === "config user.email")
      return { code: 0, stdout: "pinespace889@gmail.com\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  return { run, calls };
}

/** Not a real token: the resolver only ever compares these opaque strings. */
const IDENTITY_SECRET = "stub-secret-for-PinetheApple";
const OTHER_SECRET = "stub-secret-for-jonathan-zuro";

function withEnv(
  t: { after: (fn: () => void) => void },
  values: Record<string, string | undefined>,
) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

test("a stored token for the directory's identity maps cleanly", async (t) => {
  withEnv(t, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined });
  const { run, calls } = stubRunner({
    code: 0,
    stdout: `${IDENTITY_SECRET}\n`,
  });

  const identity = await collectGitIdentity(run, "/repo", {
    gh: true,
    git: false,
  });
  assert.deepEqual(identity?.ghMapping, { state: "mapped" });
  assert.ok(calls.includes("gh auth token --user PinetheApple"));
  assert.equal(
    identityDenial({ gh: true, git: false }, identity!),
    undefined,
    "the wrapper will inject this account's token, so nothing is wrong",
  );
});

test("no stored token for the identity fails the guard closed", async (t) => {
  withEnv(t, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined });
  const { run } = stubRunner({ code: 1, stdout: "" });

  const identity = await collectGitIdentity(run, "/repo", {
    gh: true,
    git: false,
  });
  assert.deepEqual(identity?.ghMapping, { state: "unmapped" });
  assert.ok(
    identityDenial({ gh: true, git: false }, identity!)?.includes(
      "no gh token is stored for 'PinetheApple'",
    ),
  );
});

test("an inherited env token pre-empts the mapping and is compared", async (t) => {
  withEnv(t, { GH_TOKEN: OTHER_SECRET, GITHUB_TOKEN: undefined });
  const { run } = stubRunner({ code: 0, stdout: `${IDENTITY_SECRET}\n` });

  const identity = await collectGitIdentity(run, "/repo", {
    gh: true,
    git: false,
  });
  assert.deepEqual(identity?.ghMapping, {
    state: "env-token",
    variable: "GH_TOKEN",
    matchesIdentity: false,
  });
  const denial = identityDenial({ gh: true, git: false }, identity!);
  assert.ok(denial?.includes("GH_TOKEN is set in the environment"));
  assert.ok(
    !denial?.includes(OTHER_SECRET) && !denial?.includes(IDENTITY_SECRET),
    "no token material may reach a denial message",
  );
});

test("GH_TOKEN wins over GITHUB_TOKEN, as it does in gh", async (t) => {
  withEnv(t, { GH_TOKEN: IDENTITY_SECRET, GITHUB_TOKEN: OTHER_SECRET });
  const { run } = stubRunner({ code: 0, stdout: `${IDENTITY_SECRET}\n` });

  const identity = await collectGitIdentity(run, "/repo", {
    gh: true,
    git: false,
  });
  assert.deepEqual(identity?.ghMapping, {
    state: "env-token",
    variable: "GH_TOKEN",
    matchesIdentity: true,
  });
  assert.equal(identityDenial({ gh: true, git: false }, identity!), undefined);
});

test("gh is not spawned for a git-only check", async (t) => {
  withEnv(t, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined });
  const { run, calls } = stubRunner({
    code: 0,
    stdout: `${IDENTITY_SECRET}\n`,
  });

  const identity = await collectGitIdentity(run, "/repo", {
    gh: false,
    git: true,
  });
  assert.deepEqual(identity?.ghMapping, { state: "unchecked" });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("gh ")),
    [],
  );
});
