import { Command } from 'commander';
import { listCursorModels } from './agents/cursor-provider.js';
import { formatRequirement } from './business-knowledge/business-knowledge-provider.js';
import { ConfigError, loadConfig, redactConfig } from './config/config.js';
import { createRuntime } from './orchestrator/bootstrap.js';
import type { CommandReport } from './reporting/reporter.js';

const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${message}`);

function printSummary(report: CommandReport): void {
  const usage = report.tokenUsage ? `${report.tokenUsage.totalTokens} tokens` : 'no tokens';
  console.log('\n──────────────── execution summary ────────────────');
  console.log(`status        : ${report.status.toUpperCase()}`);
  console.log(`mode          : ${report.mode}${report.reusedExistingTest ? ` (reused: ${report.matchReason})` : ''}`);
  console.log(`test          : ${report.testId ?? '-'} ${report.testVersion ? `v${report.testVersion}` : ''}`);
  console.log(`duration      : total ${report.durationMs.total}ms, playwright ${report.durationMs.testExecution ?? '-'}ms, agent ${report.durationMs.agent}ms`);
  console.log(`AI invocations: ${report.aiInvocations} (${usage}; cost: ${report.costChargedCents !== undefined ? `${report.costChargedCents}¢` : report.costNote})`);
  if (report.healing.attempted) console.log(`healing       : ${report.healing.outcome} after ${report.healing.attempts} attempt(s), classification ${report.healing.classification}`);
  if (report.requirement) console.log(`requirement   : ${report.requirement.requirementId} -> ${report.requirement.result.toUpperCase()}`);
  for (const failure of report.failures.slice(0, 3)) console.log(`failure       : ${failure.message.split('\n')[0]?.slice(0, 200)}`);
  console.log('───────────────────────────────────────────────────\n');
}

async function withRuntime(overrides: Record<string, string | undefined>, fn: (rt: ReturnType<typeof createRuntime>) => Promise<number>): Promise<void> {
  const config = loadConfig(overrides);
  const runtime = createRuntime(config, log);
  try {
    process.exitCode = await fn(runtime);
  } finally {
    await runtime.close();
  }
}

const exitCodeFor = (reports: CommandReport[]) => (reports.every((r) => r.status === 'passed') ? 0 : 1);

const program = new Command()
  .name('agent')
  .description('Generic, self-learning, business-aware agentic UI testing framework')
  .option('--app <appId>', 'application profile id (overrides APP_ID)');

const appOverride = () => ({ APP_ID: program.opts<{ app?: string }>().app });

program
  .command('explore')
  .description('Explore an application and generate + execute a test for a natural-language objective')
  .requiredOption('--url <url>', 'target application URL (must be in ALLOWED_HOSTS)')
  .requiredOption('--task <objective>', 'natural-language testing objective')
  .option('--force', 'generate even if a matching test exists')
  .action(async (opts: { url: string; task: string; force?: boolean }) =>
    withRuntime({ ...appOverride(), TARGET_APP_URL: opts.url }, async ({ orchestrator }) => {
      const report = await orchestrator.generate({ objective: opts.task, force: opts.force });
      printSummary(report);
      return exitCodeFor([report]);
    }),
  );

program
  .command('generate')
  .description('Generate a test from an objective (--task) or a business requirement (--requirement). Reuses existing tests unless --force')
  .option('--task <objective>', 'natural-language testing objective')
  .option('--requirement <id>', 'business requirement id, e.g. REQ-001')
  .option('--force', 'generate even if a matching test exists')
  .action(async (opts: { task?: string; requirement?: string; force?: boolean }) =>
    withRuntime(appOverride(), async ({ orchestrator }) => {
      const report = await orchestrator.generate({ objective: opts.task, requirementId: opts.requirement, force: opts.force });
      printSummary(report);
      return exitCodeFor([report]);
    }),
  );

program
  .command('run')
  .description('Execute stored tests directly with Playwright (no AI); heals previously passing tests that fail')
  .option('--test <id>', 'stored test id')
  .option('--task <objective>', 'find the stored test by objective (generates one if none matches)')
  .option('--requirement <id>', 'find the stored test by business requirement id')
  .option('--all', 'run every stored test')
  .option('--no-heal', 'do not attempt self-healing on failure')
  .action(async (opts: { test?: string; task?: string; requirement?: string; all?: boolean; heal: boolean }) =>
    withRuntime(appOverride(), async ({ orchestrator }) => {
      const reports = await orchestrator.run({ testId: opts.test, objective: opts.task, requirementId: opts.requirement, all: opts.all, heal: opts.heal });
      reports.forEach(printSummary);
      return exitCodeFor(reports);
    }),
  );

program
  .command('heal')
  .description('Run a stored test and, if it fails, attempt AI-driven self-healing')
  .requiredOption('--test <id>', 'stored test id')
  .option('--force', 'allow healing a test that never passed')
  .action(async (opts: { test: string; force?: boolean }) =>
    withRuntime(appOverride(), async ({ orchestrator }) => {
      const report = await orchestrator.heal(opts.test, { force: opts.force });
      printSummary(report);
      return exitCodeFor([report]);
    }),
  );

program
  .command('report')
  .description('Write an aggregate summary report from persisted knowledge')
  .action(async () =>
    withRuntime(appOverride(), async ({ deps }) => {
      const summary = deps.reporter.writeSummary(deps.store, deps.profile.name);
      console.log(`summary written to ${summary.markdown}`);
      console.log(JSON.stringify(summary.data, null, 2));
      return 0;
    }),
  );

program
  .command('requirements')
  .description('Show business context retrieved by the Business Knowledge Provider')
  .option('--requirement <id>', 'requirement id')
  .option('--task <objective>', 'free-text objective to match against')
  .action(async (opts: { requirement?: string; task?: string }) =>
    withRuntime(appOverride(), async ({ deps }) => {
      const context = await deps.business.getRelevantContext({
        appId: deps.profile.id,
        requirementIds: opts.requirement ? [opts.requirement] : undefined,
        objective: opts.task,
      });
      console.log(`provider: ${context.provider}, strategy: ${context.retrieval.strategy}, matched: ${JSON.stringify(context.retrieval.matchedBy)}`);
      for (const requirement of context.requirements) console.log(`\n${formatRequirement(requirement)}`);
      if (context.requirements.length === 0) console.log('no matching requirements');
      return context.requirements.length ? 0 : 1;
    }),
  );

program
  .command('models')
  .description('List models available to the configured CURSOR_API_KEY')
  .action(async () => {
    const config = loadConfig(appOverride());
    if (!config.provider.cursorApiKey) throw new ConfigError('CURSOR_API_KEY is not set');
    for (const model of await listCursorModels(config.provider.cursorApiKey)) console.log(`${model.id}\t${model.displayName}`);
  });

program
  .command('doctor')
  .description('Validate configuration and connectivity')
  .action(async () => {
    const config = loadConfig(appOverride());
    console.log(JSON.stringify(redactConfig(config), null, 2));
    try {
      const response = await fetch(config.target.url, { signal: AbortSignal.timeout(5_000) });
      console.log(`target app ${config.target.url}: HTTP ${response.status}`);
    } catch (err) {
      console.log(`target app ${config.target.url}: NOT reachable (${err instanceof Error ? err.message : err})`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\nerror: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof ConfigError ? 2 : 1;
});
