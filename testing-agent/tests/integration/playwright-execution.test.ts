import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyFailure } from '../../src/healing/failure-classifier.js';
import { FIXTURE_TEST, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.js';
import { createWorkspace } from '../helpers/workspace.js';

describe('Playwright execution (real browser)', () => {
  let app: FixtureApp;
  let ws: ReturnType<typeof createWorkspace>;

  beforeAll(async () => {
    app = await startFixtureApp('v1');
    ws = createWorkspace(app.url);
    mkdirSync(path.join(ws.generated, 'fixture-app'), { recursive: true });
  });
  afterAll(async () => {
    await ws?.dispose();
    await app?.close();
  });

  const write = (name: string, code: string) => {
    const file = path.join(ws.generated, 'fixture-app', name);
    writeFileSync(file, code);
    return file;
  };

  it('executes a passing spec and reports measured duration', async () => {
    const result = await ws.deps.runner.run(write('pass.spec.ts', FIXTURE_TEST), path.join(ws.root, 'out-pass'));
    expect(result.rawOutputTail).toBeDefined();
    expect(result.status).toBe('passed');
    expect(result.passedCount).toBe(1);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('reports a functional regression as an assertion mismatch with failure location', async () => {
    app.setVariant('v3');
    const result = await ws.deps.runner.run(write('regress.spec.ts', FIXTURE_TEST), path.join(ws.root, 'out-regress'));
    app.setVariant('v1');
    expect(result.status).toBe('failed');
    expect(result.failures[0]?.message).toMatch(/toHaveText/);
    expect(result.failures[0]?.location?.line).toBeGreaterThan(0);
    expect(classifyFailure(result).category).toBe('assertion-mismatch');
  });

  it('blocks requests to non-approved hosts at the harness level', async () => {
    const code = `import { test, expect } from '../fixtures';
test('escape attempt', async ({ page }) => {
  await page.goto('/');
  const outcome = await page.evaluate(() => fetch('http://example.org/').then(() => 'reached', () => 'blocked'));
  expect(outcome).toBe('blocked');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
`;
    const result = await ws.deps.runner.run(write('guard.spec.ts', code), path.join(ws.root, 'out-guard'));
    expect(result.status).toBe('passed');
  });

  it('explores pages and returns an accessibility snapshot', async () => {
    const result = await ws.deps.explorer.explore({
      path: '/',
      steps: [
        { action: 'fill', target: { label: 'Email' }, value: 'a@b.test' },
        { action: 'click', target: { role: 'button', name: 'Log in' } },
      ],
    });
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.ariaSnapshot).toContain('heading "Sign in"');
    expect(result.ariaSnapshot).toContain('Welcome, a@b.test');
    expect(result.testIds).toContain('login-submit');
    await expect(ws.deps.explorer.explore({ path: 'http://example.org/', steps: [] })).rejects.toThrow(/ALLOWED_HOSTS/);
  });
});
