import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeStore, scrubSecrets } from '../../src/knowledge/knowledge-store.js';
import { sampleTest } from '../helpers/records.js';

describe('knowledge persistence', () => {
  const root = () => mkdtempSync(path.join(tmpdir(), 'knowledge-'));

  it('round-trips tests, executions, healing and sessions in separate files per app', () => {
    const dir = root();
    const store = new KnowledgeStore(dir, 'demo');
    store.saveTest(sampleTest());
    store.appendExecution({ id: 'e1', testId: 'login-flow', at: new Date().toISOString(), mode: 'generate', status: 'passed', durationMs: 900, testVersion: 1, aiInvocations: 1 });
    store.appendHealing({ id: 'h1', testId: 'login-flow', at: new Date().toISOString(), attempt: 1, preClassification: 'possible-ui-change', outcome: 'repaired', fromVersion: 1, toVersion: 2 });
    store.appendAgentSession({ at: new Date().toISOString(), kind: 'generate-test', correlationId: 'x', provider: 'p', model: 'm', status: 'succeeded', durationMs: 5, attempts: 1, resumedSession: false, toolCalls: ['explore_page'] });

    const reopened = new KnowledgeStore(dir, 'demo');
    expect(reopened.getTest('login-flow')?.locators).toHaveLength(1);
    expect(reopened.listExecutions()).toHaveLength(1);
    expect(reopened.listHealing()[0]?.outcome).toBe('repaired');
    expect(reopened.listAgentSessions()[0]?.toolCalls).toEqual(['explore_page']);
    expect(new KnowledgeStore(dir, 'other-app').listTests()).toEqual([]);
  });

  it('updates a test in place and keeps the update timestamp fresh', () => {
    const store = new KnowledgeStore(root(), 'demo');
    store.saveTest(sampleTest({ updatedAt: '2000-01-01T00:00:00.000Z' }));
    const updated = store.updateTest('login-flow', (t) => {
      t.version = 2;
    });
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(store.listTests()).toHaveLength(1);
  });

  it('never persists secret-looking values', () => {
    const store = new KnowledgeStore(root(), 'demo');
    store.upsertApplication({ name: 'Demo', targetUrl: 'http://localhost:1' }, (app) => {
      (app as unknown as Record<string, unknown>).password = 'hunter2';
    });
    const raw = readFileSync(path.join(store.appDir, 'application.json'), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(scrubSecrets({ nested: [{ apiKey: 'abc', ok: 'yes' }], inputTokens: 5 })).toEqual({
      nested: [{ apiKey: '[redacted]', ok: 'yes' }],
      inputTokens: 5,
    });
  });

  it('records requirement-to-test traceability without duplicates', () => {
    const store = new KnowledgeStore(root(), 'demo');
    const row = { requirementId: 'REQ-001', acceptanceCriteriaIds: ['AC-1'], testId: 't1', testFile: 'demo/t1.spec.ts', lastResult: 'not-run' as const };
    store.upsertTraceability(row);
    store.upsertTraceability({ ...row, lastResult: 'satisfied', lastEvaluatedAt: new Date().toISOString() });
    expect(store.listTraceability()).toHaveLength(1);
    expect(store.listTraceability()[0]?.lastResult).toBe('satisfied');
  });
});
