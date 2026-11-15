import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, redactConfig } from '../../src/config/config.js';

describe('configuration validation', () => {
  it('applies safe defaults', () => {
    const config = parseConfig({});
    expect(config.provider.name).toBe('cursor');
    expect(config.provider.model).toBe('composer-2.5');
    expect(config.healing.maxAttempts).toBe(2);
    expect(config.target.url).toBe('http://localhost:3000');
    expect(config.target.allowedHosts).toEqual(['localhost', '127.0.0.1']);
    expect(config.playwright.headless).toBe(true);
  });

  it('parses and coerces values from the environment', () => {
    const config = parseConfig({
      AGENT_PROVIDER: 'external',
      MAX_HEALING_ATTEMPTS: '3',
      TARGET_APP_URL: 'http://127.0.0.1:5173/',
      HEADLESS: 'false',
      ALLOWED_HOSTS: ' LOCALHOST , 127.0.0.1 ',
    });
    expect(config.provider.name).toBe('external');
    expect(config.healing.maxAttempts).toBe(3);
    expect(config.target.url).toBe('http://127.0.0.1:5173');
    expect(config.playwright.headless).toBe(false);
    expect(config.target.allowedHosts).toEqual(['localhost', '127.0.0.1']);
  });

  it('rejects targets outside the approved host list', () => {
    expect(() => parseConfig({ TARGET_APP_URL: 'https://example.com' })).toThrow(/not in ALLOWED_HOSTS/);
  });

  it('rejects invalid provider names and out-of-range limits', () => {
    expect(() => parseConfig({ AGENT_PROVIDER: 'openai' })).toThrow(ConfigError);
    expect(() => parseConfig({ MAX_HEALING_ATTEMPTS: '50' })).toThrow(ConfigError);
    expect(() => parseConfig({ AGENT_TIMEOUT_MS: '5' })).toThrow(ConfigError);
  });

  it('never exposes the API key when redacted', () => {
    const config = parseConfig({ CURSOR_API_KEY: 'key_super_secret_value' });
    expect(config.provider.cursorApiKey).toBe('key_super_secret_value');
    expect(JSON.stringify(redactConfig(config))).not.toContain('key_super_secret_value');
  });
});
