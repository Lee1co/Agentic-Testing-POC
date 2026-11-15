import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentProvider } from '../../src/agents/agent-provider.js';
import type { BusinessKnowledgeProvider } from '../../src/business-knowledge/business-knowledge-provider.js';
import { FRAMEWORK_ROOT, parseConfig } from '../../src/config/config.js';
import { createRuntime } from '../../src/orchestrator/bootstrap.js';

/**
 * Isolated framework data root inside testing-agent/.agent-workspace (so generated specs can resolve
 * @playwright/test from the framework's node_modules) with its own knowledge, reports and tests.
 */
export function createWorkspace(appUrl: string, options: { provider?: AgentProvider; business?: BusinessKnowledgeProvider; maxHealingAttempts?: number } = {}) {
  const base = path.join(FRAMEWORK_ROOT, '.agent-workspace', 'it');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'ws-'));
  const generated = path.join(root, 'generated-tests');
  mkdirSync(generated, { recursive: true });
  for (const file of ['playwright.config.ts', 'fixtures.ts']) {
    copyFileSync(path.join(FRAMEWORK_ROOT, 'generated-tests', file), path.join(generated, file));
  }
  mkdirSync(path.join(root, 'app-profiles'), { recursive: true });
  writeFileSync(
    path.join(root, 'app-profiles', 'fixture-app.json'),
    JSON.stringify({ id: 'fixture-app', name: 'Fixture App', testDataStrategy: 'stateless page' }),
  );

  const config = parseConfig(
    {
      APP_ID: 'fixture-app',
      TARGET_APP_URL: appUrl,
      MAX_HEALING_ATTEMPTS: String(options.maxHealingAttempts ?? 2),
      TEST_TIMEOUT_MS: '20000',
      AGENT_PROVIDER: 'cursor',
    },
    root,
  );
  const runtime = createRuntime(config, () => undefined, {
    provider: options.provider ? () => options.provider! : () => {
      throw new Error('AI provider must not be used in this test');
    },
    business: options.business,
  });
  return {
    root,
    generated,
    config,
    ...runtime,
    dispose: async () => {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
