import { describe, expect, it } from 'vitest';
import {
  assertionSignature,
  checkAssertionsPreserved,
  composeTestFile,
  extractLocators,
  failingAcceptanceCriteria,
  stripHeader,
  unwrapCodeFence,
  validateTestCode,
} from '../../src/generator/test-code.js';

const GOOD = `import { test, expect } from '../fixtures';

test('member cannot create discussions', async ({ page }) => {
  await page.goto('/app/discussions');
  await test.step('AC-1: no create action', async () => {
    await expect(page.getByRole('heading', { name: 'Discussions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Discussion' })).not.toBeVisible();
  });
});
`;

const opts = { allowedHosts: ['localhost'] };

describe('generated test validation', () => {
  it('accepts a well-formed test', () => {
    const result = validateTestCode(GOOD, { ...opts, requiredMarkers: ['AC-1'] });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.assertionCount).toBe(2);
  });

  it('rejects sleeps, foreign imports, external hosts and missing assertions', () => {
    const bad = `import { test } from '@playwright/test';
import fs from 'node:fs';
test('x', async ({ page }) => {
  await page.goto('https://evil.example.com');
  await page.waitForTimeout(1000);
});`;
    const result = validateTestCode(bad, opts);
    expect(result.valid).toBe(false);
    const all = result.errors.join('\n');
    expect(all).toMatch(/only "import \{ test, expect \} from '..\/fixtures'"/);
    expect(all).toMatch(/waitForTimeout/);
    expect(all).toMatch(/evil\.example\.com/);
    expect(all).toMatch(/at least 2 expect/);
  });

  it('reports missing traceability markers and syntax errors', () => {
    const result = validateTestCode(GOOD.replace('AC-1', 'step').replace('});\n', '}\n'), { ...opts, requiredMarkers: ['AC-1'] });
    expect(result.errors.join('\n')).toMatch(/AC-1/);
    expect(result.errors.join('\n')).toMatch(/TypeScript syntax error/);
  });

  it('round-trips the metadata header', () => {
    const file = composeTestFile(
      { testId: 't', appId: 'a', objective: 'o */ x', version: 2, requirementIds: ['REQ-001'], acceptanceCriteriaIds: ['AC-1'], generatedBy: 'p/m' },
      GOOD,
    );
    expect(file).toContain('version: 2');
    expect(file).not.toContain('o */ x');
    expect(stripHeader(file).trim()).toBe(GOOD.trim());
    expect(validateTestCode(file, opts).valid).toBe(true);
  });

  it('unwraps markdown fences', () => {
    expect(unwrapCodeFence('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('extracts locators', () => {
    expect(extractLocators(GOOD)).toEqual([
      "getByRole('heading', { name: 'Discussions' })",
      "getByRole('button', { name: 'Create Discussion' })",
    ]);
  });
});

describe('assertion preservation guard (healing must not weaken tests)', () => {
  it('accepts a pure locator change', () => {
    const repaired = GOOD.replace("name: 'Discussions'", "name: 'Team Discussions'");
    expect(checkAssertionsPreserved(GOOD, repaired, ['AC-1'])).toEqual({ ok: true, violations: [] });
  });

  it('rejects removed or loosened assertions and dropped markers', () => {
    const weakened = GOOD.replace('.not.toBeVisible()', '.toBeAttached()').replace('AC-1', 'step');
    const result = checkAssertionsPreserved(GOOD, weakened, ['AC-1']);
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toMatch(/not\.toBeVisible was removed/);
    expect(result.violations.join('\n')).toMatch(/marker AC-1/);
  });

  it('rejects dropping expect calls', () => {
    const fewer = GOOD.replace(/\s+await expect\(page\.getByRole\('heading'[^\n]+/, '');
    expect(checkAssertionsPreserved(GOOD, fewer).ok).toBe(false);
  });

  it('computes matcher signatures', () => {
    expect(assertionSignature(GOOD)).toEqual(['not.toBeVisible', 'toBeVisible']);
  });
});

describe('failing acceptance-criteria attribution', () => {
  const code = `import { test, expect } from '../fixtures';

test('req', async ({ page }) => {
  await test.step('Setup: member joins the team', async () => {
    await expect(page.getByText('USER')).toBeVisible();
  });
  await test.step('AC-1: member cannot create', async () => {
    await expect(page.getByRole('button', { name: 'Create' })).not.toBeVisible();
  });
});
`;

  it('attributes a failure inside an AC step to that criterion', () => {
    expect(failingAcceptanceCriteria(code, [8])).toEqual(['AC-1']);
  });

  it('attributes nothing to a failure in a setup step', () => {
    expect(failingAcceptanceCriteria(code, [5])).toEqual([]);
    expect(failingAcceptanceCriteria(code, [])).toEqual([]);
  });
});
