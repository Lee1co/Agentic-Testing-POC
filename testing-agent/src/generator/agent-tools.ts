import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentTool } from '../agents/agent-provider.js';
import { ExploreRequestSchema, formatExploreResult, type ExploreResult, type PageExplorer } from '../browser/page-explorer.js';
import type { PlaywrightTestRunner, TestRunResult } from '../browser/test-runner.js';
import { unwrapCodeFence, validateTestCode, type ValidationOptions } from './test-code.js';

/** Framework capabilities exposed to the agent. Each tool is bounded and audited. */

export interface ToolAudit {
  explorations: ExploreResult[];
  candidateRuns: Array<{ file: string; status: string }>;
}

const TARGET_SCHEMA = {
  type: 'object',
  description: 'How to find the element. Prefer testId, then role+name, then label.',
  properties: {
    role: { type: 'string', description: 'ARIA role, e.g. button, link, textbox, heading, switch, combobox' },
    name: { type: 'string', description: 'Accessible name used together with role' },
    label: { type: 'string' },
    testId: { type: 'string' },
    text: { type: 'string' },
    placeholder: { type: 'string' },
    css: { type: 'string', description: 'Last resort CSS selector' },
    exact: { type: 'boolean' },
  },
};

export function createExploreTool(explorer: PageExplorer, audit: ToolAudit, maxCalls = 15): AgentTool {
  let calls = 0;
  return {
    name: 'explore_page',
    description:
      'Open the application under test in a FRESH browser context (empty data), optionally replay interaction steps ' +
      '(goto/click/fill/select/check/press/waitForText) and return the resulting URL, data-testid values and the ' +
      'accessibility (ARIA) snapshot. Use it to discover real labels, roles and flows. Steps stop at the first failure.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the application base URL, e.g. "/" or "/auth/register"' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['goto', 'click', 'fill', 'select', 'check', 'press', 'waitForText'] },
              target: TARGET_SCHEMA,
              value: { type: 'string' },
            },
            required: ['action'],
          },
        },
      },
      required: ['path'],
    },
    async execute(args) {
      calls += 1;
      if (calls > maxCalls) return `explore_page budget exhausted (${maxCalls} calls). Write the test with what you know.`;
      const parsed = ExploreRequestSchema.safeParse(args);
      if (!parsed.success) return `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      try {
        const result = await explorer.explore(parsed.data);
        audit.explorations.push(result);
        return formatExploreResult(result);
      } catch (err) {
        return `Exploration failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export interface CandidateToolOptions {
  runner: PlaywrightTestRunner;
  candidatesDir: string;
  artifactsDir: string;
  testId: string;
  validation: ValidationOptions;
  maxCalls?: number;
}

export function summarizeRun(result: TestRunResult): string {
  const failures = result.failures
    .slice(0, 3)
    .map((f) => `- ${f.testTitle}: ${f.message}${f.location ? ` (line ${f.location.line})` : ''}`)
    .join('\n');
  return [
    `Status: ${result.status} (${result.passedCount} passed, ${result.failedCount} failed, ${result.durationMs}ms)`,
    failures ? `Failures:\n${failures}` : '',
    result.errorContext ? `Page snapshot at failure:\n${result.errorContext.slice(0, 6_000)}` : '',
    result.status === 'error' && !failures ? `Runner output:\n${result.rawOutputTail}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createCandidateRunnerTool(options: CandidateToolOptions, audit: ToolAudit): AgentTool {
  let calls = 0;
  const maxCalls = options.maxCalls ?? 4;
  return {
    name: 'run_candidate_test',
    description:
      'Validate and execute a candidate Playwright test file against the application. Returns validation errors or the ' +
      'Playwright result (with the page snapshot at failure). Use it to verify your test before submitting.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Complete TypeScript test file content' } },
      required: ['code'],
    },
    async execute(args) {
      calls += 1;
      if (calls > maxCalls) return `run_candidate_test budget exhausted (${maxCalls} runs). Submit your best version.`;
      const code = unwrapCodeFence(String(args.code ?? ''));
      const validation = validateTestCode(code, options.validation);
      if (!validation.valid) return `Rejected by static validation (not executed):\n- ${validation.errors.join('\n- ')}`;
      mkdirSync(options.candidatesDir, { recursive: true });
      const file = path.join(options.candidatesDir, `${options.testId}.agent-candidate-${Date.now()}.spec.ts`);
      writeFileSync(file, code);
      const result = await options.runner.run(file, path.join(options.artifactsDir, `candidate-${path.basename(file, '.spec.ts')}`));
      audit.candidateRuns.push({ file, status: result.status });
      return [summarizeRun(result), validation.warnings.length ? `Warnings: ${validation.warnings.join('; ')}` : '']
        .filter(Boolean)
        .join('\n');
    },
  };
}
