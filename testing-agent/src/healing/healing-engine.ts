import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentProvider, AgentResult, AgentTool, PromptSection } from '../agents/agent-provider.js';
import type { PlaywrightTestRunner, TestRunResult } from '../browser/test-runner.js';
import { summarizeRun } from '../generator/agent-tools.js';
import { REPAIR_OUTPUT, repairInstructions, type Repair } from '../generator/prompts.js';
import {
  checkAssertionsPreserved,
  composeTestFile,
  stripHeader,
  unwrapCodeFence,
  validateTestCode,
} from '../generator/test-code.js';
import type { HealingRecord, TestRecord } from '../knowledge/schemas.js';
import { classifyFailure, type FailureAnalysis } from './failure-classifier.js';

export type HealingOutcome = 'repaired' | 'not-healable' | 'exhausted' | 'skipped';

export interface HealingAttemptReport {
  attempt: number;
  outcome: HealingRecord['outcome'];
  classification?: Repair['classification'];
  diagnosis?: string;
  details?: string;
  changes?: string[];
  agent?: AgentResult<Repair>;
}

export interface HealingReport {
  outcome: HealingOutcome;
  analysis: FailureAnalysis;
  attempts: HealingAttemptReport[];
  finalClassification?: Repair['classification'];
  repairedRun?: TestRunResult;
  archivedFile?: string;
  newVersion?: number;
}

export interface HealingDependencies {
  provider: AgentProvider;
  runner: PlaywrightTestRunner;
  generatedTestsDir: string;
  artifactsDir: string;
  allowedHosts: string[];
  maxAttempts: number;
  /** Builds per-attempt context and tools (exploration etc.) — supplied by the orchestrator. */
  buildContext: (attempt: number) => { sections: PromptSection[]; tools: AgentTool[] };
  onAttempt?: (record: HealingRecord, agent?: AgentResult<Repair>) => void;
  log: (message: string) => void;
}

const HEALABLE: Repair['classification'][] = ['locator-change', 'test-defect'];

export class HealingEngine {
  constructor(private readonly deps: HealingDependencies) {}

  async heal(test: TestRecord, failure: TestRunResult): Promise<HealingReport> {
    const analysis = classifyFailure(failure);
    const attempts: HealingAttemptReport[] = [];
    this.deps.log(`failure pre-classified as ${analysis.category} (${analysis.evidence.join('; ')})`);

    if (!analysis.worthInvestigating) {
      this.record(test, 0, analysis, { attempt: 0, outcome: 'not-healable', details: 'environment failure; healing skipped' });
      return { outcome: 'not-healable', analysis, attempts, finalClassification: 'environment' };
    }
    if (this.deps.maxAttempts < 1) {
      return { outcome: 'skipped', analysis, attempts };
    }

    const specPath = path.join(this.deps.generatedTestsDir, test.file);
    const originalCode = readFileSync(specPath, 'utf8');
    const markers = test.acceptanceCriteriaIds;
    let feedback = '';

    for (let attempt = 1; attempt <= this.deps.maxAttempts; attempt += 1) {
      this.deps.log(`healing attempt ${attempt}/${this.deps.maxAttempts}`);
      const context = this.deps.buildContext(attempt);
      const sections: PromptSection[] = [
        { title: 'Failing test (original, must not be weakened)', trusted: false, source: test.file, content: stripHeader(originalCode) },
        {
          title: 'Failure observed by the framework',
          trusted: false,
          source: 'playwright',
          content: `Deterministic pre-classification: ${analysis.category} (${analysis.evidence.join('; ')})\n${summarizeRun(failure)}`,
        },
        ...context.sections,
      ];
      if (feedback) sections.push({ title: 'Why your previous repair was rejected', trusted: true, content: feedback });

      const agent = await this.deps.provider.execute({
        kind: 'repair-test',
        correlationId: test.id,
        instructions: `${repairInstructions()}\n\nObjective of the test: ${test.objective}`,
        sections,
        tools: context.tools,
        output: REPAIR_OUTPUT,
        resumeSessionId: attempt === 1 ? test.generatedBy.sessionId : undefined,
      });

      if (agent.status !== 'succeeded' || !agent.output) {
        const report: HealingAttemptReport = { attempt, outcome: 'agent-error', details: agent.error?.message ?? agent.status, agent };
        attempts.push(report);
        this.record(test, attempt, analysis, report);
        feedback = `The previous attempt ended with ${agent.status}: ${agent.error?.message ?? ''}`;
        continue;
      }

      const repair = agent.output;
      const base: HealingAttemptReport = {
        attempt,
        outcome: 'candidate-failed',
        classification: repair.classification,
        diagnosis: repair.diagnosis,
        changes: repair.changes,
        agent,
      };

      if (!HEALABLE.includes(repair.classification)) {
        const report = { ...base, outcome: 'not-healable' as const, details: `agent classified failure as ${repair.classification}: ${repair.evidence}` };
        attempts.push(report);
        this.record(test, attempt, analysis, report);
        return { outcome: 'not-healable', analysis, attempts, finalClassification: repair.classification };
      }

      const candidateBody = unwrapCodeFence(repair.code ?? '');
      const validation = validateTestCode(candidateBody, { allowedHosts: this.deps.allowedHosts, requiredMarkers: markers });
      const guard = checkAssertionsPreserved(originalCode, candidateBody, markers);
      if (!validation.valid || !guard.ok) {
        const details = [...validation.errors, ...guard.violations].join('; ');
        const report = { ...base, outcome: 'rejected-by-guard' as const, details };
        attempts.push(report);
        this.record(test, attempt, analysis, report);
        feedback = `Your repair was rejected by the framework guard: ${details}. Keep all assertions and markers.`;
        continue;
      }

      const newVersion = test.version + 1;
      const candidateFile = composeTestFile(
        {
          testId: test.id,
          appId: test.appId,
          objective: test.objective,
          version: newVersion,
          requirementIds: test.requirementIds,
          acceptanceCriteriaIds: test.acceptanceCriteriaIds,
          generatedBy: `${agent.provider}/${agent.model} (healing)`,
        },
        candidateBody,
      );
      // Sibling of the app folders so the relative '../fixtures' import keeps resolving.
      const candidatesDir = path.join(this.deps.generatedTestsDir, '_candidates');
      mkdirSync(candidatesDir, { recursive: true });
      const candidatePath = path.join(candidatesDir, `${test.appId}.${test.id}.heal-v${newVersion}-a${attempt}.spec.ts`);
      writeFileSync(candidatePath, candidateFile);

      const run = await this.deps.runner.run(candidatePath, path.join(this.deps.artifactsDir, `heal-${test.id}-a${attempt}`));
      if (run.status !== 'passed') {
        const details = summarizeRun(run).slice(0, 1_500);
        const report = { ...base, outcome: 'candidate-failed' as const, details };
        attempts.push(report);
        this.record(test, attempt, analysis, report, path.relative(this.deps.generatedTestsDir, candidatePath));
        feedback = `The framework executed your repaired test and it failed:\n${details}`;
        continue;
      }

      // Validated: archive the original for rollback, then promote the candidate.
      const historyDir = path.join(this.deps.generatedTestsDir, '_history');
      mkdirSync(historyDir, { recursive: true });
      const archived = path.join(historyDir, `${test.appId}.${test.id}.v${test.version}.spec.ts`);
      if (!existsSync(archived)) copyFileSync(specPath, archived);
      writeFileSync(specPath, candidateFile);

      const report = { ...base, outcome: 'repaired' as const, details: `candidate passed in ${run.durationMs}ms` };
      attempts.push(report);
      this.record(test, attempt, analysis, report, path.relative(this.deps.generatedTestsDir, candidatePath), newVersion);
      return {
        outcome: 'repaired',
        analysis,
        attempts,
        finalClassification: repair.classification,
        repairedRun: run,
        archivedFile: path.relative(this.deps.generatedTestsDir, archived),
        newVersion,
      };
    }
    return { outcome: 'exhausted', analysis, attempts, finalClassification: attempts.at(-1)?.classification };
  }

  private record(
    test: TestRecord,
    attempt: number,
    analysis: FailureAnalysis,
    report: HealingAttemptReport,
    candidateFile?: string,
    toVersion?: number,
  ): void {
    this.deps.onAttempt?.(
      {
        id: `${test.id}-heal-${Date.now()}-${attempt}`,
        testId: test.id,
        at: new Date().toISOString(),
        attempt,
        preClassification: analysis.category,
        agentClassification: report.classification,
        diagnosis: report.diagnosis,
        outcome: report.outcome,
        details: report.details?.slice(0, 2_000),
        candidateFile,
        fromVersion: test.version,
        toVersion,
        agent: report.agent
          ? { provider: report.agent.provider, model: report.agent.model, sessionId: report.agent.sessionId, runId: report.agent.runId }
          : undefined,
      },
      report.agent,
    );
  }
}
