import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/config.js';
import type { Config } from '../../src/types.js';

function createValidConfig(overrides: Partial<Config> = {}): Config {
  return {
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 30000,
    maxRedirects: 5,
    blockPrivateIp: true,
    allowlistDomains: [],
    rateLimitPerHost: 60,
    defaultMaxTokens: 4000,
    chunkMarginRatio: 0.1,
    respectRobots: true,
    playwrightEnabled: false,
    pdfEnabled: true,
    cacheTtlS: 300,
    renderBlockThirdParty: true,
    renderTimeoutMs: 60000,
    userAgent: 'test-agent',
    aiSearchEnabled: false,
    aiSearchScope: 'conversation',
    aiSearchThreadKey: undefined,
    aiSearchStateDir: '/tmp/web-fetch-mcp-test',
    aiSearchRequireThreadKey: false,
    aiSearchWorkspaceRoot: undefined,
    aiSearchMaxFileBytes: 4 * 1024 * 1024,
    aiSearchQueryTimeoutMs: 15000,
    aiSearchQueryWaitMs: 0,
    aiSearchMaxQueryWaitMs: 15000,
    ...overrides,
  };
}

describe('validateConfig', () => {
  it('returns no errors for valid config', () => {
    const config = createValidConfig();
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('validates maxBytes bounds', () => {
    expect(validateConfig(createValidConfig({ maxBytes: 100 }))).toContainEqual(
      expect.stringContaining('MAX_BYTES must be at least 1024')
    );
    expect(validateConfig(createValidConfig({ maxBytes: 200 * 1024 * 1024 }))).toContainEqual(
      expect.stringContaining('MAX_BYTES must be at most 100MB')
    );
  });

  it('validates timeoutMs bounds', () => {
    expect(validateConfig(createValidConfig({ timeoutMs: 500 }))).toContainEqual(
      expect.stringContaining('TIMEOUT_MS must be at least 1000ms')
    );
    expect(validateConfig(createValidConfig({ timeoutMs: 400000 }))).toContainEqual(
      expect.stringContaining('TIMEOUT_MS must be at most 300000ms')
    );
  });

  it('validates maxRedirects bounds', () => {
    expect(validateConfig(createValidConfig({ maxRedirects: -1 }))).toContainEqual(
      expect.stringContaining('MAX_REDIRECTS must be between 0 and 20')
    );
    expect(validateConfig(createValidConfig({ maxRedirects: 25 }))).toContainEqual(
      expect.stringContaining('MAX_REDIRECTS must be between 0 and 20')
    );
  });

  it('validates rateLimitPerHost bounds', () => {
    expect(validateConfig(createValidConfig({ rateLimitPerHost: 0 }))).toContainEqual(
      expect.stringContaining('RATE_LIMIT_PER_HOST must be between 1 and 1000')
    );
    expect(validateConfig(createValidConfig({ rateLimitPerHost: 2000 }))).toContainEqual(
      expect.stringContaining('RATE_LIMIT_PER_HOST must be between 1 and 1000')
    );
  });

  it('validates chunkMarginRatio bounds', () => {
    expect(validateConfig(createValidConfig({ chunkMarginRatio: -0.1 }))).toContainEqual(
      expect.stringContaining('CHUNK_MARGIN_RATIO must be between 0 and 0.5')
    );
    expect(validateConfig(createValidConfig({ chunkMarginRatio: 0.6 }))).toContainEqual(
      expect.stringContaining('CHUNK_MARGIN_RATIO must be between 0 and 0.5')
    );
  });

  it('validates defaultMaxTokens minimum', () => {
    expect(validateConfig(createValidConfig({ defaultMaxTokens: 50 }))).toContainEqual(
      expect.stringContaining('DEFAULT_MAX_TOKENS must be at least 100')
    );
  });

  it('validates aiSearchMaxFileBytes minimum', () => {
    expect(validateConfig(createValidConfig({ aiSearchMaxFileBytes: 500 }))).toContainEqual(
      expect.stringContaining('AI_SEARCH_MAX_FILE_BYTES must be at least 1024')
    );
  });

  it('validates aiSearchQueryTimeoutMs minimum', () => {
    expect(validateConfig(createValidConfig({ aiSearchQueryTimeoutMs: 500 }))).toContainEqual(
      expect.stringContaining('AI_SEARCH_QUERY_TIMEOUT_MS must be at least 1000ms')
    );
  });

  it('validates aiSearchMaxQueryWaitMs minimum', () => {
    expect(validateConfig(createValidConfig({ aiSearchMaxQueryWaitMs: -1 }))).toContainEqual(
      expect.stringContaining('AI_SEARCH_MAX_QUERY_WAIT_MS must be at least 0ms')
    );
  });

  describe('AI Search credentials validation', () => {
    it('requires CF_ACCOUNT_ID when AI Search is enabled', () => {
      const config = createValidConfig({
        aiSearchEnabled: true,
        aiSearchAccountId: undefined,
        aiSearchR2Bucket: 'bucket',
        aiSearchR2AccessKeyId: 'key',
        aiSearchR2SecretAccessKey: 'secret',
      });
      const errors = validateConfig(config);
      expect(errors).toContainEqual(
        expect.stringContaining('CF_ACCOUNT_ID is required when AI_SEARCH_ENABLED=true')
      );
    });

    it('requires CF_R2_BUCKET when AI Search is enabled', () => {
      const config = createValidConfig({
        aiSearchEnabled: true,
        aiSearchAccountId: 'account',
        aiSearchR2Bucket: undefined,
        aiSearchR2AccessKeyId: 'key',
        aiSearchR2SecretAccessKey: 'secret',
      });
      const errors = validateConfig(config);
      expect(errors).toContainEqual(
        expect.stringContaining('CF_R2_BUCKET is required when AI_SEARCH_ENABLED=true')
      );
    });

    it('requires CF_R2_ACCESS_KEY_ID when AI Search is enabled', () => {
      const config = createValidConfig({
        aiSearchEnabled: true,
        aiSearchAccountId: 'account',
        aiSearchR2Bucket: 'bucket',
        aiSearchR2AccessKeyId: undefined,
        aiSearchR2SecretAccessKey: 'secret',
      });
      const errors = validateConfig(config);
      expect(errors).toContainEqual(
        expect.stringContaining('CF_R2_ACCESS_KEY_ID is required when AI_SEARCH_ENABLED=true')
      );
    });

    it('requires CF_R2_SECRET_ACCESS_KEY when AI Search is enabled', () => {
      const config = createValidConfig({
        aiSearchEnabled: true,
        aiSearchAccountId: 'account',
        aiSearchR2Bucket: 'bucket',
        aiSearchR2AccessKeyId: 'key',
        aiSearchR2SecretAccessKey: undefined,
      });
      const errors = validateConfig(config);
      expect(errors).toContainEqual(
        expect.stringContaining('CF_R2_SECRET_ACCESS_KEY is required when AI_SEARCH_ENABLED=true')
      );
    });

    it('returns no credential errors when AI Search is disabled', () => {
      const config = createValidConfig({
        aiSearchEnabled: false,
        aiSearchAccountId: undefined,
        aiSearchR2Bucket: undefined,
        aiSearchR2AccessKeyId: undefined,
        aiSearchR2SecretAccessKey: undefined,
      });
      const errors = validateConfig(config);
      expect(errors).toEqual([]);
    });

    it('returns no credential errors when all AI Search credentials are provided', () => {
      const config = createValidConfig({
        aiSearchEnabled: true,
        aiSearchAccountId: 'account',
        aiSearchR2Bucket: 'bucket',
        aiSearchR2AccessKeyId: 'key',
        aiSearchR2SecretAccessKey: 'secret',
      });
      const errors = validateConfig(config);
      expect(errors).toEqual([]);
    });

    it('requires thread key when conversation scope and requireThreadKey is true', () => {
      const config = createValidConfig({
        aiSearchEnabled: true,
        aiSearchRequireThreadKey: true,
        aiSearchThreadKey: undefined,
        aiSearchAccountId: 'account',
        aiSearchR2Bucket: 'bucket',
        aiSearchR2AccessKeyId: 'key',
        aiSearchR2SecretAccessKey: 'secret',
      });
      const errors = validateConfig(config);
      expect(errors).toContainEqual(
        expect.stringContaining('WEB_FETCH_THREAD_KEY')
      );
    });
  });
});
