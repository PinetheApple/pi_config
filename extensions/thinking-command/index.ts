import {
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = ModelThinkingLevel;

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

const label = (level: ThinkingLevel, current: ThinkingLevel) =>
  `${level === current ? "*" : " "} ${level} — ${LEVEL_DESCRIPTIONS[level]}`;

const levelFromLabel = (choice: string, levels: ReadonlyArray<ThinkingLevel>) =>
  levels.find((level) => choice.trim().startsWith(`${level} `));

export default function (pi: ExtensionAPI) {
  pi.registerCommand("thinking", {
    description:
      "Set the thinking level for the current model (/thinking [level])",
    handler: async (args, ctx) => {
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "warning");
        return;
      }

      const levels = getSupportedThinkingLevels(ctx.model) as ThinkingLevel[];
      const current = pi.getThinkingLevel();
      const modelName = `${ctx.model.provider}/${ctx.model.id}`;

      if (levels.length <= 1) {
        ctx.ui.notify(
          `${modelName} only supports thinking level "${levels[0] ?? "off"}"`,
          "info",
        );
        return;
      }

      const requested = args.trim().toLowerCase();
      if (requested) {
        if (!levels.includes(requested as ThinkingLevel)) {
          ctx.ui.notify(
            `${modelName} supports: ${levels.join(", ")}`,
            "warning",
          );
          return;
        }
        pi.setThinkingLevel(requested as ThinkingLevel);
        ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(
          `Thinking level: ${current} (${modelName} supports: ${levels.join(", ")})`,
          "info",
        );
        return;
      }

      const choice = await ctx.ui.select(
        `Thinking level — ${modelName}`,
        levels.map((level) => label(level, current)),
      );
      if (!choice) return;

      const selected = levelFromLabel(choice, levels);
      if (!selected) return;

      pi.setThinkingLevel(selected);
      ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
    },
  });
}
