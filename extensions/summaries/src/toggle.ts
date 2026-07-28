import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SummaryConfig } from "./config.ts";

export const TOGGLE_ARGUMENTS = ["on", "off", "status"] as const;

export type ToggleAction = (typeof TOGGLE_ARGUMENTS)[number] | "toggle";

const isToggleArgument = (
  value: string,
): value is (typeof TOGGLE_ARGUMENTS)[number] =>
  TOGGLE_ARGUMENTS.includes(value as (typeof TOGGLE_ARGUMENTS)[number]);

export function parseToggleArguments(rawArgs: string) {
  const argument = rawArgs.trim().toLowerCase();
  if (!argument) return { ok: true, action: "toggle" } as const;
  if (isToggleArgument(argument))
    return { ok: true, action: argument } as const;
  return {
    ok: false,
    error: `Unknown argument "${rawArgs.trim()}". Use one of: ${TOGGLE_ARGUMENTS.join(", ")}, or no argument to toggle.`,
  } as const;
}

export function resolveEnabled(action: ToggleAction, current: boolean) {
  switch (action) {
    case "on":
      return true;
    case "off":
      return false;
    case "status":
      return current;
    case "toggle":
      return !current;
  }
}

export function formatSummaryState(config: SummaryConfig) {
  return `Summaries: ${config.enabled ? "on" : "off"} · ${config.provider}/${config.model} · ${config.reasoning}`;
}

export function report(
  ctx: ExtensionCommandContext,
  message: string,
  isError = false,
) {
  if (ctx.hasUI) {
    ctx.ui.notify(message, isError ? "error" : "info");
    return;
  }
  if (isError) console.error(message);
  else console.log(message);
}
