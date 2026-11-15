import { test as base, expect } from '@playwright/test';

/**
 * Harness imported by every generated test. It blocks any request to a host outside ALLOWED_HOSTS,
 * so generated or repaired code cannot reach non-approved environments.
 */
const allowedHosts = (process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1')
  .split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

function isAllowed(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return allowedHosts.includes(url.hostname.toLowerCase());
}

export const test = base.extend<{ networkGuard: void }>({
  networkGuard: [
    async ({ context }, use) => {
      await context.route(
        (url) => !isAllowed(url),
        (route) => route.abort('blockedbyclient'),
      );
      await use();
    },
    { auto: true },
  ],
});

export { expect };
