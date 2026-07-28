# self-learning — hooks

A port of my Claude Code hooks onto pi's extension events. Everything here is automatic; the
extension registers no tools and no commands, which is why it has no `SKILL.md` — there is nothing
for the model to invoke. The behavior it wants from the model is injected into the system prompt
instead.

## What runs where

| pi event | Ported hook | What it does |
| --- | --- | --- |
| `session_start` | — | Reads `[hooks].exclude_commands` from `~/.config/rtk/config.toml` once per session. |
| `before_agent_start` | `UserPromptSubmit` context injection | Appends persona + memory indexes to the system prompt. |
| `input` | `UserPromptSubmit` signal capture | Appends a one-line nudge when the prompt looks like durable signal. |
| `tool_call` | `PreToolUse` | PR-attribution guard, git-identity guard, rtk command rewriting. |
| `agent_settled` | `Stop` | Formats changed files, then re-opens the turn if lint still complains. |
| `session_shutdown` | — | Clears the in-memory session flags and the lint budget. |

## Prompt injection (`before_agent_start`)

Reads three files fresh on every turn, because the agent writes them mid-session:

- `~/.config/ai/persona.md`
- `~/.config/ai/memory/MEMORY.md`
- `~/.config/ai/projects/<slug>/memory/MEMORY.md`

The slug is `ctx.cwd` with `/` replaced by `-`, with a trailing `--claude-worktrees-<branch>`
stripped so a worktree shares its parent's memory store. Each present file becomes its own section
under an `# Agent Session Bootstrap` heading; absent files are omitted, and if all three are empty
the system prompt is left untouched.

## Signal capture (`input`)

Regex cues for corrections, confirmations, stated preferences, and external references. On a hit
the user's text is transformed to carry a `[self-learning]` marker line pointing at the
`auto-memory` skill. Prompts from `event.source === "extension"` are skipped, and the marker itself
is a re-entry guard so a transformed prompt is never nudged twice.

## Guards and rewriting (`tool_call`)

Only `bash` calls are inspected, and the guards run before the rewrite so a deny decision always
sees the command the model actually wrote.

1. **PR attribution.** A `gh pr ` command containing `Co-Authored-By: Claude`, "Generated with
   Claude Code", the claude-code URL, or 🤖 is blocked with an explanation.
2. **Git identity.** `git commit`, `git push`, and the publishing `gh` subcommands resolve the
   repo's identity via `git config` and gh's active account from `~/.config/gh/hosts.yml`. A
   mismatch is blocked. This **fails closed**: inside a git repo where neither `user.name` nor
   `user.email` resolves, the command is blocked with instructions rather than allowed. Outside a
   git repo `git rev-parse` fails and the check is skipped entirely.
3. **rtk.** Anything not on the exclusion list is piped through `rtk hook claude` and, when rtk
   returns a different command, replaced by mutating `event.input.command` in place. pi has no
   "rewrite the input" return value on `tool_call`, so in-place mutation is the mechanism. Any
   non-zero exit from rtk — including the binary not being installed — leaves the command alone.

## Post-turn lint (`agent_settled`)

The Claude Code `Stop` hook can refuse to let a turn end. pi has no equivalent: `agent_settled`
fires after the turn is already over and its return value cannot block anything. So the pass
formats the changed files in place and, if lint still reports problems, **re-opens** the turn with
`pi.sendMessage({ customType: "self-learning/lint-followup" }, { triggerTurn: true })`.

Consequences of that shape, all of them deliberate:

- **The nudge is bounded.** pi has no `stop_hook_active` flag, so a re-opened turn settles into
  another lint run forever. `MAX_LINT_NUDGES` (2) caps consecutive nudges; a settle with no
  problems resets the budget, as does `session_start`/`session_shutdown`.
- **Print mode gets no lint pass.** `sendMessage` with `triggerTurn` throws a stale-context error
  after a one-shot `--print` run, so only `tui` and `rpc` modes run the pass at all.
- **A shutdown mid-run drops the nudge.** The session flag is re-checked after the lint commands
  finish; if the session went away while lint was running, nothing is sent.

Which checks run is derived from the repo, never assumed: Python only when a `pyproject.toml`,
`setup.cfg`, or `ruff.toml` exists (ruff wins over black; black formats but contributes no
linter), JS/TS only when `package.json` declares the tool (biome short-circuits prettier+eslint).
Only exit code 1 counts as "violations found" — 2 and 127 mean the tool itself is broken and are
ignored. Reports are truncated at 3,000 characters.
