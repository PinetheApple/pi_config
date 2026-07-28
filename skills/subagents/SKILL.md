---
name: subagents
description: invoke this skill when the user asks you to use subagents
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn subagents. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Agent Definitions

The `agent` parameter names one of the definitions in `~/.config/ai/agents/*.md` (Claude subagent frontmatter). The spawn tool's description lists the catalog, and the parameter is an enum of the names it found, so an unknown name is rejected with the list of known ones. Picking an agent applies its system prompt, its tool restrictions, and its default model; omit it for a general-purpose subagent.

What to expect when you use one:

- **Tools are translated, and drops are visible.** Claude tool names map onto pi's (`Grep` → `grep`/`rg`, `Glob` → `find`/`fd`/`ls`, and so on). `Task`/`Agent` are always refused — children cannot spawn children — and `mcp__*` tools have no pi equivalent. Every dropped tool produces a warning shown to the user and repeated in the spawn result, so read the result rather than assuming the child got what the definition asked for. On the `claude` harness nothing is translated; on `codex`, tool restrictions do not exist at all and the definition's list is ignored with a warning.
- **Model aliases stay inside the current provider.** `opus`/`sonnet`/`haiku` resolve only among models of the session's own provider, so an `opus` agent is never silently rerouted onto a metered endpoint. When there is no match the child falls back to the session default and says so in a warning.
- **An explicit `model` on the spawn call wins** over the agent's declared model.
- **Definitions are read once, at extension load.** Editing an agent `.md` mid-session changes nothing until `/reload`, because the tool schema bakes the agent names in.

## Pi Harness

**Harness:** `pi`
**Prompt nicknames:** “pi”, “pi agent”, “pi subagent”
**Best default:** Use when the user does not request another harness. It inherits the parent model and thinking level when `model` or `reasoning_effort` is omitted.

Do not use models from the Anthropic provider even if one appears in the model list.

Pi can use any model shown by `pi --list-models`. Prefer `provider/model-id`; a bare model id only works when unambiguous. Common picks in this environment:

This environment is on OpenCode Zen's free tier — only `*-free` models are reachable. Paid Zen models
and every `opencode-go/*` model return a billing error.

| Model                                | Use for                                        | Recommended effort |
| ------------------------------------ | ---------------------------------------------- | ------------------ |
| inherited parent model (default)     | anything not listed below                       | inherited          |
| `opencode/nemotron-3-ultra-free`     | long context (1M), wide refactors               | `high`             |
| `opencode/deepseek-v4-flash-free`    | standard coding work (parent default)           | `medium`           |
| `opencode/north-mini-code-free`      | mechanical, high-volume (renames, boilerplate)  | `low`              |

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. These map directly to pi thinking levels.

## Claude Code Harness

**Harness:** `claude`
**Prompt nicknames:** “claude”, “Claude Code”, “claude agent”, “claude subagent”, "cc"
**Best default:** match the model and effort to the task using the matrix below. When the shape is unclear, use `sonnet` at `medium`.

| Task shape                                                    | Model hint | Recommended effort |
| ------------------------------------------------------------- | ---------- | ------------------ |
| mechanical: renames, boilerplate, log lines, regex             | `haiku`    | `low`              |
| standard: features, tests, known bugs, contained refactors     | `sonnet`   | `medium`           |
| hard: tricky debugging, cross-cutting refactors, unknown code  | `opus`     | `high`             |
| deep: architecture calls, concurrency, perf hunts              | `opus`     | `xhigh`            |

Do not use Fable models on this harness.

The model hint is passed straight through to the Claude Code CLI, so any alias or model id that account exposes via `/model` is valid.

**Budget:** this harness spends the user's Claude subscription quota, shared with their interactive Claude Code sessions. Do not route bulk or repetitive work here — that belongs on the pi harness. Raise effort only when the task actually needs the thinking tokens.

**Thinking budgets:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The extension maps these to Claude thinking-token budgets: 0, 1,024, 4,096, 10,000, 16,000, 32,000, and 63,999 tokens respectively.

Requires Claude Code to be installed and authenticated.

## Codex Harness

**Harness:** `codex`
**Prompt nicknames:** “codex”, “Codex CLI”, “codex agent”, “codex subagent”
**Best default:** `gpt-5.6-sol` with `high` effort for coding work. Do not use anything other than sol unless the user specifically asks for it.

**Not configured on this machine:** the Codex CLI is not installed or authenticated. Do not pick this harness unless the user says they have set it up.

| Model           | Recommended effort |
| --------------- | ------------------ |
| `gpt-5.6-sol`   | `high`             |
| `gpt-5.6-terra` | `high`             |
| `gpt-5.6-luna`  | `high`             |

**Thinking budgets accepted by the extension:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Codex maps these to the nearest effort supported by the selected model; `off`/`minimal` become `minimal`, while `max` becomes the highest extension-supported Codex effort.

Requires the Codex CLI to be installed and authenticated.

## Spawn and Manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and optional `agent`, `working_dir`, `model`, and `reasoning_effort`. At most four subagents run concurrently.

`/subagent-spawn` does the same thing from the command line: `/subagent-spawn [--agent <name>] [--harness pi|claude|codex] [--model <id>] [--effort <level>] [--dir <path>] [--name <title>] <prompt>`. With no flags it prompts interactively.

- `subagent_check({ id })`: peek without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively. In that list, `x` aborts a running run
  and `d` deletes a settled one (transcript included); settled runs otherwise stay listed.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.
