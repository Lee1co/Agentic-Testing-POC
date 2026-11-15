import path from 'node:path';
import { createAgentProvider } from '../agents/provider-factory.js';
import type { AgentProvider } from '../agents/agent-provider.js';
import { PageExplorer } from '../browser/page-explorer.js';
import { PlaywrightTestRunner } from '../browser/test-runner.js';
import { LocalBusinessKnowledgeProvider } from '../business-knowledge/local-business-knowledge-provider.js';
import { loadAppProfile } from '../config/app-profile.js';
import { FRAMEWORK_ROOT, type FrameworkConfig } from '../config/config.js';
import { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { Reporter } from '../reporting/reporter.js';
import { AgentOrchestrator, type OrchestratorDependencies } from './orchestrator.js';

/** Composition root: the only place where concrete implementations are wired together. */
export function createRuntime(
  config: FrameworkConfig,
  log: (message: string) => void,
  overrides: Partial<Pick<OrchestratorDependencies, 'provider' | 'business'>> = {},
) {
  const profile = loadAppProfile(config.paths.appProfiles, config.target.appId);
  const explorer = new PageExplorer({
    baseUrl: config.target.url,
    allowedHosts: config.target.allowedHosts,
    headless: config.playwright.headless,
    artifactsDir: path.join(config.paths.reports, 'artifacts', 'exploration'),
  });
  const runner = new PlaywrightTestRunner({
    frameworkRoot: FRAMEWORK_ROOT,
    configFile: path.join(config.paths.generatedTests, 'playwright.config.ts'),
    baseUrl: config.target.url,
    allowedHosts: config.target.allowedHosts,
    headless: config.playwright.headless,
    testTimeoutMs: config.playwright.testTimeoutMs,
  });
  let provider: AgentProvider | undefined;
  const deps: OrchestratorDependencies = {
    config,
    profile,
    store: new KnowledgeStore(config.paths.knowledge, profile.id),
    provider: overrides.provider ?? (() => (provider ??= createAgentProvider(config, log))),
    business: overrides.business ?? new LocalBusinessKnowledgeProvider(config.paths.businessContext),
    explorer,
    runner,
    reporter: new Reporter(config.paths.reports),
    log,
  };
  return {
    deps,
    orchestrator: new AgentOrchestrator(deps),
    close: () => explorer.close(),
  };
}
