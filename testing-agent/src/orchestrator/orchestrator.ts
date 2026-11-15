import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AgentInvocationBudgetExceeded,
  MeteredAgentProvider,
  type AgentProvider,
  type AgentResult,
  type PromptSection,
} from '../agents/agent-provider.js';
import type { PageExplorer } from '../browser/page-explorer.js';
import type { PlaywrightTestRunner, TestRunResult } from '../browser/test-runner.js';
import {
  RequirementNotFoundError,
  type BusinessContextResult,
  type BusinessKnowledgeProvider,
  type BusinessRequirement,
} from '../business-knowledge/business-knowledge-provider.js';
import type { AppProfile } from '../config/app-profile.js';
import type { FrameworkConfig } from '../config/config.js';
import { createCandidateRunnerTool, createExploreTool, type ToolAudit } from '../generator/agent-tools.js';
import {
  GENERATED_TEST_OUTPUT,
  businessContextSections,
  executionContextSection,
  generationInstructions,
  technicalContextSection,
  type GeneratedTest,
} from '../generator/prompts.js';
import {
  composeTestFile,
  extractLocators,
  extractTitle,
  failingAcceptanceCriteria,
  unwrapCodeFence,
  validateTestCode,
} from '../generator/test-code.js';
import { HealingEngine, type HealingReport } from '../healing/healing-engine.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';
import type { ExecutionRecord, TestRecord } from '../knowledge/schemas.js';
import { findReusableTest, normalizeObjective, slugify, type MatchResult } from '../knowledge/test-matcher.js';
import {
  summarizeInvocation,
  sumUsage,
  type CommandReport,
  type ExecutionMode,
  type Reporter,
  type RequirementValidation,
} from '../reporting/reporter.js';

export interface OrchestratorDependencies {
  config: FrameworkConfig;
  profile: AppProfile;
  store: KnowledgeStore;
  /** Lazily created so that pure reuse runs never need AI credentials. */
  provider: () => AgentProvider;
  business: BusinessKnowledgeProvider;
  explorer: PageExplorer;
  runner: PlaywrightTestRunner;
  reporter: Reporter;
  log: (message: string) => void;
}

export interface GenerateOptions {
  objective?: string;
  requirementId?: string;
  /** Generate even if a reusable test exists. */
  force?: boolean;
}

export interface RunOptions {
  testId?: string;
  objective?: string;
  requirementId?: string;
  all?: boolean;
  /** Attempt self-healing when a previously passing test fails (default true). */
  heal?: boolean;
}

interface CommandState {
  command: string;
  startedAt: Date;
  provider?: MeteredAgentProvider;
  agentResults: Array<{ kind: string; result: AgentResult<unknown> }>;
  notes: string[];
}

export class AgentOrchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  private get appInit() {
    return { name: this.deps.profile.name, targetUrl: this.deps.config.target.url };
  }

  private begin(command: string): CommandState {
    return { command, startedAt: new Date(), agentResults: [], notes: [] };
  }

  private providerFor(state: CommandState): MeteredAgentProvider {
    state.provider ??= new MeteredAgentProvider(this.deps.provider(), this.deps.config.provider.maxInvocationsPerCommand);
    return state.provider;
  }

  private specPath(test: Pick<TestRecord, 'file'>): string {
    return path.join(this.deps.config.paths.generatedTests, test.file);
  }

  private artifactsDir(label: string): string {
    return path.join(this.deps.config.paths.reports, 'artifacts', `${Date.now()}-${label}`);
  }

  private recordAgent(state: CommandState, kind: string, result: AgentResult<unknown>): void {
    state.agentResults.push({ kind, result });
    this.deps.store.appendAgentSession({
      at: new Date().toISOString(),
      kind,
      correlationId: kind,
      provider: result.provider,
      model: result.model,
      status: result.status,
      durationMs: result.durationMs,
      attempts: result.attempts,
      sessionId: result.sessionId,
      runId: result.runId,
      requestId: result.requestId,
      resumedSession: result.resumedSession,
      toolCalls: result.toolCalls.map((c) => c.name),
      usage: result.usage,
      costChargedCents: result.cost?.chargedCents,
      costUnavailableReason: result.costUnavailableReason,
      error: result.error?.message,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Context assembly (technical / execution / business are retrieved separately)
  // ---------------------------------------------------------------------------------------------

  private technicalAndExecutionSections(): PromptSection[] {
    const { store } = this.deps;
    const sections = [technicalContextSection(this.deps.config.target.url, this.deps.profile, store.getApplication())];
    const execution = executionContextSection(store.listExecutions(), store.listHealing(), store.listTests());
    if (execution) sections.push(execution);
    return sections;
  }

  private async businessContextFor(requirementIds: string[], objective?: string): Promise<BusinessContextResult | undefined> {
    const context = await this.deps.business.getRelevantContext({
      appId: this.deps.profile.id,
      requirementIds: requirementIds.length ? requirementIds : undefined,
      objective: requirementIds.length ? undefined : objective,
    });
    return context.requirements.length ? context : undefined;
  }

  private agentTools(testId: string, audit: ToolAudit, requiredMarkers: string[]) {
    return [
      createExploreTool(this.deps.explorer, audit),
      createCandidateRunnerTool(
        {
          runner: this.deps.runner,
          candidatesDir: path.join(this.deps.config.paths.generatedTests, '_candidates'),
          artifactsDir: this.artifactsDir(`candidates-${testId}`),
          testId,
          validation: { allowedHosts: this.deps.config.target.allowedHosts, requiredMarkers },
        },
        audit,
      ),
    ];
  }

  private recordExplorations(audit: ToolAudit, objective: string): void {
    const observations = audit.explorations.map((e) => ({
      path: new URL(e.url).pathname,
      url: e.url,
      title: e.title,
      testIds: e.testIds,
      observedAt: new Date().toISOString(),
    }));
    if (observations.length) this.deps.store.recordPageObservations(observations, objective, this.appInit);
  }

  // ---------------------------------------------------------------------------------------------
  // generate / explore
  // ---------------------------------------------------------------------------------------------

  async generate(options: GenerateOptions): Promise<CommandReport> {
    const state = this.begin(options.requirementId ? 'generate-business' : 'generate');
    const { store, business, profile, log } = this.deps;

    let requirement: BusinessRequirement | undefined;
    if (options.requirementId) {
      requirement = await business.getRequirement(profile.id, options.requirementId);
      if (!requirement) throw new RequirementNotFoundError(profile.id, options.requirementId);
    }
    const objective = options.objective ?? (requirement ? `Validate ${requirement.id}: ${requirement.title}` : undefined);
    if (!objective) throw new Error('generate requires --task or --requirement');

    if (!options.force) {
      const match = findReusableTest(store.listTests(), requirement ? { requirementId: requirement.id } : { objective });
      if (match) {
        log(`reuse-first: found existing test ${match.test.id} (${match.reason}); executing it instead of calling the AI`);
        return this.executeExisting(state, match, true);
      }
    }

    const businessContext = await this.businessContextFor(requirement ? [requirement.id] : [], objective);
    const businessAware = Boolean(requirement);
    if (!businessAware && businessContext) {
      state.notes.push(`Related business requirements injected for awareness: ${businessContext.requirements.map((r) => r.id).join(', ')}`);
    }
    if (requirement && businessContext) {
      log(`business context retrieved via ${businessContext.provider}: ${businessContext.requirements.map((r) => r.id).join(', ')}`);
    }

    const acIds = requirement?.acceptanceCriteria.map((ac) => ac.id) ?? [];
    let testId = slugify(requirement ? `${requirement.id} ${requirement.title}` : objective);
    if (store.getTest(testId)) testId = `${testId}-${Date.now().toString(36)}`;

    const audit: ToolAudit = { explorations: [], candidateRuns: [] };
    const sections = [
      ...this.technicalAndExecutionSections(),
      ...businessContextSections(businessContext, { awarenessOnly: !businessAware }),
    ];

    log(`invoking AI agent to explore the application and generate test "${testId}"`);
    let agent: AgentResult<GeneratedTest>;
    try {
      agent = await this.providerFor(state).execute({
        kind: 'generate-test',
        correlationId: testId,
        instructions: generationInstructions(objective, businessAware),
        sections,
        tools: this.agentTools(testId, audit, acIds),
        output: GENERATED_TEST_OUTPUT,
      });
    } catch (err) {
      if (err instanceof AgentInvocationBudgetExceeded) state.notes.push(err.message);
      throw err;
    }
    this.recordAgent(state, 'generate-test', agent);
    this.recordExplorations(audit, objective);
    log(`agent finished: ${agent.status} in ${agent.durationMs}ms, ${audit.explorations.length} explorations, ${audit.candidateRuns.length} candidate runs`);

    if (agent.status !== 'succeeded' || !agent.output) {
      return this.finish(state, {
        mode: businessAware ? 'business-generate' : 'generate',
        objective,
        status: 'error',
        failures: [{ testTitle: '(agent)', message: agent.error?.message ?? agent.status }],
      });
    }

    const body = unwrapCodeFence(agent.output.code);
    const validation = validateTestCode(body, { allowedHosts: this.deps.config.target.allowedHosts, requiredMarkers: acIds });
    if (!validation.valid) {
      return this.finish(state, {
        mode: businessAware ? 'business-generate' : 'generate',
        objective,
        status: 'error',
        failures: validation.errors.map((message) => ({ testTitle: '(static validation)', message })),
      });
    }

    const relativeFile = `${profile.id}/${testId}.spec.ts`;
    const absoluteFile = path.join(this.deps.config.paths.generatedTests, relativeFile);
    mkdirSync(path.dirname(absoluteFile), { recursive: true });
    const fileContent = composeTestFile(
      {
        testId,
        appId: profile.id,
        objective,
        version: 1,
        requirementIds: requirement ? [requirement.id] : [],
        acceptanceCriteriaIds: acIds,
        generatedBy: `${agent.provider}/${agent.model} session ${agent.sessionId ?? 'n/a'}`,
      },
      body,
    );
    writeFileSync(absoluteFile, fileContent);
    log(`saved generated test ${relativeFile}; executing it independently`);

    const run = await this.deps.runner.run(absoluteFile, this.artifactsDir(`run-${testId}`));
    const assessment = agent.output.requirementAssessment;
    const failedCriteria = failingAcceptanceCriteria(
      fileContent,
      run.failures.flatMap((f) => (f.location ? [f.location.line] : [])),
    );
    const agentClaimsDefect = businessAware && run.status === 'failed' && assessment?.behaviourMatchesRequirement === 'no';
    // A test that never passed only proves a defect when the failing assertion belongs to an acceptance criterion.
    const businessDefect = agentClaimsDefect && failedCriteria.length > 0;
    if (agentClaimsDefect && !businessDefect) {
      state.notes.push(
        'Agent reported the behaviour as contradicting the requirement, but the failing statement is outside every acceptance-criterion ' +
          'step (setup or navigation), so the verdict is not accepted: the requirement is inconclusive and the test needs attention.',
      );
    }
    if (businessDefect) state.notes.push(`Failing acceptance criteria: ${failedCriteria.join(', ')}.`);
    const now = new Date().toISOString();
    const record: TestRecord = {
      id: testId,
      appId: profile.id,
      objective,
      normalizedObjective: normalizeObjective(objective),
      kind: businessAware ? 'business' : 'exploratory',
      file: relativeFile,
      title: agent.output.title || extractTitle(body),
      requirementIds: requirement ? [requirement.id] : [],
      acceptanceCriteriaIds: acIds,
      version: 1,
      status: run.status === 'passed' ? 'active' : businessDefect ? 'business-defect' : 'needs-attention',
      createdAt: now,
      updatedAt: now,
      generatedBy: { provider: agent.provider, model: agent.model, sessionId: agent.sessionId, runId: agent.runId },
      locators: extractLocators(body),
      assertionCount: validation.assertionCount,
      rationale: agent.output.rationale,
      lastRun: { at: now, status: run.status, durationMs: run.durationMs },
      lastSuccessfulRunAt: run.status === 'passed' ? now : undefined,
      previousVersions: [],
    };
    store.saveTest(record);
    this.appendExecution(record, run, businessAware ? 'business-generate' : 'generate', 1);
    if (run.status === 'passed') store.recordVerifiedLocators(testId, record.locators, this.appInit);
    if (validation.warnings.length) state.notes.push(`Validator warnings: ${validation.warnings.join('; ')}`);
    state.notes.push(`Agent rationale: ${agent.output.rationale}`);
    if (!agent.output.verifiedByCandidateRun) state.notes.push('Agent did not report a passing candidate run before submitting.');

    let requirementResult: RequirementValidation | undefined;
    if (requirement) {
      requirementResult = this.evaluateRequirement(requirement, record, run, assessment?.explanation);
    }

    return this.finish(state, {
      mode: businessAware ? 'business-generate' : 'generate',
      objective,
      status: run.status === 'passed' ? 'passed' : businessDefect ? 'business-defect' : run.status,
      test: record,
      run,
      requirement: requirementResult,
      failures: run.failures,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // run (reuse) / heal
  // ---------------------------------------------------------------------------------------------

  async run(options: RunOptions): Promise<CommandReport[]> {
    const { store } = this.deps;
    const heal = options.heal ?? true;
    if (options.all) {
      const reports: CommandReport[] = [];
      for (const test of store.listTests()) {
        reports.push(await this.executeExisting(this.begin('run'), { test, reason: 'test-id', score: 1 }, heal));
      }
      return reports;
    }
    const match = findReusableTest(store.listTests(), {
      testId: options.testId,
      requirementId: options.requirementId,
      objective: options.objective,
    });
    if (!match) {
      if (options.objective || options.requirementId) {
        this.deps.log('no reusable test found; falling back to AI generation');
        return [await this.generate({ objective: options.objective, requirementId: options.requirementId })];
      }
      throw new Error(`No stored test matches ${JSON.stringify(options)}`);
    }
    return [await this.executeExisting(this.begin('run'), match, heal)];
  }

  async heal(testId: string, options: { force?: boolean } = {}): Promise<CommandReport> {
    const test = this.deps.store.getTest(testId);
    if (!test) throw new Error(`Unknown test ${testId}`);
    const state = this.begin('heal');
    const run = await this.deps.runner.run(this.specPath(test), this.artifactsDir(`run-${test.id}`));
    this.appendExecution(test, run, 'reuse', 0);
    if (run.status === 'passed') {
      state.notes.push('Test passes against the current application; no healing required.');
      return this.finish(state, { mode: 'reuse', objective: test.objective, status: 'passed', test, run, reused: 'test-id', failures: [] });
    }
    if (!test.lastSuccessfulRunAt && !options.force) {
      state.notes.push('Test never passed before; healing is only applied to previously passing tests (use --force to override).');
      return this.finish(state, { mode: 'reuse', objective: test.objective, status: run.status, test, run, reused: 'test-id', failures: run.failures });
    }
    return this.healAndFinish(state, test, run, 'test-id');
  }

  private async executeExisting(state: CommandState, match: MatchResult, allowHeal: boolean): Promise<CommandReport> {
    const { store, log } = this.deps;
    const test = match.test;
    const file = this.specPath(test);
    const mode: ExecutionMode = test.kind === 'business' ? 'business-reuse' : 'reuse';
    if (!existsSync(file)) throw new Error(`Stored test file is missing: ${file}`);

    log(`executing stored test ${test.id} v${test.version} directly with Playwright (no AI)`);
    const run = await this.deps.runner.run(file, this.artifactsDir(`run-${test.id}`));
    this.appendExecution(test, run, 'reuse', 0);
    const updated = store.updateTest(test.id, (record) => {
      record.lastRun = { at: new Date().toISOString(), status: run.status, durationMs: run.durationMs };
      if (run.status === 'passed') {
        record.lastSuccessfulRunAt = record.lastRun.at;
        if (record.status === 'needs-attention') record.status = 'active';
      }
    });
    if (run.status === 'passed') store.recordVerifiedLocators(test.id, updated.locators, this.appInit);

    if (run.status !== 'passed' && allowHeal && test.lastSuccessfulRunAt && test.status === 'active') {
      log(`previously passing test failed; starting self-healing`);
      return this.healAndFinish(state, updated, run, match.reason);
    }

    const requirement = await this.requirementFor(updated);
    return this.finish(state, {
      mode,
      objective: test.objective,
      status: run.status,
      test: updated,
      run,
      reused: match.reason,
      requirement: requirement ? this.evaluateRequirement(requirement, updated, run) : undefined,
      failures: run.failures,
    });
  }

  private async requirementFor(test: TestRecord): Promise<BusinessRequirement | undefined> {
    const id = test.requirementIds[0];
    return id ? this.deps.business.getRequirement(test.appId, id) : undefined;
  }

  private async healAndFinish(state: CommandState, test: TestRecord, failedRun: TestRunResult, reason: string): Promise<CommandReport> {
    const { store, config, log } = this.deps;
    const provider = this.providerFor(state);
    const requirement = await this.requirementFor(test);
    const businessContext = requirement ? await this.businessContextFor([requirement.id]) : undefined;

    const engine = new HealingEngine({
      provider,
      runner: this.deps.runner,
      generatedTestsDir: config.paths.generatedTests,
      artifactsDir: this.artifactsDir(`heal-${test.id}`),
      allowedHosts: config.target.allowedHosts,
      maxAttempts: config.healing.maxAttempts,
      log: (m) => log(`[healing] ${m}`),
      buildContext: () => {
        const audit: ToolAudit = { explorations: [], candidateRuns: [] };
        return {
          sections: [...this.technicalAndExecutionSections(), ...businessContextSections(businessContext)],
          tools: this.agentTools(`${test.id}-heal`, audit, test.acceptanceCriteriaIds),
        };
      },
      onAttempt: (record, agent) => {
        store.appendHealing(record);
        if (agent) this.recordAgent(state, 'repair-test', agent);
      },
    });

    let healing: HealingReport;
    try {
      healing = await engine.heal(test, failedRun);
    } catch (err) {
      if (!(err instanceof AgentInvocationBudgetExceeded)) throw err;
      state.notes.push(err.message);
      healing = { outcome: 'exhausted', analysis: { category: 'unknown', worthInvestigating: true, evidence: [] }, attempts: [] };
    }
    const last = healing.attempts.at(-1);
    let finalTest = test;
    let finalRun = failedRun;

    if (healing.outcome === 'repaired' && healing.repairedRun && healing.newVersion) {
      const specFile = this.specPath(test);
      finalRun = healing.repairedRun;
      const now = new Date().toISOString();
      finalTest = store.updateTest(test.id, (record) => {
        record.previousVersions.push({ version: record.version, file: healing.archivedFile!, reason: last?.diagnosis ?? 'self-healing', archivedAt: now });
        record.version = healing.newVersion!;
        record.locators = extractLocators(readSpec(specFile));
        record.lastRun = { at: now, status: 'passed', durationMs: finalRun.durationMs };
        record.lastSuccessfulRunAt = now;
        record.status = 'active';
      });
      this.appendExecution(finalTest, finalRun, 'heal', state.provider?.count ?? 0);
      store.recordVerifiedLocators(test.id, finalTest.locators, this.appInit);
    } else if (healing.finalClassification === 'business-defect' || healing.finalClassification === 'application-regression') {
      finalTest = store.updateTest(test.id, (record) => {
        record.status = healing.finalClassification === 'business-defect' ? 'business-defect' : 'needs-attention';
      });
      state.notes.push(`Agent classified the failure as ${healing.finalClassification}; the test was NOT modified.`);
    } else {
      finalTest = store.updateTest(test.id, (record) => {
        record.status = 'needs-attention';
      });
    }

    const status: CommandReport['status'] =
      healing.outcome === 'repaired' ? 'passed' : healing.finalClassification === 'business-defect' ? 'business-defect' : 'failed';
    return this.finish(state, {
      mode: 'heal',
      objective: test.objective,
      status,
      test: finalTest,
      run: finalRun,
      reused: reason,
      healing,
      requirement: requirement ? this.evaluateRequirement(requirement, finalTest, finalRun, last?.diagnosis, healing.finalClassification) : undefined,
      failures: healing.outcome === 'repaired' ? [] : failedRun.failures,
      originalFailures: failedRun.failures,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // shared helpers
  // ---------------------------------------------------------------------------------------------

  private appendExecution(test: TestRecord, run: TestRunResult, mode: ExecutionRecord['mode'], aiInvocations: number): void {
    this.deps.store.appendExecution({
      id: `${test.id}-${Date.now()}`,
      testId: test.id,
      at: new Date().toISOString(),
      mode,
      status: run.status,
      durationMs: run.durationMs,
      testVersion: test.version,
      aiInvocations,
      failureSummary: run.failures[0]?.message.split('\n')[0]?.slice(0, 300),
    });
  }

  private evaluateRequirement(
    requirement: BusinessRequirement,
    test: TestRecord,
    run: TestRunResult,
    explanation?: string,
    classification?: string,
  ): RequirementValidation {
    let result: RequirementValidation['result'];
    if (run.status === 'passed') result = 'satisfied';
    else if (test.status === 'business-defect' || classification === 'business-defect' || classification === 'application-regression') {
      result = 'violated';
    } else result = 'inconclusive';

    const text =
      result === 'satisfied'
        ? `Generated test asserting ${test.acceptanceCriteriaIds.join(', ')} passed against the running application.`
        : result === 'violated'
          ? `Application behaviour contradicts the requirement. ${explanation ?? ''}`.trim()
          : `Test did not pass for a technical reason; the requirement could not be evaluated. ${explanation ?? ''}`.trim();

    this.deps.store.upsertTraceability({
      requirementId: requirement.id,
      acceptanceCriteriaIds: test.acceptanceCriteriaIds,
      testId: test.id,
      testFile: test.file,
      lastResult: result,
      lastEvaluatedAt: new Date().toISOString(),
    });
    return {
      requirementId: requirement.id,
      title: requirement.title,
      acceptanceCriteriaIds: test.acceptanceCriteriaIds,
      result,
      explanation: text,
      source: `${requirement.source.document}${requirement.source.section ? ` §${requirement.source.section}` : ''}`,
    };
  }

  private finish(
    state: CommandState,
    input: {
      mode: ExecutionMode;
      objective?: string;
      status: CommandReport['status'];
      test?: TestRecord;
      run?: TestRunResult;
      reused?: string;
      healing?: HealingReport;
      requirement?: RequirementValidation;
      failures: Array<{ testTitle: string; message: string }>;
      originalFailures?: Array<{ testTitle: string; message: string }>;
    },
  ): CommandReport {
    const finishedAt = new Date();
    const invocations = state.agentResults.map((a) => summarizeInvocation(a.result, a.kind));
    const charged = invocations.map((i) => i.costChargedCents).filter((c): c is number => c !== undefined);
    const lastAttempt = input.healing?.attempts.at(-1);
    const notes = [...state.notes];
    if (input.originalFailures?.length && input.healing?.outcome === 'repaired') {
      notes.push(`Original failure before healing: ${input.originalFailures[0]!.message.split('\n')[0]}`);
    }
    if (input.healing) notes.push(`Deterministic pre-classification: ${input.healing.analysis.category}`);

    const report: CommandReport = {
      command: state.command,
      startedAt: state.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      appId: this.deps.profile.id,
      appName: this.deps.profile.name,
      targetUrl: this.deps.config.target.url,
      objective: input.objective,
      mode: input.mode,
      status: input.status,
      durationMs: {
        total: finishedAt.getTime() - state.startedAt.getTime(),
        testExecution: input.run?.durationMs,
        agent: invocations.reduce((sum, i) => sum + i.durationMs, 0),
      },
      testId: input.test?.id,
      testFile: input.test?.file,
      testVersion: input.test?.version,
      reusedExistingTest: Boolean(input.reused),
      matchReason: input.reused,
      aiInvocations: invocations.length,
      agentInvocations: invocations,
      tokenUsage: sumUsage(invocations.map((i) => i.usage)),
      costChargedCents: charged.length ? charged.reduce((a, b) => a + b, 0) : undefined,
      costNote: invocations.length
        ? `not reported (${invocations.find((i) => i.costUnavailableReason)?.costUnavailableReason ?? 'no billing data'}); no estimate is made`
        : 'no AI usage',
      healing: {
        attempted: Boolean(input.healing && input.healing.attempts.length > 0),
        outcome: input.healing?.outcome,
        attempts: input.healing?.attempts.length,
        classification: input.healing?.finalClassification,
        diagnosis: lastAttempt?.diagnosis,
        changes: lastAttempt?.changes,
        archivedOriginal: input.healing?.archivedFile,
      },
      failures: input.failures.map((f) => ({ testTitle: f.testTitle, message: f.message.slice(0, 1_500) })),
      screenshots: input.run?.screenshots ?? [],
      requirement: input.requirement,
      notes,
    };
    const files = this.deps.reporter.write(report);
    this.deps.log(`report written: ${path.relative(this.deps.config.paths.root, files.markdown)}`);
    return report;
  }
}

function readSpec(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
