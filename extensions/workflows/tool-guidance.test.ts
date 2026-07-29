/**
 * The `workflow` tool arrives from the package, so the guidance is verified
 * through the same seam the package uses: a fake `ExtensionAPI` whose
 * `registerTool` is called exactly as `host()` calls it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_SKILL_NAME,
  WORKFLOW_SOURCE_CHEATSHEET,
  explainWorkflowSourceError,
  isWorkflowSourceError,
  withWorkflowGuidance,
} from "./src/tool-guidance.ts";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

function fakeApi() {
  const tools: ToolDefinition[] = [];
  const calls: string[] = [];
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    getThinkingLevel() {
      calls.push("getThinkingLevel");
      return "high";
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, calls };
}

function toolNamed(
  name: string,
  execute: ToolDefinition["execute"],
  promptGuidelines?: string[],
) {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as ToolDefinition["parameters"],
    ...(promptGuidelines ? { promptGuidelines } : {}),
    execute,
  } as ToolDefinition;
}

const noop: ToolDefinition["execute"] = async () => ({
  content: [{ type: "text" as const, text: "ok" }],
  details: undefined,
});

function register(pi: ExtensionAPI, tool: ToolDefinition) {
  withWorkflowGuidance(pi).registerTool(tool);
}

test("the workflow registration gains DSL guidelines without losing the package's own", () => {
  const { pi, tools } = fakeApi();
  register(pi, toolNamed("workflow", noop, ["package bullet"]));

  const [registered] = tools;
  assert.equal(registered?.name, "workflow");
  assert.deepEqual(registered?.promptGuidelines, [
    "package bullet",
    ...WORKFLOW_PROMPT_GUIDELINES,
  ]);
  // The two shapes the model actually guesses wrong, plus where to read more.
  const guidance = WORKFLOW_PROMPT_GUIDELINES.join("\n");
  assert.match(guidance, /export default/);
  assert.match(guidance, /parallel\("research"/);
  assert.ok(guidance.includes(WORKFLOW_SKILL_NAME));
});

test("the package's other tools pass through untouched", () => {
  const { pi, tools } = fakeApi();
  const original = toolNamed("workflow_retry", noop);
  register(pi, original);

  assert.equal(tools[0], original);
  assert.equal(tools[0]?.promptGuidelines, undefined);
});

test("everything except registerTool reaches the real API", () => {
  const { pi, calls } = fakeApi();
  assert.equal(withWorkflowGuidance(pi).getThinkingLevel(), "high");
  assert.deepEqual(calls, ["getThinkingLevel"]);
});

test("a rejected source carries the cheatsheet back to the model", async () => {
  const { pi, tools } = fakeApi();
  const failure = Object.assign(
    new Error(
      "The workflow source is invalid: Invalid workflow syntax: Unexpected token 'export'.",
    ),
    { code: "INVALID_SYNTAX" },
  );
  register(
    pi,
    toolNamed("workflow", async () => {
      throw failure;
    }),
  );

  const thrown = await tools[0]!
    .execute("call-1", {}, undefined, undefined, {} as never)
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  // Same error object: its class, code, and diagnostics fields survive.
  assert.equal(thrown, failure);
  assert.equal((thrown as { code: string }).code, "INVALID_SYNTAX");
  assert.match(failure.message, /Unexpected token 'export'/);
  assert.ok(failure.message.includes(WORKFLOW_SOURCE_CHEATSHEET));
  assert.match(failure.message, /parallel\(operationName, tasksRecord\)/);
});

test("a metadata rejection is explained too, and unrelated failures are not", () => {
  const metadata = Object.assign(
    new Error(
      "The workflow metadata is invalid: parallel requires an operation name string and tasks record.",
    ),
    { code: "INVALID_METADATA" },
  );
  assert.ok(isWorkflowSourceError(metadata));
  explainWorkflowSourceError(metadata);
  assert.ok(metadata.message.includes(WORKFLOW_SOURCE_CHEATSHEET));

  const unrelated = Object.assign(new Error("Budget exhausted."), {
    code: "BUDGET_EXHAUSTED",
  });
  assert.equal(isWorkflowSourceError(unrelated), false);
  explainWorkflowSourceError(unrelated);
  assert.equal(unrelated.message, "Budget exhausted.");
});

test("a reworded source error is still recognised by its prose", () => {
  const rephrased = new Error("The workflow source is invalid: something new.");
  assert.ok(isWorkflowSourceError(rephrased));
  assert.equal(isWorkflowSourceError(new Error("unrelated")), false);
  assert.equal(isWorkflowSourceError(undefined), false);
});

test("the cheatsheet is appended at most once", () => {
  const failure = new Error("The workflow source is invalid: bad.");
  explainWorkflowSourceError(failure);
  const once = failure.message;
  explainWorkflowSourceError(failure);
  assert.equal(failure.message, once);
});
