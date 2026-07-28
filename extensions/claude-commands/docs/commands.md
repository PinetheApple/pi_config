# claude-commands

Claude Code slash commands that pi does not already ship. Nothing here duplicates a pi built-in.

| Command | Behavior |
| --- | --- |
| `/help` | Lists the extension, prompt, and skill commands `pi.getCommands()` can see. |
| `/context` | Context-window breakdown for the session. |
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

`/help`, `/context`, and `/status` deliver a `claude-commands-report` custom entry: persisted in
the session JSONL, rendered by a registered entry renderer, and never sent to the model. Outside
the TUI they degrade to a plain-text `ctx.ui.notify`.

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
