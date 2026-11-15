import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { isAllowedUrl, resolveAppUrl } from './url-guard.js';

/**
 * Deterministic, stateless browser exploration. Each call opens a fresh context, replays the given steps
 * and returns an accessibility snapshot. This is the agent's only way to observe the application.
 */

export const LocatorTargetSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    testId: z.string().optional(),
    text: z.string().optional(),
    placeholder: z.string().optional(),
    css: z.string().optional(),
    exact: z.boolean().optional(),
  })
  .refine((t) => Boolean(t.role || t.label || t.testId || t.text || t.placeholder || t.css), {
    message: 'target needs one of role, label, testId, text, placeholder, css',
  });

export const ExploreStepSchema = z.object({
  action: z.enum(['goto', 'click', 'fill', 'select', 'check', 'press', 'waitForText']),
  target: LocatorTargetSchema.optional(),
  /** goto: path; fill/select: value; press: key; waitForText: text. */
  value: z.string().optional(),
});

export const ExploreRequestSchema = z.object({
  path: z.string().default('/'),
  steps: z.array(ExploreStepSchema).max(30).default([]),
});

export type LocatorTarget = z.infer<typeof LocatorTargetSchema>;
export type ExploreStep = z.infer<typeof ExploreStepSchema>;
export type ExploreRequest = z.infer<typeof ExploreRequestSchema>;

export interface StepOutcome {
  index: number;
  action: string;
  ok: boolean;
  error?: string;
}

export interface ExploreResult {
  url: string;
  title: string;
  steps: StepOutcome[];
  ariaSnapshot: string;
  testIds: string[];
  consoleErrors: string[];
  blockedRequests: string[];
  screenshotPath?: string;
}

export interface PageExplorerOptions {
  baseUrl: string;
  allowedHosts: string[];
  headless: boolean;
  artifactsDir: string;
  actionTimeoutMs?: number;
}

const MAX_SNAPSHOT_CHARS = 14_000;

function locate(page: Page, target: LocatorTarget): Locator {
  const exact = target.exact ?? false;
  if (target.testId) return page.getByTestId(target.testId);
  if (target.role) {
    return page.getByRole(target.role as Parameters<Page['getByRole']>[0], target.name ? { name: target.name, exact } : {});
  }
  if (target.label) return page.getByLabel(target.label, { exact });
  if (target.placeholder) return page.getByPlaceholder(target.placeholder, { exact });
  if (target.text) return page.getByText(target.text, { exact });
  return page.locator(target.css!);
}

/**
 * networkidle does not cover responses served (and artificially delayed) by a service worker such as MSW,
 * so the snapshot is re-read until it stops changing, bounded by STABILITY_MAX_MS.
 */
const STABILITY_POLL_MS = 500;
const STABILITY_WINDOW_MS = 1_500;
const STABILITY_MAX_MS = 6_000;

async function stableAriaSnapshot(page: Page): Promise<string> {
  const read = () => page.locator('body').ariaSnapshot().catch((err: Error) => `(snapshot failed: ${err.message})`);
  const deadline = Date.now() + STABILITY_MAX_MS;
  let previous = await read();
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, STABILITY_POLL_MS));
    const current = await read();
    if (current !== previous) {
      previous = current;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= STABILITY_WINDOW_MS) {
      break;
    }
  }
  return previous;
}

export class PageExplorer {
  private browser?: Browser;
  private counter = 0;

  constructor(private readonly options: PageExplorerOptions) {
    mkdirSync(options.artifactsDir, { recursive: true });
  }

  async explore(input: ExploreRequest): Promise<ExploreResult> {
    const request = ExploreRequestSchema.parse(input);
    this.browser ??= await chromium.launch({ headless: this.options.headless });
    const context = await this.browser.newContext();
    const blockedRequests: string[] = [];
    await context.route(
      (url) => !isAllowedUrl(url, this.options.allowedHosts),
      async (route) => {
        blockedRequests.push(route.request().url());
        await route.abort('blockedbyclient');
      },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(this.options.actionTimeoutMs ?? 8_000);
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
    });

    const steps: StepOutcome[] = [];
    try {
      await page.goto(resolveAppUrl(this.options.baseUrl, request.path, this.options.allowedHosts));
      await page.waitForLoadState('networkidle').catch(() => undefined);

      for (const [index, step] of request.steps.entries()) {
        try {
          await this.runStep(page, step);
          steps.push({ index, action: step.action, ok: true });
        } catch (err) {
          steps.push({ index, action: step.action, ok: false, error: (err instanceof Error ? err.message : String(err)).split('\n')[0] });
          break;
        }
      }
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
      const ariaSnapshot = await stableAriaSnapshot(page);

      const screenshotPath = path.join(this.options.artifactsDir, `explore-${Date.now()}-${++this.counter}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      const testIds = await page
        .locator('[data-testid]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? '').filter(Boolean))
        .catch(() => [] as string[]);

      return {
        url: page.url(),
        title: await page.title(),
        steps,
        ariaSnapshot: ariaSnapshot.slice(0, MAX_SNAPSHOT_CHARS),
        testIds: [...new Set(testIds)].slice(0, 100),
        consoleErrors: consoleErrors.slice(0, 10),
        blockedRequests: [...new Set(blockedRequests)].slice(0, 10),
        screenshotPath,
      };
    } finally {
      await context.close();
    }
  }

  private async runStep(page: Page, step: ExploreStep): Promise<void> {
    switch (step.action) {
      case 'goto':
        await page.goto(resolveAppUrl(this.options.baseUrl, step.value ?? '/', this.options.allowedHosts));
        await page.waitForLoadState('networkidle').catch(() => undefined);
        return;
      case 'waitForText':
        await page.getByText(step.value ?? '').first().waitFor({ state: 'visible' });
        return;
    }
    if (!step.target) throw new Error(`${step.action} requires a target`);
    const locator = locate(page, step.target);
    switch (step.action) {
      case 'click':
        await locator.click();
        break;
      case 'fill':
        await locator.fill(step.value ?? '');
        break;
      case 'select':
        await locator.selectOption(step.value ?? '');
        break;
      case 'check':
        await locator.check();
        break;
      case 'press':
        await locator.press(step.value ?? 'Enter');
        break;
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}

export function formatExploreResult(result: ExploreResult): string {
  const stepLines = result.steps.map((s) => `  ${s.index}. ${s.action}: ${s.ok ? 'ok' : `FAILED - ${s.error}`}`).join('\n');
  return [
    `URL: ${result.url}`,
    `Title: ${result.title}`,
    `Steps:\n${stepLines || '  (none)'}`,
    `data-testid values: ${result.testIds.join(', ') || '(none)'}`,
    result.consoleErrors.length ? `Console errors: ${result.consoleErrors.join(' | ')}` : '',
    result.blockedRequests.length ? `Blocked non-approved requests: ${result.blockedRequests.join(', ')}` : '',
    `Accessibility snapshot:\n${result.ariaSnapshot}`,
  ]
    .filter(Boolean)
    .join('\n');
}
