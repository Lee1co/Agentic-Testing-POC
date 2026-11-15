import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRequest } from '../../src/agents/agent-provider.js';
import { LocalBusinessKnowledgeProvider } from '../../src/business-knowledge/local-business-knowledge-provider.js';
import { renderPrompt } from '../../src/agents/prompt-renderer.js';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';
import { ScriptedProvider } from '../helpers/scripted-provider.js';
import { createWorkspace } from '../helpers/workspace.js';

const REQUIREMENTS = {
  appId: 'fixture-app',
  requirements: [
    {
      id: 'REQ-101',
      appId: 'fixture-app',
      title: 'Signed-in users are greeted by their email address',
      description: 'After signing in, the user must see a greeting that includes their email.',
      acceptanceCriteria: [{ id: 'AC-1', given: 'a visitor on the sign-in page', when: 'they sign in with their email', then: "a status message 'Welcome, <email>' is shown" }],
      source: { document: 'Fixture BRS', section: '1.1' },
    },
  ],
};

const BUSINESS_TEST = `import { test, expect } from '../fixtures';

test('REQ-101 greeting', async ({ page }) => {
  await page.goto('/');
  await test.step('AC-1: greeting includes the email', async () => {
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.getByLabel('Email').fill('owner@example.test');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('status')).toHaveText('Welcome, owner@example.test');
  });
});
`;

describe('business-aware test generation and requirement traceability', () => {
  let app: FixtureApp;
  let ws: ReturnType<typeof createWorkspace>;
  let seenPrompt = '';
  const provider = new ScriptedProvider([
    (request: AgentRequest<unknown>) => {
      seenPrompt = renderPrompt(request);
      return {
        title: 'REQ-101 greeting',
        code: BUSINESS_TEST,
        rationale: 'Asserts AC-1 exactly as written.',
        coveredAcceptanceCriteria: ['AC-1'],
        verifiedByCandidateRun: true,
        requirementAssessment: { behaviourMatchesRequirement: 'yes', explanation: 'Greeting observed.' },
      };
    },
    () => ({ classification: 'business-defect', diagnosis: 'No greeting is displayed after sign-in, contradicting REQ-101 AC-1.', evidence: 'status is empty' }),
  ]);

  beforeAll(async () => {
    app = await startFixtureApp('v1');
    const bizRoot = mkdtempSync(path.join(tmpdir(), 'biz-'));
    mkdirSync(path.join(bizRoot, 'fixture-app'));
    writeFileSync(path.join(bizRoot, 'fixture-app', 'requirements.json'), JSON.stringify(REQUIREMENTS));
    ws = createWorkspace(app.url, { provider, business: new LocalBusinessKnowledgeProvider(bizRoot) });
  });
  afterAll(async () => {
    await ws?.dispose();
    await app?.close();
  });

  it('injects the requirement as untrusted context and records traceability', async () => {
    const report = await ws.orchestrator.generate({ requirementId: 'REQ-101' });
    expect(seenPrompt).toMatch(/<untrusted-data source="business-knowledge-provider">[\s\S]*REQ-101[\s\S]*AC-1: GIVEN/);
    expect(seenPrompt).toMatch(/Do NOT weaken/);
    expect(report.mode).toBe('business-generate');
    expect(report.status).toBe('passed');
    expect(report.requirement).toMatchObject({ requirementId: 'REQ-101', result: 'satisfied', acceptanceCriteriaIds: ['AC-1'] });

    const test = ws.deps.store.listTests()[0]!;
    expect(test).toMatchObject({ kind: 'business', requirementIds: ['REQ-101'], acceptanceCriteriaIds: ['AC-1'] });
    expect(readFileSync(path.join(ws.generated, test.file), 'utf8')).toContain('requirements: REQ-101');
    expect(ws.deps.store.listTraceability()).toEqual([
      expect.objectContaining({ requirementId: 'REQ-101', testId: test.id, lastResult: 'satisfied' }),
    ]);
  });

  it('reports a business defect instead of rewriting the test when behaviour diverges', async () => {
    app.setVariant('v3');
    const [report] = await ws.orchestrator.run({ requirementId: 'REQ-101' });
    expect(report!.status).toBe('business-defect');
    expect(report!.requirement?.result).toBe('violated');
    expect(ws.deps.store.listTests()[0]).toMatchObject({ status: 'business-defect', version: 1 });
    expect(ws.deps.store.listTraceability()[0]?.lastResult).toBe('violated');
    expect(provider.requests).toHaveLength(2);
    app.setVariant('v1');
  });

  it('rejects unknown requirement ids', async () => {
    await expect(ws.orchestrator.generate({ requirementId: 'REQ-999' })).rejects.toThrow(/REQ-999 was not found/);
  });
});
