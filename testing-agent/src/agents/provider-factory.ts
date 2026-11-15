import type { FrameworkConfig } from '../config/config.js';
import type { AgentProvider } from './agent-provider.js';
import { CursorAgentProvider } from './cursor-provider.js';
import { ExternalModelProvider } from './external-model-provider.js';

/** The only place that knows which concrete providers exist. */
export function createAgentProvider(config: FrameworkConfig, log?: (message: string) => void): AgentProvider {
  switch (config.provider.name) {
    case 'cursor':
      if (!config.provider.cursorApiKey) {
        throw new Error('CURSOR_API_KEY is not set. Add it to testing-agent/.env (see .env.example).');
      }
      return new CursorAgentProvider({
        apiKey: config.provider.cursorApiKey,
        model: config.provider.model,
        timeoutMs: config.provider.timeoutMs,
        maxRetries: config.provider.maxRetries,
        workspaceDir: config.paths.agentWorkspace,
        log,
      });
    case 'external':
      return new ExternalModelProvider({ model: config.provider.model });
  }
}
