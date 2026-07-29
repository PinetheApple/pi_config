/**
 * A Claude-Code-shaped permission layer for pi.
 *
 * `tool_call` is the enforcement point: it can block, and it is the only hook
 * that sees every tool before it runs. Rules and the current mode decide;
 * `ctx.ui.confirm()` handles the ask; a session with no UI fails closed.
 *
 * Rules are read from config, never compiled in — see `src/config.ts` for the
 * layers and why they are those layers.
 */

import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  cyclePermissionMode,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODES,
  isPermissionMode,
  type PermissionMode,
} from "../shared/permission-modes.ts";
import { childPermissionMode } from "../shared/child-permission-mode.ts";
import { loadPermissionConfig, type PermissionConfig } from "./src/config.ts";
import { decide, resolveUnattended } from "./src/decide.ts";
import { formatPermissionStatus, type StatusTheme } from "./src/status.ts";
import {
  modeEntry,
  PERMISSION_MODE_ENTRY,
  restoreMode,
} from "./src/mode-store.ts";

const STATUS_KEY = "permissions";
/** Free in the stock keymap, so mode cycling still has a key if shift+tab is lost. */
const FALLBACK_SHORTCUT = "alt+p";

export default function (pi: ExtensionAPI) {
  // Session state only. Nothing here starts a resource, so the factory stays
  // safe to run in invocations that never open a session.
  let config: PermissionConfig | undefined;
  let mode: PermissionMode | undefined;
  /** A spawned child: its mode is fixed by the spawner, not by the user. */
  let isChild = false;

  const showStatus = (ctx: {
    ui: { setStatus: (k: string, t?: string) => void; theme: StatusTheme };
  }) => {
    ctx.ui.setStatus(
      STATUS_KEY,
      mode ? formatPermissionStatus(ctx.ui.theme, mode) : undefined,
    );
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadPermissionConfig({ agentDir: getAgentDir() });
    // A spawned child is pinned to the mode its spawner registered and never
    // consults config: it has no UI, so a configured `default` would fail every
    // ask closed. Otherwise a resumed or forked session keeps the mode it was
    // left in, and a fresh one starts at the configured default.
    const child = childPermissionMode(ctx.sessionManager.getSessionFile());
    isChild = child !== undefined;
    mode = child ?? restoreMode(ctx.sessionManager.getEntries()) ?? config.mode;
    showStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    config = undefined;
    mode = undefined;
    isChild = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("tool_call", async (event, ctx) => {
    // Before session_start, or after shutdown, there is no policy to apply.
    // Blocking here would break invocations the gate was never meant to cover.
    if (!config || !mode) return;

    const decision = decide({
      call: { toolName: event.toolName, input: event.input, cwd: ctx.cwd },
      rules: config.rules,
      mode,
    });

    if (decision.effect === "allow") return;
    if (decision.effect === "deny") {
      return { block: true, reason: decision.reason };
    }

    if (!ctx.hasUI) {
      return { block: true, reason: resolveUnattended(decision).reason };
    }

    const approved = await ctx.ui.confirm(
      `Allow ${event.toolName}?`,
      `${decision.reason}\n\n${describeCall(event.toolName, event.input)}`,
    );
    return approved
      ? undefined
      : {
          block: true,
          reason: `The user declined this ${event.toolName} call.`,
        };
  });

  // A child's mode is its spawner's decision. Nothing reachable from a headless
  // child should be able to widen it, so the setter refuses rather than relying
  // on the UI being absent.
  const setMode = (
    next: PermissionMode,
    ctx: Parameters<typeof showStatus>[0],
  ) => {
    if (isChild) return;
    mode = next;
    pi.appendEntry(PERMISSION_MODE_ENTRY, modeEntry(next));
    showStatus(ctx);
  };

  // No notify here: the footer status is persistent and already says the mode,
  // so announcing it as well printed the same words twice per keystroke.
  const cycle = (ctx: Parameters<typeof showStatus>[0]) => {
    if (!mode) return;
    setMode(cyclePermissionMode(mode), ctx);
  };

  // shift+tab is pi's `app.thinking.cycle` by default, and the extension runner
  // reserves that binding — a registration here is skipped with a diagnostic
  // unless `keybindings.json` has moved thinking cycling elsewhere. Both keys
  // are registered so the feature works either way.
  for (const key of ["shift+tab", FALLBACK_SHORTCUT] as const) {
    pi.registerShortcut(key, {
      description: "Cycle permission mode",
      handler: (ctx) => cycle(ctx),
    });
  }

  pi.registerCommand("permissions", {
    description: "Show or set the permission mode",
    handler: async (args, ctx) => {
      if (!config || !mode) return;
      const requested = args.trim();
      if (requested && isPermissionMode(requested)) {
        setMode(requested, ctx);
        ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_LABELS[mode]}`);
        return;
      }
      ctx.ui.notify(summarize(config, mode));
    },
  });
}

function summarize(config: PermissionConfig, mode: PermissionMode) {
  const { allow, ask, deny } = config.rules;
  return [
    `Mode: ${PERMISSION_MODE_LABELS[mode]}`,
    `Rules: ${allow.length} allow, ${ask.length} ask, ${deny.length} deny`,
    `Sources: ${config.sources.join(", ") || "none"}`,
    `Modes: ${PERMISSION_MODES.join(", ")}`,
  ].join("\n");
}

const CALL_PREVIEW_LIMIT = 200;

function describeCall(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
) {
  const primary = input.command ?? input.path;
  const text = typeof primary === "string" ? primary : JSON.stringify(input);
  return text.length > CALL_PREVIEW_LIMIT
    ? `${toolName}: ${text.slice(0, CALL_PREVIEW_LIMIT)}…`
    : `${toolName}: ${text}`;
}
