import type { AgentProvider, AgentRequest, AgentResult } from './agent-provider.js';

/**
 * Extension point for a future, not-yet-chosen external model vendor.
 *
 * Intentionally NOT implemented: vendor, model, API format and authentication are unknown, and an
 * arbitrary vendor key cannot be passed to the Cursor SDK. To implement it:
 *  1. Render the prompt with `renderPrompt(request)` (provider-neutral).
 *  2. Map `request.tools` to the vendor's function/tool-calling format and run a bounded tool loop,
 *     calling `tool.execute(args)` for each tool call.
 *  3. Use the vendor's native JSON-schema output (or a final tool call) with `request.output.jsonSchema`,
 *     then validate with `request.output.schema`.
 *  4. Map vendor usage fields to `TokenUsage`; only fill `cost` from a billing API, never estimate.
 * Nothing outside this file needs to change.
 */
export interface ExternalModelProviderOptions {
  endpoint?: string;
  apiKey?: string;
  model?: string;
}

export class ExternalModelProviderNotConfigured extends Error {
  constructor() {
    super(
      'AGENT_PROVIDER=external is a prepared extension point and is not implemented yet. ' +
        'See src/agents/external-model-provider.ts for the integration contract.',
    );
    this.name = 'ExternalModelProviderNotConfigured';
  }
}

export class ExternalModelProvider implements AgentProvider {
  readonly name = 'external';
  readonly model: string;

  constructor(options: ExternalModelProviderOptions = {}) {
    this.model = options.model ?? 'unconfigured';
  }

  async execute<T>(_request: AgentRequest<T>): Promise<AgentResult<T>> {
    throw new ExternalModelProviderNotConfigured();
  }
}
