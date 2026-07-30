import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runCommand } from "./src/exec.ts";
import {
  collectGitIdentity,
  identityChecksFor,
  identityDenial,
  prAttributionDenial,
} from "./src/git-guards.ts";
import { makeLintNudgeGuard, MAX_LINT_NUDGES } from "./src/lint-check.ts";
import { runLintCheck } from "./src/lint-run.ts";
import { loadBootstrap } from "./src/memory-context.ts";
import { loadExcludedCommands, rewriteWithRtk } from "./src/rtk.ts";
import { buildSignalNudge } from "./src/signal-cues.ts";

const LINT_MESSAGE_TYPE = "self-learning/lint-followup";
/** One-shot runs have no turn left to re-open; triggerTurn there throws on a stale ctx. */
const TURN_REOPENABLE_MODES: ExtensionContext["mode"][] = ["tui", "rpc"];

export default function selfLearning(pi: ExtensionAPI) {
  let excludedCommands: string[] = [];
  let lintRunning = false;
  let sessionActive = false;
  const lintGuard = makeLintNudgeGuard(MAX_LINT_NUDGES);

  pi.on("session_start", async () => {
    sessionActive = true;
    excludedCommands = await loadExcludedCommands();
    lintGuard.reset();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const bootstrap = await loadBootstrap(ctx.cwd);
    if (!bootstrap) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${bootstrap}` };
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return { action: "continue" };
    const nudge = buildSignalNudge(event.text);
    if (!nudge) return { action: "continue" };
    return {
      action: "transform",
      text: `${event.text}\n\n${nudge}`,
      images: event.images,
    };
  });

  // Guards run before the rtk rewrite so deny decisions see the original command.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;

    const attribution = prAttributionDenial(command);
    if (attribution) return { block: true, reason: attribution };

    const checks = identityChecksFor(command);
    if (checks) {
      const identity = await collectGitIdentity(runCommand, ctx.cwd, checks);
      const denial = identity && identityDenial(checks, identity);
      if (denial) return { block: true, reason: denial };
    }

    const rewritten = await rewriteWithRtk(
      runCommand,
      command,
      ctx.cwd,
      excludedCommands,
    );
    if (rewritten) event.input.command = rewritten;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (lintRunning || !lintGuard.canNudge()) return;
    if (!TURN_REOPENABLE_MODES.includes(ctx.mode)) return;
    lintRunning = true;
    try {
      const report = await runLintCheck(runCommand, ctx.cwd);
      if (!report) {
        lintGuard.reset();
        return;
      }
      if (!sessionActive) return;
      lintGuard.recordNudge();
      pi.sendMessage(
        { customType: LINT_MESSAGE_TYPE, content: report, display: true },
        { triggerTurn: true },
      );
    } finally {
      lintRunning = false;
    }
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    lintRunning = false;
    lintGuard.reset();
  });
}
