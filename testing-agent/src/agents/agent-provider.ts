import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Provider-neutral contract between the orchestrator and any AI backend.
 * Nothing in this file may reference a vendor SDK.
 */

export type AgentTaskKind = 'generate-test' | 'repair-test';

export type JsonSchema = Record<string, unknown>;

/** A capability the framework exposes to the agent. Providers map it to their own tool-calling mechanism. */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Must never throw for expected failures; return a descriptive string instead. */
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface PromptSection {
  title: string;
  content: string;
  /**
   * Untrusted sections (web page content, business documents, previous agent output) are fenced
   * and explicitly declared as data, never as instructions.
   */
  trusted: boolean;
  source?: string;
}

export interface StructuredOutputSpec<T> {
  /** Name the agent uses to submit its final answer. */
  name: string;
  description: string;
  jsonSchema: JsonSchema;
  schema: ZodType<T, ZodTypeDef, unknown>;
}

export interface AgentRequest<T> {
  kind: AgentTaskKind;
  /** Stable correlation id (e.g. the test id). */
  correlationId: string;
  instructions: string;
  sections: PromptSection[];
  tools: AgentTool[];
  output: StructuredOutputSpec<T>;
  timeoutMs?: number;
  /** Provider session to continue, when the provider supports conversation persistence. */
  resumeSessionId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface BilledCost {
  /** Value as reported by the provider's billing API. Never estimated. */
  chargedCents: number;
  rawCostCents?: number;
}

export type AgentResultStatus = 'succeeded' | 'failed' | 'timeout' | 'invalid-output' | 'startup-error';

export interface AgentToolCallRecord {
  name: string;
  status: 'completed' | 'error' | 'running';
}

export interface AgentResult<T> {
  status: AgentResultStatus;
  output?: T;
  /** Final free-text answer from the agent, truncated. */
  summary?: string;
  error?: { message: string; code?: string; retryable?: boolean };
  provider: string;
  model: string;
  durationMs: number;
  attempts: number;
  usage?: TokenUsage;
  cost?: BilledCost;
  costUnavailableReason?: string;
  sessionId?: string;
  runId?: string;
  requestId?: string;
  resumedSession: boolean;
  toolCalls: AgentToolCallRecord[];
}

export interface AgentProvider {
  readonly name: string;
  readonly model: string;
  execute<T>(request: AgentRequest<T>): Promise<AgentResult<T>>;
}

export class AgentInvocationBudgetExceeded extends Error {
  constructor(limit: number) {
    super(`AI invocation budget exhausted (${limit} per command). Raise MAX_AGENT_INVOCATIONS to allow more.`);
    this.name = 'AgentInvocationBudgetExceeded';
  }
}

/**
 * Decorator that enforces a per-command invocation budget and records every call.
 * The orchestrator only ever talks to this wrapper.
 */
export class MeteredAgentProvider implements AgentProvider {
  readonly invocations: Array<{ kind: AgentTaskKind; correlationId: string; result: AgentResult<unknown> }> = [];

  constructor(
    private readonly inner: AgentProvider,
    private readonly maxInvocations: number,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  get count(): number {
    return this.invocations.length;
  }

  async execute<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
    if (this.invocations.length >= this.maxInvocations) {
      throw new AgentInvocationBudgetExceeded(this.maxInvocations);
    }
    const result = await this.inner.execute(request);
    this.invocations.push({ kind: request.kind, correlationId: request.correlationId, result });
    return result;
  }
}
