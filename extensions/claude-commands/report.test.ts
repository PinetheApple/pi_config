import assert from "node:assert/strict";
import test from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { parseClaudeAccount } from "./src/accounts.ts";
import { buildContextReport } from "./src/context.ts";
import { pad } from "./src/format.ts";
import { buildHelpReport, summarizeDescription } from "./src/help.ts";
import { asReport, renderReportText, report } from "./src/report.ts";

function command(
  name: string,
  source: SlashCommandInfo["source"],
  description?: string,
): SlashCommandInfo {
  return {
    name,
    source,
    ...(description ? { description } : {}),
    sourceInfo: {
      path: `/tmp/${name}`,
      source: "test",
      scope: "user",
      origin: "top-level",
    },
  };
}

test("renderReportText lays out headings, lines and footer", () => {
  const text = renderReportText(
    report(
      "Title",
      [{ heading: "One", lines: ["a", "b"] }, { lines: ["c"] }],
      "note",
    ),
  );
  assert.equal(text, "Title\n\nOne\na\nb\n\nc\n\nnote");
});

test("pad keeps a separator even when the label overflows the column", () => {
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(pad("abcde", 5), "abcde  ");
  assert.equal(pad("abcdefg", 5), "abcdefg  ");
});

test("asReport rejects malformed data and keeps valid sections", () => {
  assert.equal(asReport(null), undefined);
  assert.equal(asReport({ title: "x" }), undefined);
  assert.equal(asReport({ sections: [] }), undefined);

  const value = asReport({
    title: "T",
    sections: [{ heading: "H", lines: ["a", 4, null] }, "junk", { lines: [] }],
    footer: 12,
  });
  assert.deepEqual(value, {
    title: "T",
    sections: [{ heading: "H", lines: ["a"] }, { lines: [] }],
  });
});

test("buildHelpReport groups commands by source and notes the built-in gap", () => {
  const result = buildHelpReport([
    command("usage", "extension", "Show usage"),
    command("plan", "prompt"),
    command("clear", "extension", "New session"),
    command("review", "skill", "Review code"),
  ]);

  assert.deepEqual(
    result.sections.map((section) => section.heading),
    ["Extensions (2)", "Prompts (1)", "Skills (1)"],
  );
  assert.ok(result.sections[0]?.lines[0]?.startsWith("/clear"));
  assert.ok(result.footer?.includes("/hotkeys"));
});

test("summarizeDescription collapses whitespace and truncates to one line", () => {
  assert.equal(summarizeDescription(undefined), "");
  assert.equal(summarizeDescription("  a\n  b  "), "a b");

  const long = summarizeDescription("x".repeat(200));
  assert.equal(long.length, 88);
  assert.ok(long.endsWith("…"));
});

test("buildHelpReport degrades when nothing is registered", () => {
  const result = buildHelpReport([]);
  assert.equal(result.sections.length, 1);
  assert.match(result.sections[0]?.lines[0] ?? "", /No extension/);
});

test("buildContextReport separates measured totals from estimates", () => {
  const result = buildContextReport({
    usage: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
    modelLabel: "anthropic/claude",
    fallbackContextWindow: undefined,
    systemPrompt: "x".repeat(400),
    contextEntries: [],
  });

  const overview = result.sections[0]?.lines.join("\n") ?? "";
  assert.match(overview, /40\.0k tokens/);
  assert.match(overview, /160\.0k tokens/);
  assert.match(overview, /20\.0%/);

  const breakdown = result.sections[1]?.lines.join("\n") ?? "";
  assert.match(breakdown, /System prompt\s+~100 tokens \(estimate\)/);
  assert.match(breakdown, /Context entries\s+0 \(exact\)/);
});

test("buildContextReport reports unknown usage honestly", () => {
  const result = buildContextReport({
    usage: { tokens: null, contextWindow: 200_000, percent: null },
    modelLabel: "anthropic/claude",
    fallbackContextWindow: 200_000,
    systemPrompt: "",
    contextEntries: [],
  });
  const overview = result.sections[0]?.lines.join("\n") ?? "";
  assert.match(overview, /Used\s+unknown/);
  assert.match(overview, /Remaining\s+unknown/);
});

test("parseClaudeAccount reads only non-secret identity fields", () => {
  const account = parseClaudeAccount({
    oauthAccount: {
      emailAddress: "person@example.com",
      displayName: "Person",
      organizationName: "Org",
      seatTier: "max",
    },
  });
  assert.deepEqual(account, {
    email: "person@example.com",
    displayName: "Person",
    organizationName: "Org",
    billingType: undefined,
    seatTier: "max",
  });

  assert.equal(parseClaudeAccount({}), undefined);
  assert.equal(parseClaudeAccount({ oauthAccount: {} }), undefined);
  assert.equal(parseClaudeAccount(null), undefined);
});
