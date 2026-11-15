import type { TestRecord } from '../../src/knowledge/schemas.js';

export function sampleTest(overrides: Partial<TestRecord> = {}): TestRecord {
  const now = new Date().toISOString();
  return {
    id: 'login-flow',
    appId: 'demo',
    objective: 'Test the login flow',
    normalizedObjective: 'login',
    kind: 'exploratory',
    file: 'demo/login-flow.spec.ts',
    title: 'login works',
    requirementIds: [],
    acceptanceCriteriaIds: [],
    version: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    generatedBy: { provider: 'scripted', model: 'm', sessionId: 's-1' },
    locators: ["getByRole('button', { name: 'Log in' })"],
    assertionCount: 2,
    rationale: 'because',
    previousVersions: [],
    ...overrides,
  };
}
