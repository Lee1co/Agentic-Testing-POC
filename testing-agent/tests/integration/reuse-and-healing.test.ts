import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../src/agents/agent-provider.js';
import { FIXTURE_TEST, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';
import { ScriptedProvider } from '../helpers/scripted-provider.js';
import { createWorkspace } from '../helpers/workspace.js';

const OBJECTIVE = 'Test that logging in greets the user by email';

const generation = () => ({
  title: 'login greets the user',
  code: FIXTURE_TEST,
  rationale: 'Fills the email, submits and asserts the greeting.',
  verifiedByCandidateRun: true,
});

/** Scripted "reasoning": reads the failure context it was given and replaces the stale button name. */
const repairFromContext = (request: AgentRequest<unknown>) => {
  const failing = request.sections.find((s) => s.title.startsWith('Failing test'))!.content;
  return {
    classification: 'locator-change',
    diagnosis: 'The submit button was renamed from "Log in" to "Sign in now"; behaviour is unchanged.',
    evidence: 'Page snapshot shows button "Sign in now"',
    code: failing.replace("name: 'Log in'", "name: 'Sign in now'"),
    changes: ["getByRole('button', { name: 'Log in' }) -> getByRole('button', { name: 'Sign in now' })"],
    verifiedByCandidateRun: true,
  };
};

describe('persistence, reuse-first execution and controlled UI change healing', () => {
  let app: FixtureApp;
  let ws: ReturnType<typeof createWorkspace>;
  const provider = new ScriptedProvider([
    generation,
    repairFromContext,
    () => ({ classification: 'application-regression', diagnosis: 'Greeting is no longer rendered after login.', evidence: 'status element empty' }),
  ]);

  beforeAll(async () => {
    app = await startFixtureApp('v1');
    ws = createWorkspace(app.url, { provider });
  });
  afterAll(async () => {
    await ws?.dispose();
    await app?.close();
  });

  it('first execution: generates, validates, executes and persists the test', async () => {
    const report = await ws.orchestrator.generate({ objective: OBJECTIVE });
    expect(report.status).toBe('passed');
    expect(report.mode).toBe('generate');
    expect(report.aiInvocations).toBe(1);
    expect(report.tokenUsage?.totalTokens).toBe(15);

    const test = ws.deps.store.listTests()[0]!;
    expect(test.version).toBe(1);
    expect(test.lastSuccessfulRunAt).toBeDefined();
    expect(test.locators).toContain("getByRole('button', { name: 'Log in' })");
    const file = readFileSync(path.join(ws.generated, test.file), 'utf8');
    expect(file).toContain(`testId: ${test.id}`);
    expect(ws.deps.store.listExecutions().map((e) => e.mode)).toEqual(['generate']);
    expect(ws.deps.store.listAgentSessions()).toHaveLength(1);
    expect(ws.deps.store.getApplication()?.verifiedLocators.length).toBeGreaterThan(0);
  });

  it('subsequent executions reuse the stored test without any AI call', async () => {
    const [byObjective] = await ws.orchestrator.run({ objective: OBJECTIVE });
    const viaGenerate = await ws.orchestrator.generate({ objective: OBJECTIVE });
    for (const report of [byObjective!, viaGenerate]) {
      expect(report.status).toBe('passed');
      expect(report.reusedExistingTest).toBe(true);
      expect(report.aiInvocations).toBe(0);
    }
    expect(provider.requests).toHaveLength(1);
    expect(ws.deps.store.listExecutions().map((e) => e.mode)).toEqual(['generate', 'reuse', 'reuse']);
  });

  it('a UI change breaks the test, healing repairs it, and the original is preserved', async () => {
    app.setVariant('v2');
    const [report] = await ws.orchestrator.run({ objective: OBJECTIVE });
    expect(report!.mode).toBe('heal');
    expect(report!.status).toBe('passed');
    expect(report!.healing).toMatchObject({ attempted: true, outcome: 'repaired', attempts: 1, classification: 'locator-change' });
    expect(report!.notes.join('\n')).toMatch(/Original failure before healing/);
    expect(provider.requests[1]?.kind).toBe('repair-test');
    expect(provider.requests[1]?.resumeSessionId).toBe('scripted-1');

    const test = ws.deps.store.listTests()[0]!;
    expect(test.version).toBe(2);
    expect(test.previousVersions[0]?.file).toMatch(/_history/);
    expect(readFileSync(path.join(ws.generated, test.file), 'utf8')).toContain("name: 'Sign in now'");
    expect(existsSync(path.join(ws.generated, test.previousVersions[0]!.file))).toBe(true);
    expect(ws.deps.store.listHealing().at(-1)?.outcome).toBe('repaired');

    const [again] = await ws.orchestrator.run({ testId: test.id });
    expect(again).toMatchObject({ status: 'passed', aiInvocations: 0, testVersion: 2 });
  });

  it('a real regression is reported and the test is left untouched', async () => {
    app.setVariant('v3');
    const before = readFileSync(path.join(ws.generated, ws.deps.store.listTests()[0]!.file), 'utf8');
    const [report] = await ws.orchestrator.run({ objective: OBJECTIVE });
    expect(report!.status).toBe('failed');
    expect(report!.healing.classification).toBe('application-regression');
    const test = ws.deps.store.listTests()[0]!;
    expect(test.status).toBe('needs-attention');
    expect(test.version).toBe(2);
    expect(readFileSync(path.join(ws.generated, test.file), 'utf8')).toBe(before);
    app.setVariant('v1');
  });
});
