import assert from "node:assert/strict";
import test from "node:test";
import {
  identityChecksFor,
  identityDenial,
  parseGhActiveUser,
  prAttributionDenial,
  PR_ATTRIBUTION_DENIAL,
  type GitIdentity,
} from "./src/git-guards.ts";

const CLEAN_IDENTITY: GitIdentity = {
  repoRoot: "/repo",
  wantUser: "PinetheApple",
  wantEmail: "pinespace889@gmail.com",
  ghActiveUser: "PinetheApple",
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

test("a gh account mismatch is denied only when the gh check applies", () => {
  const mismatched = { ...CLEAN_IDENTITY, ghActiveUser: "someone-else" };
  assert.equal(identityDenial({ gh: false, git: true }, mismatched), undefined);

  const denial = identityDenial({ gh: true, git: false }, mismatched);
  assert.equal(
    denial,
    "Wrong identity for /repo. gh's active account is 'someone-else' but this " +
      "directory's git identity is 'PinetheApple' (fix: gh auth switch -u PinetheApple).",
  );
});

test("an unknown gh account is not a mismatch", () => {
  assert.equal(
    identityDenial(
      { gh: true, git: true },
      { ...CLEAN_IDENTITY, ghActiveUser: "" },
    ),
    undefined,
  );
});

test("both problems are joined into one denial", () => {
  const denial = identityDenial(
    { gh: true, git: true },
    {
      ...CLEAN_IDENTITY,
      ghActiveUser: "other",
      localCommitEmail: "wrong@example.com",
    },
  );
  assert.ok(denial?.includes("gh's active account is 'other'"));
  assert.ok(denial?.includes("overrides user.email to 'wrong@example.com'"));
  assert.ok(denial?.endsWith("resolves to."));
});

test("the last indented user: line in hosts.yml wins", () => {
  const hosts = [
    "github.com:",
    "    user: first",
    "    oauth_token: x",
    "gist.github.com:",
    "    user: second",
  ].join("\n");
  assert.equal(parseGhActiveUser(hosts), "second");
  assert.equal(parseGhActiveUser("github.com:\n    oauth_token: x"), "");
  assert.equal(parseGhActiveUser(""), "");
});
