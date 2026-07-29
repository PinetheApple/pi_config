/**
 * Cross-extension handle to the live SubagentManager.
 *
 * pi loads every extension through its own jiti instance with the module cache
 * off, so a module-level singleton is per-extension and cannot be shared. The
 * process-wide `globalThis` slot is the only storage all extensions agree on.
 *
 * The handle deliberately exposes plain async values only: the Effect runtime
 * that owns the manager stays inside `extensions/subagents`.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentTransport } from "./workflow-transport.ts";

/**
 * Parent-session facts a spawned child inherits. An `ExtensionContext`
 * satisfies this structurally; the optionals let tests stand one up.
 */
export interface WorkflowParentContext {
  readonly cwd: string;
  readonly model?: { readonly provider: string; readonly id: string };
  readonly modelRegistry?: ModelRegistry;
  isProjectTrusted(): boolean;
}

export interface WorkflowTransportRequest {
  readonly parent: WorkflowParentContext;
  readonly thinkingLevel?: string;
}

export interface SubagentHost {
  /**
   * An `AgentTransport` that routes workflow agents through this session's
   * SubagentManager, so they share its concurrency cap and its registry.
   */
  workflowTransport(request: WorkflowTransportRequest): Promise<AgentTransport>;
}

interface SubagentHostSlot {
  __piSubagentHost?: SubagentHost;
}

const slot = globalThis as typeof globalThis & SubagentHostSlot;

/**
 * First publisher wins: headless children bind the same extensions in print
 * mode, and a child must never take the parent's slot out from under it.
 */
export function publishSubagentHost(host: SubagentHost) {
  slot.__piSubagentHost ??= host;
}

/** Idempotent, and only ever clears the caller's own handle. */
export function clearSubagentHost(host: SubagentHost) {
  if (slot.__piSubagentHost === host) delete slot.__piSubagentHost;
}

export function getSubagentHost() {
  return slot.__piSubagentHost;
}
