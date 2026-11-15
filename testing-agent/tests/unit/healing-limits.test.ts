import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlaywrightTestRunner, TestRunResult } from '../../src/browser/test-runner.js';
import { HealingEngine } from '../../src/healing/healing-engine.js';
import type { HealingRecord } from '../../src/knowledge/schemas.js';
import { sampleTest } from '../helpers/records.js';
import { ScriptedProvider } from '../helpers/scripted-provider.js';

const ORIGINAL = `import { test, expect } from '../fixtures';
test('login', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('status')).toHaveText('Welcome');
  await expect(page.getByRole('heading')).toBeVisible();
});
`;

const failure: TestRunResult = {
  status: 'failed',
  durationMs: 10,
  passedCount: 0,
  failedCount: 1,
  failures: [{ testTitle: 'login', message: "locator.click: Timeout 10000ms exceeded. waiting for getByRole('button', { name: 'Log in' })" }],
  screenshots: [],
  outputDir: '',
  rawOutputTail: '',
};

function setup(runStatus: TestRunResult['status'], scripts: ConstructorParameters<typeof ScriptedProvider>[0], maxAttempts = 2) {
  const dir = mkdtempSync(path.join(tmpdir(), 'heal-'));
  mkdirSync(path.join(dir, 'demo'), { recursive: true });
  writeFileSync(path.join(dir, 'demo', 'login-flow.spec.ts'), ORIGINAL);
  const runner = { run: vi.fn(async () => ({ ...failure, status: runStatus, failures: runStatus === 'passed' ? [] : failure.failures })) };
  const records: HealingRecord[] = [];
  const provider = new ScriptedProvider(scripts);
  const engine = new HealingEngine({
    provider,
    runner: runner as unknown as PlaywrightTestRunner,
    generatedTestsDir: dir,
    artifactsDir: path.join(dir, 'artifacts'),
    allowedHosts: ['localhost'],
    maxAttempts,
    buildContext: () => ({ sections: [], tools: [] }),
    onAttempt: (record) => records.push(record),
    log: () => undefined,
  });
  return { dir, runner, records, provider, engine };
}

const locatorFix = () => ({
  classification: 'locator-change',
  diagnosis: 'Button text changed from Log in to Sign in',
  evidence: 'snapshot shows button "Sign in"',
  code: ORIGINAL.replace("name: 'Log in'", "name: 'Sign in'"),
  changes: ['Log in -> Sign in'],
});

describe('healing retry limits and safety', () => {
  it('stops after the configured maximum number of attempts', async () => {
    const { engine, runner, records, provider } = setup('failed', [locatorFix, locatorFix, locatorFix], 2);
    const report = await engine.heal(sampleTest(), failure);
    expect(report.outcome).toBe('exhausted');
    expect(report.attempts).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(records.map((r) => r.outcome)).toEqual(['candidate-failed', 'candidate-failed']);
  });

  it('persists the repair only after the candidate passes and archives the original', async () => {
    const { engine, dir } = setup('passed', [locatorFix]);
    const report = await engine.heal(sampleTest(), failure);
    expect(report.outcome).toBe('repaired');
    expect(report.newVersion).toBe(2);
    expect(readFileSync(path.join(dir, 'demo', 'login-flow.spec.ts'), 'utf8')).toContain("name: 'Sign in'");
    expect(readFileSync(path.join(dir, '_history', 'demo.login-flow.v1.spec.ts'), 'utf8')).toBe(ORIGINAL);
  });

  it('rejects repairs that remove assertions without executing them', async () => {
    const weakened = () => ({ ...locatorFix(), code: ORIGINAL.replace(/\s+await expect\(page.getByRole\('status'\)\)[^\n]+/, '') });
    const { engine, runner, dir } = setup('passed', [weakened], 1);
    const report = await engine.heal(sampleTest(), failure);
    expect(report.outcome).toBe('exhausted');
    expect(report.attempts[0]?.outcome).toBe('rejected-by-guard');
    expect(runner.run).not.toHaveBeenCalled();
    expect(readFileSync(path.join(dir, 'demo', 'login-flow.spec.ts'), 'utf8')).toBe(ORIGINAL);
  });

  it('does not modify the test when the agent reports a regression', async () => {
    const regression = () => ({ classification: 'application-regression', diagnosis: 'Login no longer shows welcome message', evidence: 'status is empty' });
    const { engine, runner, provider } = setup('passed', [regression, locatorFix], 2);
    const report = await engine.heal(sampleTest(), failure);
    expect(report.outcome).toBe('not-healable');
    expect(report.finalClassification).toBe('application-regression');
    expect(provider.requests).toHaveLength(1);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('skips AI entirely for environment failures and when healing is disabled', async () => {
    const down = { ...failure, failures: [{ testTitle: 't', message: 'net::ERR_CONNECTION_REFUSED' }] };
    const a = setup('passed', [locatorFix]);
    expect((await a.engine.heal(sampleTest(), down)).outcome).toBe('not-healable');
    expect(a.provider.requests).toHaveLength(0);
    const b = setup('passed', [locatorFix], 0);
    expect((await b.engine.heal(sampleTest(), failure)).outcome).toBe('skipped');
    expect(b.provider.requests).toHaveLength(0);
  });

  it('resumes the original generation session on the first attempt only', async () => {
    const { engine, provider } = setup('failed', [locatorFix, locatorFix], 2);
    await engine.heal(sampleTest({ generatedBy: { provider: 'p', model: 'm', sessionId: 'agent-123' } }), failure);
    expect(provider.requests.map((r) => r.resumeSessionId)).toEqual(['agent-123', undefined]);
  });
});
