import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type TestRunStatus = 'passed' | 'failed' | 'error';

export interface TestFailure {
  testTitle: string;
  message: string;
  stack?: string;
  /** Source line of the failing statement inside the spec, when reported. */
  location?: { file: string; line: number; column: number };
}

export interface TestRunResult {
  status: TestRunStatus;
  durationMs: number;
  passedCount: number;
  failedCount: number;
  failures: TestFailure[];
  screenshots: string[];
  /** Playwright's page snapshot at failure time (error-context.md), if produced. */
  errorContext?: string;
  outputDir: string;
  rawOutputTail: string;
}

export interface TestRunnerOptions {
  frameworkRoot: string;
  configFile: string;
  baseUrl: string;
  allowedHosts: string[];
  headless: boolean;
  testTimeoutMs: number;
  /** Hard wall-clock limit for the Playwright process. */
  processTimeoutMs?: number;
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

interface PwReportResult {
  status: string;
  duration: number;
  errors?: Array<{ message?: string; stack?: string; location?: { file: string; line: number; column: number } }>;
  error?: { message?: string; stack?: string; location?: { file: string; line: number; column: number } };
  attachments?: Array<{ name: string; path?: string; contentType: string }>;
}
interface PwReportSpec {
  title: string;
  ok: boolean;
  tests: Array<{ results: PwReportResult[] }>;
}
interface PwReportSuite {
  title: string;
  specs?: PwReportSpec[];
  suites?: PwReportSuite[];
}
interface PwReport {
  suites?: PwReportSuite[];
  errors?: Array<{ message?: string }>;
  stats?: { duration?: number };
}

function collectSpecs(suites: PwReportSuite[] = []): PwReportSpec[] {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...collectSpecs(suite.suites)]);
}

/** Pure normalisation of a Playwright JSON report. Exported for unit tests. */
export function normalizeReport(report: PwReport, outputDir: string, rawOutput: string, wallMs: number): TestRunResult {
  const specs = collectSpecs(report.suites);
  const failures: TestFailure[] = [];
  const screenshots: string[] = [];
  let errorContext: string | undefined;
  let passedCount = 0;
  let failedCount = 0;

  for (const spec of specs) {
    const results = spec.tests.flatMap((t) => t.results);
    const last = results.at(-1);
    if (spec.ok && last?.status !== 'skipped') passedCount += 1;
    if (!spec.ok) failedCount += 1;
    for (const result of results) {
      for (const attachment of result.attachments ?? []) {
        if (!attachment.path) continue;
        if (attachment.contentType.startsWith('image/')) screenshots.push(attachment.path);
        if (attachment.name === 'error-context' && existsSync(attachment.path)) {
          errorContext = readFileSync(attachment.path, 'utf8').slice(0, 15_000);
        }
      }
      const errors = result.errors?.length ? result.errors : result.error ? [result.error] : [];
      for (const error of errors) {
        failures.push({
          testTitle: spec.title,
          message: stripAnsi(error.message ?? 'Unknown failure').slice(0, 4_000),
          stack: error.stack ? stripAnsi(error.stack).slice(0, 4_000) : undefined,
          location: error.location,
        });
      }
    }
  }
  for (const error of report.errors ?? []) {
    failures.push({ testTitle: '(global)', message: stripAnsi(error.message ?? 'Unknown error').slice(0, 4_000) });
  }

  const status: TestRunStatus =
    specs.length === 0 ? 'error' : failedCount > 0 ? 'failed' : (report.errors?.length ?? 0) > 0 ? 'error' : 'passed';
  return {
    status,
    durationMs: Math.round(report.stats?.duration ?? wallMs),
    passedCount,
    failedCount,
    failures,
    screenshots,
    errorContext,
    outputDir,
    rawOutputTail: stripAnsi(rawOutput).slice(-3_000),
  };
}

export class PlaywrightTestRunner {
  constructor(private readonly options: TestRunnerOptions) {}

  async run(specFile: string, outputDir: string): Promise<TestRunResult> {
    mkdirSync(outputDir, { recursive: true });
    const reportFile = path.join(outputDir, 'report.json');
    const cli = path.join(this.options.frameworkRoot, 'node_modules', '@playwright', 'test', 'cli.js');
    // Playwright treats file arguments as regular expressions; Windows backslashes would act as escapes.
    const relativeSpec = path.relative(path.dirname(this.options.configFile), specFile).split(path.sep).join('/');
    const args = [cli, 'test', relativeSpec, '--config', this.options.configFile, '--reporter=json'];
    const env = {
      ...process.env,
      TARGET_APP_URL: this.options.baseUrl,
      ALLOWED_HOSTS: this.options.allowedHosts.join(','),
      HEADLESS: String(this.options.headless),
      TEST_TIMEOUT_MS: String(this.options.testTimeoutMs),
      PW_OUTPUT_DIR: path.join(outputDir, 'test-results'),
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
      CURSOR_API_KEY: '',
      FORCE_COLOR: '0',
    };

    const started = Date.now();
    const output = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, args, { cwd: this.options.frameworkRoot, env, windowsHide: true });
      let buffer = '';
      const append = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-200_000);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const killer = setTimeout(() => {
        buffer += '\n[runner] process timeout exceeded, killing Playwright';
        child.kill();
      }, this.options.processTimeoutMs ?? this.options.testTimeoutMs * 3);
      child.on('close', () => {
        clearTimeout(killer);
        resolve(buffer);
      });
      child.on('error', (err) => {
        clearTimeout(killer);
        resolve(`${buffer}\n[runner] ${err.message}`);
      });
    });
    const wallMs = Date.now() - started;

    if (!existsSync(reportFile)) {
      return {
        status: 'error',
        durationMs: wallMs,
        passedCount: 0,
        failedCount: 0,
        failures: [{ testTitle: '(runner)', message: 'Playwright produced no JSON report' }],
        screenshots: [],
        outputDir,
        rawOutputTail: stripAnsi(output).slice(-3_000),
      };
    }
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as PwReport;
    return normalizeReport(report, outputDir, output, wallMs);
  }
}
