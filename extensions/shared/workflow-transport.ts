/**
 * Structural contract for the `AgentTransport` surface of
 * `pi-extensible-workflows` (3.4.2, `dist/src/types.d.ts`).
 *
 * It is declared here instead of imported so both extensions typecheck whether
 * or not the optional package is installed, and so the exact fields this repo
 * depends on are visible in one place when the package is upgraded. Only the
 * members actually used are modelled; the package's own types stay wider.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ReasoningEffort } from "../subagents/src/domain.ts";

/** Transport id shared by the facade in `extensions/workflows` and the impl. */
export const WORKFLOW_TRANSPORT_ID = "pi-subagents";

export interface WorkflowModelSpec {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: ReasoningEffort;
}

/** Immutable session request handed to `AgentTransport.createSession`. */
export interface PreparedAgentSession {
  readonly cwd: string;
  readonly model: WorkflowModelSpec;
  /** Allowlist the transport must not widen; the executor re-checks it. */
  readonly tools: readonly string[];
  readonly sessionLabel: string;
  readonly customTools?: readonly ToolDefinition[];
  /** Present only when the workflow declared an `outputSchema`. */
  readonly resultTool?: ToolDefinition;
  readonly systemPrompt?: string;
  readonly systemPromptAppend?: string;
}

export interface WorkflowRunContext {
  readonly cwd: string;
  readonly runId: string;
}

export interface AgentIdentity {
  readonly structuralPath: readonly string[];
  readonly callSite: string;
  readonly parentBreadcrumb?: string;
}

export interface AgentTransportContext {
  readonly run: WorkflowRunContext;
  readonly identity: AgentIdentity;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface WorkflowAgentSessionReference {
  readonly transport: string;
  readonly sessionId: string;
  readonly locator?: unknown;
}

export interface WorkflowAgentSessionStats {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
}

export interface WorkflowAgentMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

export interface WorkflowAgentSessionState {
  readonly model: WorkflowModelSpec;
  readonly thinking?: ReasoningEffort;
  readonly tools: readonly string[];
  readonly systemPrompt?: string;
}

export interface WorkflowAgentSessionEvent {
  readonly type: string;
  readonly state?: WorkflowAgentSessionState;
  readonly message?: WorkflowAgentMessage;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export interface WorkflowAgentTurnResult {
  readonly assistant?: WorkflowAgentMessage;
}

export interface WorkflowAgentSession {
  readonly reference: WorkflowAgentSessionReference;
  getState(): WorkflowAgentSessionState;
  getSessionStats(): WorkflowAgentSessionStats;
  subscribe(listener: (event: WorkflowAgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<WorkflowAgentTurnResult>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentTransport {
  readonly id: string;
  createSession(
    prepared: PreparedAgentSession,
    context: AgentTransportContext,
  ): Promise<WorkflowAgentSession>;
}

/** Options a workflow script passed to `agent(...)`; `role` selects a persona. */
export interface WorkflowAgentOptions {
  readonly role?: string;
  readonly [key: string]: unknown;
}

/** Mutable setup a registered `agentSetupHook` may narrow before the spawn. */
export interface AgentSetup {
  readonly options: WorkflowAgentOptions;
  sessionInput: {
    tools: string[];
    systemPrompt?: string;
    systemPromptAppend?: string;
  };
}
