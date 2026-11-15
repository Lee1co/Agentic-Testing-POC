import { describe, expect, it } from 'vitest';
import { findReusableTest, normalizeObjective, objectiveSimilarity, slugify } from '../../src/knowledge/test-matcher.js';
import { sampleTest } from '../helpers/records.js';

const tests = [
  sampleTest({ id: 'register-team', objective: 'Register a new user who creates a team and lands on the dashboard', normalizedObjective: normalizeObjective('Register a new user who creates a team and lands on the dashboard') }),
  sampleTest({ id: 'req-001', kind: 'business', requirementIds: ['REQ-001'], objective: 'Validate REQ-001', normalizedObjective: normalizeObjective('Validate REQ-001') }),
];

describe('test lookup and reuse', () => {
  it('matches exact objectives after normalisation', () => {
    const match = findReusableTest(tests, { objective: 'register a NEW user who creates a team, and lands on the dashboard!' });
    expect(match?.test.id).toBe('register-team');
    expect(match?.reason).toBe('exact-objective');
  });

  it('matches very similar objectives but not unrelated ones', () => {
    expect(findReusableTest(tests, { objective: 'Test: register new user that creates team and lands on dashboard' })?.reason).toMatch(/objective/);
    expect(findReusableTest(tests, { objective: 'Delete a comment on a discussion' })).toBeUndefined();
  });

  it('maps requirements to tests', () => {
    expect(findReusableTest(tests, { requirementId: 'REQ-001' })?.test.id).toBe('req-001');
    expect(findReusableTest(tests, { requirementId: 'REQ-999' })).toBeUndefined();
  });

  it('prefers an active test over a stale one for the same requirement', () => {
    const stale = sampleTest({ id: 'req-001-old', requirementIds: ['REQ-001'], status: 'business-defect', updatedAt: '2026-01-02T00:00:00.000Z' });
    const active = sampleTest({ id: 'req-001-new', requirementIds: ['REQ-001'], status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(findReusableTest([stale, active], { requirementId: 'REQ-001' })?.test.id).toBe('req-001-new');
  });

  it('looks up by id first', () => {
    expect(findReusableTest(tests, { testId: 'req-001', objective: 'anything' })?.reason).toBe('test-id');
  });

  it('computes similarity and slugs deterministically', () => {
    expect(objectiveSimilarity('login flow works', 'login flow works')).toBe(1);
    expect(objectiveSimilarity('', 'x')).toBe(0);
    expect(slugify('Test the Login flow!!')).toBe('login');
    expect(slugify('REQ-001 Only team administrators may start new discussions')).toBe('req-001-only-team-administrators-may-start-new');
  });
});
