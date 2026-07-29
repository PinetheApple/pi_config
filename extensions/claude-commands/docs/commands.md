# claude-commands

Claude Code slash commands that pi does not already ship. Nothing here duplicates a pi built-in.

| Command | Behavior |
| --- | --- |
| `/help` | Lists the extension, prompt, and skill commands `pi.getCommands()` can see. |
| `/context` | What occupies the context window, in a dismissable overlay. |
| `/status` | Environment, session, and provider auth state. |
| `/usage` | Token usage and plan quota, in a dismissable overlay. |
| `/clear` | Alias for `/new`, via `ctx.newSession()`. |
| `/config` | Points at the built-in `/settings`. |
| `/rewind` | Points at the built-in `/tree`. |

`/cost` is deliberately absent: everything it would have shown is a section of `/usage`.

`/config` and `/rewind` cannot do more than point. Built-in interactive commands are dispatched by
the interactive layer and are not reachable through `pi.getCommands()` or any other ExtensionAPI
method, and reimplementing their selectors would mean rebuilding state pi does not expose.
Prefilling the editor was tried and rejected — the text survives until the user submits, so
whatever they type next gets concatenated onto it and sent as a prompt.

`/help` and `/status` deliver a `claude-commands-report` custom entry: persisted in the session
JSONL, rendered by a registered entry renderer, and never sent to the model. Outside the TUI they
degrade to a plain-text `ctx.ui.notify`.

`/context` and `/usage` are overlays (`ui.custom`) built from the shared panel machinery in
`src/panel/`: gauge, text, and table rows laid out by `src/panel/layout.ts`, painted by
`src/panel/overlay.ts`, and rendered as plain text by the same layout code outside the TUI. They
persist nothing.

## `/context` attribution

Two numbers are measured: the context window and the used total, both from the provider's report
for its last request (`ctx.getContextUsage()`). Everything else is pi's own 4-chars-per-token
estimate over exactly the text pi would send, so categories are comparable to each other but do not
add up to the measured total.

| Category | Source | Note |
| --- | --- | --- |
| System prompt | `ctx.getSystemPrompt()` minus the fragments attributed below | Base prompt, tool list, guidelines. |
| Project instructions | `getSystemPromptOptions().contextFiles` | Per file; a file is only counted when its content is actually present in the prompt. |
| Skills catalog | `formatSkillsForPrompt()` over `getSystemPromptOptions().skills` | Names and descriptions only — skill bodies are read on demand. Skills with `disable-model-invocation` are excluded, as they are from the prompt. |
| Tool schemas | `pi.getAllTools()` filtered by `pi.getActiveTools()` | Name, description, JSON schema. Reported as unavailable, not zero, when the runtime does not bind those actions (`pi -p`). |
| User messages, Assistant replies, Assistant reasoning, Tool calls, Tool results, Terminal commands, Extension messages, Summaries | `sessionEntryToContextMessages()` over `ctx.sessionManager.buildContextEntries()` | Assistant content is split per block type; tool results are additionally grouped per tool. `!!` bash output is skipped, matching `convertToLlm()`. |
| Images | The same messages | Counted separately at pi's own flat 4,800-char allowance, so base64 payloads never inflate the text categories. |
| Free space | Window minus the measured total, or the estimated one when no usage has been reported | The note says which. |

MCP tool schemas have no category: pi has no MCP concept, so an MCP-backed tool arrives through an
extension and is already counted under Tool schemas.

## `/usage` sources

`/usage` is an overlay (`ui.custom`), not a transcript entry, so it leaves no residue in the
session. It reads four independent local sources and each one degrades to a one-line reason when it
is unavailable. The section headings name the source, because the whole point is that overlapping
numbers come from different places:

| Section | Source | What it counts |
| --- | --- | --- |
| **Claude Code plan** | `https://api.anthropic.com/api/oauth/usage`, authorized with the token in `~/.claude/.credentials.json` | Plan quota utilization. The only section with bars, because it is the only one with a published limit. |
| **opencode via pi** | pi's own session JSONLs under `~/.pi/agent/sessions/` | Turns **pi** ran through an `opencode`/`opencode-go` provider — a subset of the pi section below, and the only place `opencode-go` usage exists at all. |
| **opencode app** | `~/.local/share/opencode/opencode.db` | Sessions run in the **opencode app itself**. pi never writes to this database. |
| **pi** | pi's own session JSONLs under `~/.pi/agent/sessions/` | Every provider pi has talked to, plus a "this session" line from the live branch. |

The two opencode sections are the reason the command exists in this shape: opencode usage driven
through pi and opencode usage driven through the opencode app land in completely different files,
and neither one is the whole picture.

Notes on the reads:

- The session scan walks the sessions **root**, not just the cwd-encoded directory, so turns from
  other projects are visible. It is capped at 100 files and 32 MiB, and says so when it truncates.
- The opencode database is opened read-only and never written. A WAL database opened read-only, a
  missing file, or a schema that has moved on all degrade to a skipped section.
- The Claude endpoint is undocumented and unstable, so every field is parsed defensively and may
  disappear without notice. The OAuth token is read at call time and never returned, logged,
  persisted, or embedded in any rendered string.
