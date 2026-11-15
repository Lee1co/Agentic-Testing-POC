import type { TestRecord } from './schemas.js';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'for', 'in', 'on', 'with', 'that', 'this', 'is', 'are', 'be', 'it',
  'test', 'tests', 'testing', 'verify', 'check', 'ensure', 'flow', 'should', 'can', 'user', 'users',
]);

export function normalizeObjective(objective: string): string {
  return objective
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .join(' ');
}

export function objectiveSimilarity(a: string, b: string): number {
  const left = new Set(normalizeObjective(a).split(' ').filter(Boolean));
  const right = new Set(normalizeObjective(b).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  const intersection = [...left].filter((word) => right.has(word)).length;
  return intersection / (left.size + right.size - intersection);
}

export interface MatchQuery {
  objective?: string;
  requirementId?: string;
  testId?: string;
}

export interface MatchResult {
  test: TestRecord;
  reason: 'test-id' | 'requirement-id' | 'exact-objective' | 'similar-objective';
  score: number;
}

export const SIMILARITY_THRESHOLD = 0.75;

/**
 * Deterministic lookup of a reusable test. No AI is involved, which is what allows repeated
 * executions to skip generation entirely.
 */
export function findReusableTest(tests: TestRecord[], query: MatchQuery): MatchResult | undefined {
  if (query.testId) {
    const test = tests.find((t) => t.id === query.testId);
    return test ? { test, reason: 'test-id', score: 1 } : undefined;
  }
  const ranked = rankByPreference(tests);
  if (query.requirementId) {
    const test = ranked.find((t) => t.requirementIds.includes(query.requirementId!));
    return test ? { test, reason: 'requirement-id', score: 1 } : undefined;
  }
  if (!query.objective) return undefined;
  const normalized = normalizeObjective(query.objective);
  const exact = ranked.find((t) => t.normalizedObjective === normalized);
  if (exact) return { test: exact, reason: 'exact-objective', score: 1 };

  let best: MatchResult | undefined;
  for (const test of ranked) {
    const score = objectiveSimilarity(test.objective, query.objective);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { test, reason: 'similar-objective', score };
    }
  }
  return best;
}

/** Several stored tests can cover the same objective (e.g. after --force); prefer active, then most recently updated. */
function rankByPreference(tests: TestRecord[]): TestRecord[] {
  return [...tests].sort(
    (a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function slugify(text: string, maxLength = 48): string {
  let slug = '';
  for (const word of normalizeObjective(text).split(' ').filter(Boolean)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > maxLength) break;
    slug = next;
  }
  return slug.replace(/-+/g, '-') || 'test';
}
