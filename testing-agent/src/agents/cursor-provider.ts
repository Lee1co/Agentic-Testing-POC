import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  Agent,
  Cursor,
  CursorAgentError,
  JsonlLocalAgentStore,
  type AgentOptions,
  type Run,
  type SDKAgent,
  type SDKCustomTool,
  type SDKCustomToolResult,
} from '@cursor/sdk';
import type {
  AgentProvider,
  AgentRequest,
  AgentResult,
  AgentToolCallRecord,
  BilledCost,
  TokenUsage,
} from './agent-provider.js';
import { renderPrompt } from './prompt-renderer.js';

export interface CursorProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  /** Isolated working directory for the agent. It contains no source code or secrets. */
  workspaceDir: string;
  log?: (message: string) => void;
}

const MAX_SUMMARY_CHARS = 2_000;

interface ToolSink<T> {
  output?: T;
  calls: AgentToolCallRecord[];
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

export async function listCursorModels(apiKey: string): Promise<Array<{ id: string; displayName: string }>> {
  const models = await Cursor.models.list({ apiKey });
  return models.map((model) => ({ id: model.id, displayName: model.displayName }));
}

function textResult(text: string, isError = false): SDKCustomToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Cursor implementation of {@link AgentProvider} on top of the official `@cursor/sdk` local runtime.
 *
 * Design decisions (see ARCHITECTURE.md):
 * - Built-in tools are restricted to `["mcp"]`, so the agent has no shell/file access. It can only reach the
 *   world through the framework's audited custom tools (browser exploration, candidate test execution).
 * - The SDK has no native structured-output mode, so the final answer is submitted through a dedicated
 *   custom tool whose arguments are validated with Zod; validation errors are returned to the agent.
 * - Conversation state is persisted in a JSONL store so a later healing task can resume the session.
 */
export class CursorAgentProvider implements AgentProvider {
  readonly name = 'cursor';
  readonly model: string;
  private readonly store: JsonlLocalAgentStore;
  private readonly sandboxDir: string;

  constructor(private readonly options: CursorProviderOptions) {
    if (!options.apiKey) {
      throw new Error('CURSOR_API_KEY is required for the cursor provider');
    }
    this.model = options.model;
    this.sandboxDir = path.join(options.workspaceDir, 'sandbox');
    const storeDir = path.join(options.workspaceDir, 'sdk-store');
    mkdirSync(this.sandboxDir, { recursive: true });
    mkdirSync(storeDir, { recursive: true });
    this.store = new JsonlLocalAgentStore(storeDir);
  }

  async execute<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
    const started = Date.now();
    let attempts = 0;
    let lastError: AgentResult<T>['error'];

    while (attempts <= this.options.maxRetries) {
      attempts += 1;
      try {
        const result = await this.executeOnce(request);
        return { ...result, attempts, durationMs: Date.now() - started };
      } catch (err) {
        const retryable = err instanceof CursorAgentError ? err.isRetryable : false;
        lastError = {
          message: redact(err instanceof Error ? err.message : String(err), this.options.apiKey),
          code: err instanceof CursorAgentError ? err.code : undefined,
          retryable,
        };
        this.log(`agent startup failed (attempt ${attempts}): ${lastError.message}`);
        if (!retryable) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempts));
      }
    }

    return {
      status: 'startup-error',
      error: lastError,
      provider: this.name,
      model: this.model,
      durationMs: Date.now() - started,
      attempts,
      resumedSession: false,
      toolCalls: [],
    };
  }

  private log(message: string): void {
    this.options.log?.(`[cursor-agent] ${message}`);
  }

  private buildTools<T>(request: AgentRequest<T>, sink: ToolSink<T>): Record<string, SDKCustomTool> {
    const tools: Record<string, SDKCustomTool> = {};
    for (const tool of request.tools) {
      tools[tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema as SDKCustomTool['inputSchema'],
        execute: async (args) => {
          this.log(`tool ${tool.name} called`);
          try {
            const output = await tool.execute(args as Record<string, unknown>);
            sink.calls.push({ name: tool.name, status: 'completed' });
            return textResult(output);
          } catch (err) {
            sink.calls.push({ name: tool.name, status: 'error' });
            return textResult(`Tool error: ${err instanceof Error ? err.message : String(err)}`, true);
          }
        },
      };
    }
    tools[request.output.name] = {
      description: request.output.description,
      inputSchema: request.output.jsonSchema as SDKCustomTool['inputSchema'],
      execute: (args) => {
        const parsed = request.output.schema.safeParse(args);
        if (!parsed.success) {
          sink.calls.push({ name: request.output.name, status: 'error' });
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
          this.log(`structured output rejected: ${issues}`);
          return textResult(`Validation failed: ${issues}. Fix the payload and call ${request.output.name} again.`, true);
        }
        sink.calls.push({ name: request.output.name, status: 'completed' });
        sink.output = parsed.data;
        this.log('structured output accepted');
        return textResult('Accepted. Reply with a one-sentence summary and stop.');
      },
    };
    return tools;
  }

  private async openAgent<T>(
    request: AgentRequest<T>,
    customTools: Record<string, SDKCustomTool>,
  ): Promise<{ agent: SDKAgent; resumed: boolean }> {
    const base = {
      apiKey: this.options.apiKey,
      model: { id: this.model },
      tools: ['mcp'],
      local: { cwd: this.sandboxDir, settingSources: [], customTools, store: this.store },
    } satisfies AgentOptions;

    if (request.resumeSessionId) {
      try {
        const agent = await Agent.resume(request.resumeSessionId, base);
        this.log(`resumed session ${request.resumeSessionId}`);
        return { agent, resumed: true };
      } catch (err) {
        this.log(`could not resume ${request.resumeSessionId} (${err instanceof Error ? err.message : err}); starting fresh`);
      }
    }
    const agent = await Agent.create({ ...base, name: `${request.kind}:${request.correlationId}` });
    return { agent, resumed: false };
  }

  private async executeOnce<T>(request: AgentRequest<T>): Promise<Omit<AgentResult<T>, 'attempts' | 'durationMs'>> {
    const sink: ToolSink<T> = { calls: [] };
    const { agent, resumed } = await this.openAgent(request, this.buildTools(request, sink));

    try {
      const run: Run = await agent.send(renderPrompt(request));
      this.log(`agent=${agent.agentId} run=${run.id} kind=${request.kind}`);

      const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.log(`timeout after ${timeoutMs}ms, cancelling run`);
        void run.cancel().catch(() => undefined);
      }, timeoutMs);

      try {
        for await (const event of run.stream()) {
          if (event.type === 'tool_call' && event.status === 'running' && event.name !== 'mcp') {
            sink.calls.push({ name: `builtin:${event.name}`, status: 'running' });
          }
        }
      } catch (err) {
        this.log(`stream interrupted: ${err instanceof Error ? err.message : err}`);
      }
      const result = await run.wait();
      clearTimeout(timer);

      const usage: TokenUsage | undefined = result.usage ? { ...result.usage } : undefined;
      const { cost, costUnavailableReason } = await this.fetchBilledCost(agent);
      const common = {
        provider: this.name,
        model: result.model?.id ?? this.model,
        usage,
        cost,
        costUnavailableReason,
        sessionId: agent.agentId,
        runId: result.id,
        requestId: result.requestId,
        resumedSession: resumed,
        toolCalls: sink.calls,
        summary: result.result?.slice(0, MAX_SUMMARY_CHARS),
      };

      if (timedOut || result.status === 'cancelled') {
        return { ...common, status: 'timeout', output: sink.output, error: { message: `Run exceeded ${timeoutMs}ms` } };
      }
      if (result.status === 'error') {
        return {
          ...common,
          status: 'failed',
          error: { message: redact(result.error?.message ?? 'Agent run failed', this.options.apiKey), code: result.error?.code },
        };
      }
      if (sink.output === undefined) {
        const attempts = sink.calls.filter((call) => call.name === request.output.name).length;
        return {
          ...common,
          status: 'invalid-output',
          error: { message: `Agent finished without a valid ${request.output.name} submission (${attempts} attempts)` },
        };
      }
      return { ...common, status: 'succeeded', output: sink.output };
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }

  /** Billed cost is only reported when the SDK returns it; it is never estimated. */
  private async fetchBilledCost(agent: SDKAgent): Promise<{ cost?: BilledCost; costUnavailableReason?: string }> {
    try {
      const usage = await agent.getUsage();
      if (usage.cost) {
        return { cost: { chargedCents: usage.cost.chargedCents, rawCostCents: usage.cost.rawCostCents } };
      }
      return { costUnavailableReason: 'getUsage() returned no settled cost yet' };
    } catch (err) {
      const code = err instanceof CursorAgentError ? err.code : undefined;
      return { costUnavailableReason: `getUsage() unavailable${code ? ` (${code})` : ''}` };
    }
  }
}
