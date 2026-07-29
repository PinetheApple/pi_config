/**
 * The package's `workflow` tool documents its *options* but never its *source
 * language*, so a first-time caller guesses the DSL and loses a turn to
 * `Unexpected token 'export'` or the `parallel` arity check. Two lines of
 * always-on guideline cover the two shapes that are actually guessed wrong;
 * the long form stays in the `pi-extensible-workflows` skill.
 *
 * We cannot re-register `workflow` to add this — a second `registerTool` with
 * the same name replaces the package's entry outright (tools are a Map keyed
 * by name), taking its executor and renderers with it. Instead the host hands
 * the package a proxied `ExtensionAPI` whose `registerTool` decorates the
 * definition on its way through.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_TOOL_NAME = "workflow";

/** The skill that holds the full DSL reference; named so the model can load it. */
export const WORKFLOW_SKILL_NAME = "pi-extensible-workflows";

export const WORKFLOW_PROMPT_GUIDELINES = [
  `Read the ${WORKFLOW_SKILL_NAME} skill before writing the first ${WORKFLOW_TOOL_NAME} script of a task; it is the full DSL reference.`,
  `The ${WORKFLOW_TOOL_NAME} script is an async function body, not a module: no import, no export or export default, no enclosing function, and no require — just statements and a final return.`,
  `In a ${WORKFLOW_TOOL_NAME} script the operation name comes first: parallel("research", { blue: () => agent("...") }) and pipeline("review", items, stages); await either before interpolating with prompt("...{x}", { x }).`,
];

/**
 * Shown only on a rejected launch, where the extra tokens buy a self-corrected
 * retry instead of a second guess.
 */
export const WORKFLOW_SOURCE_CHEATSHEET = [
  `Correct ${WORKFLOW_TOOL_NAME} script shape:`,
  "- The script is an async function body. No import/export/export default, no wrapper function, no require.",
  "- parallel(operationName, tasksRecord) and pipeline(operationName, itemsRecord, stagesRecord) take the name string first; each task is a zero-argument function.",
  '- Await parallel/pipeline results, then interpolate them with prompt("...{x}", { x }).',
  "- Minimal working script:",
  '    const found = await parallel("research", { blue: () => agent("Reply with the word blue.") });',
  '    return await agent(prompt("Report the colour:\\n\\n{found}", { found }));',
  `- Full reference: the ${WORKFLOW_SKILL_NAME} skill.`,
].join("\n");

const SOURCE_ERROR_CODES = new Set(["INVALID_SYNTAX", "INVALID_METADATA"]);

/**
 * The package throws a `WorkflowError` carrying a `code`; the prose fallback
 * covers versions that reword or wrap it before it reaches us.
 */
export function isWorkflowSourceError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && SOURCE_ERROR_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /^The workflow (?:source|metadata) is invalid:/.test(message)
  );
}

/**
 * Mutating the message keeps the error's class, `code`, and any fields the
 * package's own failure renderer reads; a replacement error would drop them.
 */
export function explainWorkflowSourceError(error: unknown) {
  if (!isWorkflowSourceError(error)) return error;
  const failure = error as { message: string };
  if (failure.message.includes(WORKFLOW_SOURCE_CHEATSHEET)) return error;
  failure.message = `${failure.message}\n\n${WORKFLOW_SOURCE_CHEATSHEET}`;
  return error;
}

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

function decorate(tool: ToolDefinition) {
  if (tool.name !== WORKFLOW_TOOL_NAME) return tool;
  return {
    ...tool,
    promptGuidelines: [
      ...(tool.promptGuidelines ?? []),
      ...WORKFLOW_PROMPT_GUIDELINES,
    ],
    async execute(...args: Parameters<ToolDefinition["execute"]>) {
      try {
        return await tool.execute(...args);
      } catch (error) {
        throw explainWorkflowSourceError(error);
      }
    },
  };
}

/**
 * Every other member is forwarded bound to the real API, so the package sees an
 * ordinary `ExtensionAPI` and stays free to register whatever else it likes.
 */
export function withWorkflowGuidance(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: ToolDefinition) => target.registerTool(decorate(tool));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
