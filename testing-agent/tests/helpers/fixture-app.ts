import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Minimal local web app used by integration tests. Variants model controlled changes:
 * - v1: baseline
 * - v2: UI change only (button text + test id renamed), behaviour unchanged
 * - v3: functional regression (login no longer greets the user)
 */
export type FixtureVariant = 'v1' | 'v2' | 'v3';

function page(variant: FixtureVariant): string {
  const button = variant === 'v2' ? '<button type="submit" data-testid="signin-submit">Sign in now</button>' : '<button type="submit" data-testid="login-submit">Log in</button>';
  const greet = variant === 'v3' ? "''" : "'Welcome, ' + document.getElementById('email').value";
  return `<!doctype html><html><head><title>Fixture Login</title></head><body>
<main><h1>Sign in</h1>
<form id="f"><label for="email">Email</label><input id="email" type="email" />${button}</form>
<p role="status" id="msg"></p></main>
<script>document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); document.getElementById('msg').textContent = ${greet}; });</script>
</body></html>`;
}

export interface FixtureApp {
  url: string;
  setVariant(variant: FixtureVariant): void;
  close(): Promise<void>;
}

export async function startFixtureApp(initial: FixtureVariant = 'v1'): Promise<FixtureApp> {
  let variant = initial;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(variant));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    setVariant: (next) => {
      variant = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const FIXTURE_TEST = `import { test, expect } from '../fixtures';

test('login greets the user', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill('qa@example.test');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('status')).toHaveText('Welcome, qa@example.test');
});
`;
