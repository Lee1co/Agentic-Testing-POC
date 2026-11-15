import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const FRAMEWORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const ConfigSchema = z
  .object({
    CURSOR_API_KEY: z.string().trim().optional(),
    AGENT_PROVIDER: z.enum(['cursor', 'external']).default('cursor'),
    AGENT_MODEL: z.string().trim().min(1).default('composer-2.5'),
    AGENT_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
    AGENT_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
    MAX_AGENT_INVOCATIONS: z.coerce.number().int().min(1).max(20).default(4),
    APP_ID: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'APP_ID must be kebab-case')
      .default('bulletproof-react'),
    TARGET_APP_URL: z.string().url().default('http://localhost:3000'),
    ALLOWED_HOSTS: csv.default('localhost,127.0.0.1'),
    MAX_HEALING_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
    TEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(60_000),
    HEADLESS: booleanString.default('true'),
  })
  .superRefine((cfg, ctx) => {
    const host = new URL(cfg.TARGET_APP_URL).hostname.toLowerCase();
    if (!cfg.ALLOWED_HOSTS.includes(host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TARGET_APP_URL'],
        message: `Host "${host}" is not in ALLOWED_HOSTS; refusing to target a non-approved environment`,
      });
    }
  });

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface FrameworkConfig {
  provider: {
    name: RawConfig['AGENT_PROVIDER'];
    model: string;
    timeoutMs: number;
    maxRetries: number;
    maxInvocationsPerCommand: number;
    /** Never logged. Use {@link redactConfig} for display. */
    cursorApiKey?: string;
  };
  target: {
    appId: string;
    url: string;
    allowedHosts: string[];
  };
  healing: { maxAttempts: number };
  playwright: { testTimeoutMs: number; headless: boolean };
  paths: FrameworkPaths;
}

export interface FrameworkPaths {
  root: string;
  generatedTests: string;
  knowledge: string;
  businessContext: string;
  reports: string;
  appProfiles: string;
  agentWorkspace: string;
}

export function resolvePaths(root: string = FRAMEWORK_ROOT): FrameworkPaths {
  return {
    root,
    generatedTests: path.join(root, 'generated-tests'),
    knowledge: path.join(root, 'knowledge'),
    businessContext: path.join(root, 'business-context'),
    reports: path.join(root, 'reports'),
    appProfiles: path.join(root, 'app-profiles'),
    agentWorkspace: path.join(root, '.agent-workspace'),
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(env: Record<string, string | undefined>, root: string = FRAMEWORK_ROOT): FrameworkConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  const cfg = parsed.data;
  return {
    provider: {
      name: cfg.AGENT_PROVIDER,
      model: cfg.AGENT_MODEL,
      timeoutMs: cfg.AGENT_TIMEOUT_MS,
      maxRetries: cfg.AGENT_MAX_RETRIES,
      maxInvocationsPerCommand: cfg.MAX_AGENT_INVOCATIONS,
      cursorApiKey: cfg.CURSOR_API_KEY || undefined,
    },
    target: {
      appId: cfg.APP_ID,
      url: cfg.TARGET_APP_URL.replace(/\/+$/, ''),
      allowedHosts: cfg.ALLOWED_HOSTS,
    },
    healing: { maxAttempts: cfg.MAX_HEALING_ATTEMPTS },
    playwright: { testTimeoutMs: cfg.TEST_TIMEOUT_MS, headless: cfg.HEADLESS },
    paths: resolvePaths(root),
  };
}

/** Loads `.env` from the framework root (never overriding real environment variables) and validates it. */
export function loadConfig(overrides: Record<string, string | undefined> = {}): FrameworkConfig {
  const envFile = path.join(FRAMEWORK_ROOT, '.env');
  const fileValues = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
  return parseConfig({ ...fileValues, ...process.env, ...overrides });
}

export function redactConfig(config: FrameworkConfig): Record<string, unknown> {
  return {
    ...config,
    provider: { ...config.provider, cursorApiKey: config.provider.cursorApiKey ? '***redacted***' : '(not set)' },
  };
}
