import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentResult, TokenUsage } from '../agents/agent-provider.js';
import type { KnowledgeStore } from '../knowledge/knowledge-store.js';

export type ExecutionMode = 'generate' | 'reuse' | 'heal' | 'business-generate' | 'business-reuse';

export interface AgentInvocationSummary {
  kind: string;
  status: string;
  provider: string;
  model: string;
  durationMs: number;
  sessionId?: string;
  runId?: string;
  resumedSession: boolean;
  toolCalls: Record<string, number>;
  usage?: TokenUsage;
  costChargedCents?: number;
  costUnavailableReason?: string;
}

export interface RequirementValidation {
  requirementId: string;
  title: string;
  acceptanceCriteriaIds: string[];
  result: 'satisfied' | 'violated' | 'inconclusive' | 'not-run';
  explanation: string;
  source: string;
}

export interface CommandReport {
  command: string;
  startedAt: string;
  finishedAt: string;
  appId: string;
  appName: string;
  targetUrl: string;
  objective?: string;
  mode: ExecutionMode;
  status: 'passed' | 'failed' | 'error' | 'business-defect';
  durationMs: { total: number; testExecution?: number; agent: number };
  testId?: string;
  testFile?: string;
  testVersion?: number;
  reusedExistingTest: boolean;
  matchReason?: string;
  aiInvocations: number;
  agentInvocations: AgentInvocationSummary[];
  tokenUsage?: TokenUsage;
  costChargedCents?: number;
  costNote: string;
  healing: {
    attempted: boolean;
    outcome?: string;
    attempts?: number;
    classification?: string;
    diagnosis?: string;
    changes?: string[];
    archivedOriginal?: string;
  };
  failures: Array<{ testTitle: string; message: string }>;
  screenshots: string[];
  requirement?: RequirementValidation;
  notes: string[];
}

export function summarizeInvocation(result: AgentResult<unknown>, kind: string): AgentInvocationSummary {
  const toolCalls: Record<string, number> = {};
  for (const call of result.toolCalls) toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
  return {
    kind,
    status: result.status,
    provider: result.provider,
    model: result.model,
    durationMs: result.durationMs,
    sessionId: result.sessionId,
    runId: result.runId,
    resumedSession: result.resumedSession,
    toolCalls,
    usage: result.usage,
    costChargedCents: result.cost?.chargedCents,
    costUnavailableReason: result.costUnavailableReason,
  };
}

export function sumUsage(usages: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const present = usages.filter((u): u is TokenUsage => Boolean(u));
  if (present.length === 0) return undefined;
  return present.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + u.cacheWriteTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
      reasoningTokens: (acc.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reasoningTokens: 0 },
  );
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return 'n/a';
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
}

export function renderMarkdown(report: CommandReport): string {
  const usage = report.tokenUsage;
  const lines = [
    `# ${report.command} — ${report.status.toUpperCase()}`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| Application | ${report.appName} (\`${report.appId}\`) |`,
    `| URL | ${report.targetUrl} |`,
    `| Objective | ${report.objective ?? '-'} |`,
    `| Execution mode | ${report.mode} |`,
    `| Test | ${report.testId ?? '-'} ${report.testVersion ? `(v${report.testVersion})` : ''} |`,
    `| Reused existing test | ${report.reusedExistingTest ? `yes (${report.matchReason})` : 'no'} |`,
    `| Total duration (measured) | ${fmtMs(report.durationMs.total)} |`,
    `| Playwright execution (measured) | ${fmtMs(report.durationMs.testExecution)} |`,
    `| Agent time (measured) | ${fmtMs(report.durationMs.agent)} |`,
    `| AI invocations | ${report.aiInvocations} |`,
    `| Tokens (measured, SDK-reported) | ${usage ? `${usage.totalTokens} total (in ${usage.inputTokens}, out ${usage.outputTokens}, cache read ${usage.cacheReadTokens})` : 'none'} |`,
    `| Cost | ${report.costChargedCents !== undefined ? `$${(report.costChargedCents / 100).toFixed(4)} (billing API)` : report.costNote} |`,
    `| Self-healing attempted | ${report.healing.attempted ? `yes — ${report.healing.outcome} after ${report.healing.attempts} attempt(s)` : 'no'} |`,
    `| Started | ${report.startedAt} |`,
  ];
  if (report.requirement) {
    const r = report.requirement;
    lines.push(
      '',
      `## Business requirement ${r.requirementId}`,
      `- Title: ${r.title}`,
      `- Source: ${r.source}`,
      `- Acceptance criteria covered: ${r.acceptanceCriteriaIds.join(', ')}`,
      `- **Validation result: ${r.result.toUpperCase()}**`,
      `- ${r.explanation}`,
    );
  }
  if (report.healing.attempted) {
    lines.push(
      '',
      '## Self-healing',
      `- Classification: ${report.healing.classification ?? 'n/a'}`,
      `- Diagnosis: ${report.healing.diagnosis ?? 'n/a'}`,
      ...(report.healing.changes ?? []).map((c) => `- Change: ${c}`),
      report.healing.archivedOriginal ? `- Original preserved for rollback: \`${report.healing.archivedOriginal}\`` : '',
    );
  }
  if (report.agentInvocations.length) {
    lines.push('', '## Agent invocations', '| Kind | Status | Model | Duration | Session | Resumed | Tools | Tokens |', '|---|---|---|---|---|---|---|---|');
    for (const a of report.agentInvocations) {
      const tools = Object.entries(a.toolCalls).map(([k, v]) => `${k}×${v}`).join(', ');
      lines.push(`| ${a.kind} | ${a.status} | ${a.model} | ${fmtMs(a.durationMs)} | \`${a.sessionId ?? '-'}\` | ${a.resumedSession} | ${tools} | ${a.usage?.totalTokens ?? 'n/a'} |`);
    }
  }
  if (report.failures.length) {
    lines.push('', '## Failures', ...report.failures.map((f) => `- **${f.testTitle}**: \`${f.message.split('\n')[0]?.slice(0, 300)}\``));
  }
  if (report.notes.length) lines.push('', '## Notes', ...report.notes.map((n) => `- ${n}`));
  return `${lines.filter((l) => l !== '').join('\n').replace(/\n## /g, '\n\n## ')}\n`;
}

export class Reporter {
  constructor(private readonly reportsDir: string) {
    mkdirSync(reportsDir, { recursive: true });
  }

  write(report: CommandReport): { json: string; markdown: string } {
    const stamp = report.startedAt.replace(/[:.]/g, '-');
    const base = path.join(this.reportsDir, `${stamp}-${report.command}${report.testId ? `-${report.testId}` : ''}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(`${base}.md`, renderMarkdown(report));
    return { json: `${base}.json`, markdown: `${base}.md` };
  }

  /** Aggregate view built only from persisted, measured records. */
  writeSummary(store: KnowledgeStore, appName: string): { json: string; markdown: string; data: Record<string, unknown> } {
    const tests = store.listTests();
    const executions = store.listExecutions();
    const healing = store.listHealing();
    const sessions = store.listAgentSessions();
    const traceability = store.listTraceability();
    const totalTokens = sessions.reduce((sum, s) => sum + (s.usage?.totalTokens ?? 0), 0);
    const byMode = executions.reduce<Record<string, { runs: number; ai: number; passed: number }>>((acc, e) => {
      const row = (acc[e.mode] ??= { runs: 0, ai: 0, passed: 0 });
      row.runs += 1;
      row.ai += e.aiInvocations;
      if (e.status === 'passed') row.passed += 1;
      return acc;
    }, {});

    const data = {
      generatedAt: new Date().toISOString(),
      appId: store.appId,
      appName,
      tests: tests.map((t) => ({ id: t.id, version: t.version, status: t.status, kind: t.kind, requirements: t.requirementIds, lastRun: t.lastRun })),
      executionsByMode: byMode,
      agentSessions: sessions.length,
      totalTokensMeasured: totalTokens,
      healing: healing.map((h) => ({ testId: h.testId, attempt: h.attempt, outcome: h.outcome, classification: h.agentClassification ?? h.preClassification })),
      traceability,
    };

    const md = [
      `# Agentic testing summary — ${appName}`,
      '',
      `Generated ${data.generatedAt}. All numbers are measured from persisted records.`,
      '',
      '## Tests',
      '| Test | Version | Kind | Status | Requirements | Last run |',
      '|---|---|---|---|---|---|',
      ...tests.map((t) => `| ${t.id} | v${t.version} | ${t.kind} | ${t.status} | ${t.requirementIds.join(', ') || '-'} | ${t.lastRun ? `${t.lastRun.status} @ ${t.lastRun.at}` : '-'} |`),
      '',
      '## Executions by mode',
      '| Mode | Runs | Passed | AI invocations |',
      '|---|---|---|---|',
      ...Object.entries(byMode).map(([mode, row]) => `| ${mode} | ${row.runs} | ${row.passed} | ${row.ai} |`),
      '',
      `Agent sessions recorded: ${sessions.length}; total tokens (SDK-reported): ${totalTokens}.`,
      '',
      '## Healing attempts',
      ...(healing.length ? healing.map((h) => `- ${h.at} ${h.testId} attempt ${h.attempt}: **${h.outcome}** (${h.agentClassification ?? h.preClassification}) v${h.fromVersion}${h.toVersion ? ` → v${h.toVersion}` : ''}`) : ['- none']),
      '',
      '## Requirement traceability',
      '| Requirement | Acceptance criteria | Test | Result | Evaluated |',
      '|---|---|---|---|---|',
      ...traceability.map((r) => `| ${r.requirementId} | ${r.acceptanceCriteriaIds.join(', ')} | ${r.testId} (\`${r.testFile}\`) | ${r.lastResult} | ${r.lastEvaluatedAt ?? '-'} |`),
      '',
    ].join('\n');

    const jsonPath = path.join(this.reportsDir, `summary-${store.appId}.json`);
    const mdPath = path.join(this.reportsDir, `summary-${store.appId}.md`);
    writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(mdPath, md);
    return { json: jsonPath, markdown: mdPath, data };
  }
}
