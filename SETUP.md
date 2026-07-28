# Setup

Clone or copy this repository to `~/.pi/agent`, then install its dependencies:

```sh
cd ~/.pi/agent
npm install
```

## fd and rg tools

The `file-search` extension registers `fd` and `rg` as model tools. No setup is normally needed: at startup it silently uses a system-installed `fd` (or `fdfind` on Debian/Ubuntu) and `rg` when available, or an existing fallback binary in `~/.pi/agent/bin/`. Only when neither exists does it download an official release binary (macOS/Linux, arm64/x64, over HTTPS) into `~/.pi/agent/bin/` and show a one-time notification. If your platform is unsupported, install `fd` and `rg` with your package manager and restart pi.

## MCP servers

MCP support is not built into pi; it comes from the `pi-mcp-adapter` package:

```sh
pi install npm:pi-mcp-adapter
```

`pi install` records the package in `~/.pi/agent/settings.json` and installs it under
`~/.pi/agent/npm/`. Both paths are gitignored, so a fresh clone has to run the install again.

Servers are configured in `~/.pi/agent/mcp.json`, which is gitignored too because entries can
carry tokens. The adapter merges several config files (`~/.config/mcp/mcp.json`, `.mcp.json`,
`.pi/mcp.json`, …); `<agent dir>/mcp.json` is the global override and is the one this setup uses.
The shape is the adapter's own `ServerEntry`, not Claude Code's — there is no `type` field, and the
transport is inferred from which of `command`, `url`, or `socket` is present:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--executable-path", "/usr/bin/chromium", "--headless", "--isolated"]
    }
  }
}
```

Other fields worth knowing (all optional): `args`, `env`, `cwd` for stdio servers; `headers`,
`auth`, `bearerToken`/`bearerTokenEnv`, `oauth` for `url` servers; `disabled`, `includeTools`,
`excludeTools`, `lifecycle` anywhere. See
`~/.pi/agent/npm/node_modules/pi-mcp-adapter/types.ts` for the full list.

### Playwright MCP on Linux

A bare `npx @playwright/mcp@latest` does not work on this machine, and neither does adding
`--browser chromium`:

- with no browser flag it defaults to the Chrome channel and looks for `/opt/google/chrome/chrome`,
  which is not installed;
- `--browser chromium` wants the Chromium build that its bundled `playwright-core` pins
  (revision 1232 for `@playwright/mcp@0.0.78`) under `~/.cache/ms-playwright/`, and that build is
  not downloaded either.

The config above works around it by pointing at the system Chromium (`--executable-path
/usr/bin/chromium`, plus `--headless --isolated`). That makes the MCP server depend on a distro
package. The durable fix is to let Playwright manage its own browser:

```sh
npx playwright install chromium
```

and then drop the `--executable-path` flag.

## Self-learning extension

The `self-learning` extension reads configuration that lives outside this repo:

- `~/.config/ai/persona.md`, `~/.config/ai/memory/MEMORY.md`, and
  `~/.config/ai/projects/<cwd-slug>/memory/MEMORY.md` — appended to the system prompt at the start
  of every turn;
- `~/.config/rtk/config.toml` — read once per session for `[hooks].exclude_commands`, the list of
  commands `rtk` must not rewrite.

None of these are required. Every file read is optional: a missing file reads as empty, and when
all three memory sources are empty nothing is appended to the system prompt. Command rewriting
shells out to `rtk hook claude` and treats any non-zero exit — including `rtk` not being installed
— as "leave the command alone". A fresh clone on a machine without `~/.config/ai/` therefore keeps
only the git-identity and PR-attribution guards and the post-turn lint pass, which need neither.

See `extensions/self-learning/docs/hooks.md` for what each hook does and where it stops short of
the Claude Code behavior it ports.

## Theme

Add the included theme to `~/.pi/agent/settings.json` while keeping your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

Pi will load the extensions, skills, and theme from their directories the next time it starts.
