import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z, type ZodType, type ZodTypeDef } from 'zod';
import {
  AgentSessionRecordSchema,
  ApplicationKnowledgeSchema,
  ExecutionRecordSchema,
  HealingRecordSchema,
  TestRecordSchema,
  TraceabilitySchema,
  type AgentSessionRecord,
  type ApplicationKnowledge,
  type ExecutionRecord,
  type HealingRecord,
  type PageObservation,
  type TestRecord,
  type TraceabilityRecord,
} from './schemas.js';

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i;
const MAX_HISTORY = 500;

/** Recursively replaces values stored under secret-looking keys. Knowledge must never contain credentials. */
export function scrubSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        SECRET_KEY.test(key) && typeof inner === 'string' ? '[redacted]' : scrubSecrets(inner),
      ]),
    ) as T;
  }
  return value;
}

/**
 * JSON-file knowledge store, one directory per application. Execution knowledge (history, healing,
 * sessions) and test artifacts metadata are kept in separate files; business knowledge is NOT stored here.
 */
export class KnowledgeStore {
  readonly appDir: string;

  constructor(
    rootDir: string,
    readonly appId: string,
  ) {
    this.appDir = path.join(rootDir, appId);
    mkdirSync(this.appDir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.appDir, name);
  }

  private read<T>(name: string, schema: ZodType<T, ZodTypeDef, unknown>, fallback: T): T {
    const file = this.file(name);
    if (!existsSync(file)) return fallback;
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  private write(name: string, data: unknown): void {
    const file = this.file(name);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(scrubSecrets(data), null, 2)}\n`);
    renameSync(tmp, file);
  }

  // --- application ---------------------------------------------------------------------------
  getApplication(): ApplicationKnowledge | undefined {
    return this.read('application.json', ApplicationKnowledgeSchema.optional(), undefined);
  }

  upsertApplication(init: { name: string; targetUrl: string }, mutate?: (app: ApplicationKnowledge) => void): ApplicationKnowledge {
    const app =
      this.getApplication() ??
      ApplicationKnowledgeSchema.parse({ appId: this.appId, name: init.name, targetUrl: init.targetUrl, firstSeenAt: new Date().toISOString() });
    app.targetUrl = init.targetUrl;
    mutate?.(app);
    this.write('application.json', app);
    return app;
  }

  recordPageObservations(observations: PageObservation[], objective: string, init: { name: string; targetUrl: string }): void {
    this.upsertApplication(init, (app) => {
      app.lastExploredAt = new Date().toISOString();
      if (!app.objectives.includes(objective)) app.objectives.push(objective);
      for (const observation of observations) {
        const existing = app.pages.findIndex((p) => p.path === observation.path);
        if (existing >= 0) app.pages[existing] = observation;
        else app.pages.push(observation);
      }
      app.pages = app.pages.slice(-50);
    });
  }

  recordVerifiedLocators(testId: string, locators: string[], init: { name: string; targetUrl: string }): void {
    const now = new Date().toISOString();
    this.upsertApplication(init, (app) => {
      for (const locator of locators) {
        const entry = app.verifiedLocators.find((l) => l.locator === locator);
        if (entry) {
          entry.lastVerifiedAt = now;
          if (!entry.testIds.includes(testId)) entry.testIds.push(testId);
        } else {
          app.verifiedLocators.push({ locator, testIds: [testId], lastVerifiedAt: now });
        }
      }
    });
  }

  // --- tests ---------------------------------------------------------------------------------
  listTests(): TestRecord[] {
    return this.read('tests.json', z.array(TestRecordSchema), []);
  }

  getTest(id: string): TestRecord | undefined {
    return this.listTests().find((t) => t.id === id);
  }

  saveTest(record: TestRecord): void {
    const parsed = TestRecordSchema.parse(record);
    const tests = this.listTests().filter((t) => t.id !== parsed.id);
    tests.push(parsed);
    this.write('tests.json', tests);
  }

  updateTest(id: string, mutate: (record: TestRecord) => void): TestRecord {
    const record = this.getTest(id);
    if (!record) throw new Error(`Unknown test ${id}`);
    mutate(record);
    record.updatedAt = new Date().toISOString();
    this.saveTest(record);
    return record;
  }

  // --- execution history ---------------------------------------------------------------------
  listExecutions(): ExecutionRecord[] {
    return this.read('executions.json', z.array(ExecutionRecordSchema), []);
  }

  appendExecution(record: ExecutionRecord): void {
    this.write('executions.json', [...this.listExecutions(), ExecutionRecordSchema.parse(record)].slice(-MAX_HISTORY));
  }

  listHealing(): HealingRecord[] {
    return this.read('healing.json', z.array(HealingRecordSchema), []);
  }

  appendHealing(record: HealingRecord): void {
    this.write('healing.json', [...this.listHealing(), HealingRecordSchema.parse(record)].slice(-MAX_HISTORY));
  }

  listAgentSessions(): AgentSessionRecord[] {
    return this.read('agent-sessions.json', z.array(AgentSessionRecordSchema), []);
  }

  appendAgentSession(record: AgentSessionRecord): void {
    this.write('agent-sessions.json', [...this.listAgentSessions(), AgentSessionRecordSchema.parse(record)].slice(-MAX_HISTORY));
  }

  // --- requirement traceability ----------------------------------------------------------------
  listTraceability(): TraceabilityRecord[] {
    return this.read('traceability.json', z.array(TraceabilitySchema), []);
  }

  upsertTraceability(record: TraceabilityRecord): void {
    const parsed = TraceabilitySchema.parse(record);
    const rows = this.listTraceability().filter((r) => !(r.requirementId === parsed.requirementId && r.testId === parsed.testId));
    rows.push(parsed);
    this.write('traceability.json', rows);
  }
}
