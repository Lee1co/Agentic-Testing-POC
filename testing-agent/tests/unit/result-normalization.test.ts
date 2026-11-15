import { describe, expect, it } from 'vitest';
import { normalizeReport, stripAnsi } from '../../src/browser/test-runner.js';
import { classifyFailure } from '../../src/healing/failure-classifier.js';

const failingReport = {
  stats: { duration: 1234.5 },
  suites: [
    {
      title: 'demo/login.spec.ts',
      specs: [],
      suites: [
        {
          title: 'nested',
          specs: [
            {
              title: 'login works',
              ok: false,
              tests: [
                {
                  results: [
                    {
                      status: 'failed',
                      duration: 1000,
                      errors: [
                        {
                          message: "\u001b[31mTimeoutError: locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Log in' })\u001b[39m",
                          location: { file: 'login.spec.ts', line: 7, column: 3 },
                        },
                      ],
                      attachments: [{ name: 'screenshot', path: '/tmp/s.png', contentType: 'image/png' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe('execution result normalisation', () => {
  it('normalises a failing Playwright JSON report', () => {
    const result = normalizeReport(failingReport, '/out', 'raw', 999);
    expect(result.status).toBe('failed');
    expect(result.failedCount).toBe(1);
    expect(result.passedCount).toBe(0);
    expect(result.durationMs).toBe(1235);
    expect(result.screenshots).toEqual(['/tmp/s.png']);
    expect(result.failures[0]?.message).not.toContain('\u001b');
    expect(result.failures[0]?.location?.line).toBe(7);
  });

  it('treats an empty report as an execution error, never a pass', () => {
    expect(normalizeReport({ suites: [] }, '/out', '', 5).status).toBe('error');
  });

  it('normalises a passing report', () => {
    const passing = { suites: [{ title: 'f', specs: [{ title: 't', ok: true, tests: [{ results: [{ status: 'passed', duration: 10 }] }] }] }] };
    const result = normalizeReport(passing, '/out', '', 50);
    expect(result).toMatchObject({ status: 'passed', passedCount: 1, failedCount: 0, durationMs: 50 });
  });

  it('strips ANSI codes', () => {
    expect(stripAnsi('\u001b[2mdim\u001b[22m')).toBe('dim');
  });
});

describe('deterministic failure pre-classification', () => {
  const base = normalizeReport(failingReport, '/out', '', 1);

  it('flags missing elements as a possible UI change', () => {
    expect(classifyFailure(base).category).toBe('possible-ui-change');
  });

  it('flags value mismatches on found elements as assertion mismatches', () => {
    const mismatch = {
      ...base,
      failures: [
        {
          testTitle: 't',
          message:
            "expect(locator).toHaveText(expected) failed\nExpected: \"Welcome\"\nReceived: \"\"\nCall log:\n  - waiting for getByRole('status')\n    14 × locator resolved to <p id=\"msg\" role=\"status\"></p>\n       - unexpected value \"\"",
        },
      ],
    };
    expect(classifyFailure(mismatch).category).toBe('assertion-mismatch');
  });

  it('does not investigate environment failures', () => {
    const down = { ...base, failures: [{ testTitle: 't', message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/' }] };
    expect(classifyFailure(down)).toMatchObject({ category: 'environment', worthInvestigating: false });
  });
});
