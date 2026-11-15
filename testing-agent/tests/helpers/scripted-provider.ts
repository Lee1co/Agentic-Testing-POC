import type { AgentProvider, AgentRequest, AgentResult } from '../../src/agents/agent-provider.js';

/**
 * Deterministic test double for unit/integration tests ONLY. The real end-to-end scenarios use the
 * Cursor provider; this double lets us test orchestration logic without network or AI cost.
 */
export type Script = (request: AgentRequest<unknown>) => unknown;

export class ScriptedProvider implements AgentProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-model';
  readonly requests: AgentRequest<unknown>[] = [];

  constructor(private readonly scripts: Script[]) {}

  async execute<T>(request: AgentRequest<T>): Promise<AgentResult<T>> {
    this.requests.push(request as AgentRequest<unknown>);
    const script = this.scripts.shift();
    const base = {
      provider: this.name,
      model: this.model,
      durationMs: 1,
      attempts: 1,
      resumedSession: false,
      toolCalls: [],
      sessionId: `scripted-${this.requests.length}`,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
    };
    if (!script) return { ...base, status: 'failed', error: { message: 'no script left' } };
    const parsed = request.output.schema.safeParse(script(request as AgentRequest<unknown>));
    if (!parsed.success) return { ...base, status: 'invalid-output', error: { message: parsed.error.message } };
    return { ...base, status: 'succeeded', output: parsed.data };
  }
}
