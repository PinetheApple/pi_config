import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadSummaryConfig, saveSummaryConfig } from "./src/config.ts";
import { summarizeRun } from "./src/summarizer.ts";
import {
  buildFallbackRecap,
  createRunBoundary,
  getRunEntries,
  serializeRunTranscript,
} from "./src/transcript.ts";
import {
  formatSummaryState,
  parseToggleArguments,
  report,
  resolveEnabled,
} from "./src/toggle.ts";
import {
  openModelPicker,
  openReasoningPicker,
  renderRecap,
  type RecapEntryData,
} from "./src/ui.ts";

const RECAP_ENTRY_TYPE = "summary-recap";
const STATUS_KEY = "summaries";
const SHUTDOWN_WAIT_MS = 1_000;

async function waitForCancellation(
  tasks: readonly Promise<void>[],
  timeoutMs: number,
) {
  if (tasks.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export default function (pi: ExtensionAPI) {
  const runBoundary = createRunBoundary();
  const activeSummaries = new Map<AbortController, Promise<void>>();
  let sessionActive = false;
  let statusContext: ExtensionContext | undefined;

  const updateStatus = () => {
    statusContext?.ui.setStatus(
      STATUS_KEY,
      activeSummaries.size > 0
        ? statusContext.ui.theme.fg("muted", "✦ summarizing run…")
        : undefined,
    );
  };

  const cancelActiveSummaries = async () => {
    const summaries = [...activeSummaries.entries()];
    for (const [controller] of summaries) controller.abort();
    await waitForCancellation(
      summaries.map(([, task]) => task),
      SHUTDOWN_WAIT_MS,
    );
    activeSummaries.clear();
  };

  pi.registerEntryRenderer<RecapEntryData>(
    RECAP_ENTRY_TYPE,
    (entry, { expanded }, theme) => renderRecap(entry.data, expanded, theme),
  );

  pi.on("session_start", (_event, ctx) => {
    sessionActive = ctx.mode === "tui";
    statusContext = ctx;
    runBoundary.reset();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    runBoundary.begin(ctx.sessionManager.getLeafId());
  });

  pi.on("agent_settled", (_event, ctx) => {
    const run = runBoundary.settle();
    if (!run || ctx.mode !== "tui" || !sessionActive) return;

    const config = loadSummaryConfig();
    if (!config.enabled) return;

    const entries = getRunEntries(
      ctx.sessionManager.getBranch(),
      run.baselineLeafId,
    );
    if (entries.length === 0) return;

    const source = {
      provider: config.provider,
      model: config.model,
      reasoning: config.reasoning,
    };
    const controller = new AbortController();
    statusContext = ctx;
    const task = (async () => {
      let recap: RecapEntryData;
      try {
        const generated = await summarizeRun({
          modelRegistry: ctx.modelRegistry,
          config,
          transcript: serializeRunTranscript(entries),
          signal: controller.signal,
        });
        recap = { ...generated, ...source };
      } catch (error) {
        if (controller.signal.aborted || !sessionActive) return;
        recap = {
          ...buildFallbackRecap(entries),
          ...source,
          fallback: true,
        };
        const detail = error instanceof Error ? ` ${error.message}` : "";
        ctx.ui.notify(
          `The summary model failed; showing a concise local fallback.${detail}`,
          "warning",
        );
      }

      if (!sessionActive || controller.signal.aborted) return;
      pi.appendEntry(RECAP_ENTRY_TYPE, recap);
    })().finally(() => {
      activeSummaries.delete(controller);
      updateStatus();
    });

    activeSummaries.set(controller, task);
    updateStatus();
    // Keep the next prompt responsive while the inexpensive recap model runs.
    // The recap is a custom entry, so it cannot affect a later agent turn.
    void task;
  });

  pi.on("session_shutdown", async () => {
    sessionActive = false;
    runBoundary.reset();
    await cancelActiveSummaries();
    statusContext?.ui.setStatus(STATUS_KEY, undefined);
    statusContext = undefined;
  });

  pi.registerCommand("summary-model", {
    description: "Choose the model and reasoning level used for run recaps",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Summary model selection is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const current = loadSummaryConfig();
      const model = await openModelPicker(ctx, current);
      if (!model) return;

      const reasoning = await openReasoningPicker(
        ctx,
        model,
        current.reasoning,
      );
      if (!reasoning) return;

      const config = {
        ...current,
        provider: model.provider,
        model: model.id,
        reasoning,
      };
      try {
        await saveSummaryConfig(config);
      } catch {
        ctx.ui.notify(
          "Could not save the private summary model config.",
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Summary model: ${config.provider}/${config.model} · ${config.reasoning}`,
        "info",
      );
    },
  });

  pi.registerCommand("summaries", {
    description: "Turn run recaps on or off (on | off | status | toggle)",
    handler: async (args, ctx) => {
      const parsed = parseToggleArguments(args);
      if (!parsed.ok) {
        report(ctx, parsed.error, true);
        return;
      }

      // Config lives on disk, so a failed write leaves nothing stale in memory.
      const current = loadSummaryConfig();
      const enabled = resolveEnabled(parsed.action, current.enabled);
      if (enabled === current.enabled) {
        report(ctx, formatSummaryState(current));
        return;
      }

      const next = { ...current, enabled };
      try {
        await saveSummaryConfig(next);
      } catch {
        report(
          ctx,
          `Could not save the private summary config; summaries stay ${current.enabled ? "on" : "off"}.`,
          true,
        );
        return;
      }

      if (!enabled) {
        await cancelActiveSummaries();
        updateStatus();
      }
      report(ctx, formatSummaryState(next));
    },
  });
}
