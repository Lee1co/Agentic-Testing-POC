import { z } from 'zod';

const isoDate = z.string();

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number().optional(),
});

export const AgentRefSchema = z.object({
  provider: z.string(),
  model: z.string(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
});

export const TestVersionSchema = z.object({
  version: z.number().int(),
  file: z.string(),
  reason: z.string(),
  archivedAt: isoDate,
});

export const TestRecordSchema = z.object({
  id: z.string(),
  appId: z.string(),
  objective: z.string(),
  normalizedObjective: z.string(),
  kind: z.enum(['exploratory', 'business']),
  /** Path relative to generated-tests/. */
  file: z.string(),
  title: z.string(),
  requirementIds: z.array(z.string()).default([]),
  acceptanceCriteriaIds: z.array(z.string()).default([]),
  version: z.number().int().min(1),
  status: z.enum(['active', 'needs-attention', 'business-defect']),
  createdAt: isoDate,
  updatedAt: isoDate,
  generatedBy: AgentRefSchema,
  locators: z.array(z.string()).default([]),
  assertionCount: z.number().int(),
  rationale: z.string().default(''),
  lastRun: z.object({ at: isoDate, status: z.string(), durationMs: z.number() }).optional(),
  lastSuccessfulRunAt: isoDate.optional(),
  previousVersions: z.array(TestVersionSchema).default([]),
});

export const ExecutionRecordSchema = z.object({
  id: z.string(),
  testId: z.string(),
  at: isoDate,
  mode: z.enum(['generate', 'reuse', 'heal', 'business-generate']),
  status: z.enum(['passed', 'failed', 'error']),
  durationMs: z.number(),
  testVersion: z.number().int(),
  aiInvocations: z.number().int(),
  failureSummary: z.string().optional(),
  reportFile: z.string().optional(),
});

export const HealingRecordSchema = z.object({
  id: z.string(),
  testId: z.string(),
  at: isoDate,
  attempt: z.number().int(),
  preClassification: z.string(),
  agentClassification: z.string().optional(),
  diagnosis: z.string().optional(),
  outcome: z.enum([
    'repaired',
    'rejected-by-guard',
    'candidate-failed',
    'not-healable',
    'agent-error',
  ]),
  details: z.string().optional(),
  candidateFile: z.string().optional(),
  fromVersion: z.number().int(),
  toVersion: z.number().int().optional(),
  agent: AgentRefSchema.optional(),
});

export const PageObservationSchema = z.object({
  path: z.string(),
  url: z.string(),
  title: z.string(),
  testIds: z.array(z.string()).default([]),
  observedAt: isoDate,
});

export const ApplicationKnowledgeSchema = z.object({
  appId: z.string(),
  name: z.string(),
  targetUrl: z.string(),
  firstSeenAt: isoDate,
  lastExploredAt: isoDate.optional(),
  objectives: z.array(z.string()).default([]),
  pages: z.array(PageObservationSchema).default([]),
  /** Locators that have been proven to work in a passing test. */
  verifiedLocators: z.array(z.object({ locator: z.string(), testIds: z.array(z.string()), lastVerifiedAt: isoDate })).default([]),
});

export const AgentSessionRecordSchema = z.object({
  at: isoDate,
  kind: z.string(),
  correlationId: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.string(),
  durationMs: z.number(),
  attempts: z.number().int(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  requestId: z.string().optional(),
  resumedSession: z.boolean(),
  toolCalls: z.array(z.string()).default([]),
  usage: UsageSchema.optional(),
  costChargedCents: z.number().optional(),
  costUnavailableReason: z.string().optional(),
  error: z.string().optional(),
});

export const TraceabilitySchema = z.object({
  requirementId: z.string(),
  acceptanceCriteriaIds: z.array(z.string()),
  testId: z.string(),
  testFile: z.string(),
  lastResult: z.enum(['satisfied', 'violated', 'inconclusive', 'not-run']),
  lastEvaluatedAt: isoDate.optional(),
});

export type TestRecord = z.infer<typeof TestRecordSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export type HealingRecord = z.infer<typeof HealingRecordSchema>;
export type ApplicationKnowledge = z.infer<typeof ApplicationKnowledgeSchema>;
export type AgentSessionRecord = z.infer<typeof AgentSessionRecordSchema>;
export type TraceabilityRecord = z.infer<typeof TraceabilitySchema>;
export type PageObservation = z.infer<typeof PageObservationSchema>;
