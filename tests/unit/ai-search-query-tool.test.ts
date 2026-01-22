import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Config } from '../../src/types.js';
import { executeAiSearchQuery } from '../../src/tools/ai-search-query.js';
import * as aiSearchModule from '../../src/ai-search/index.js';
import * as configModule from '../../src/config.js';

function createConfig(overrides: Partial<Config> = {}): Config {
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
    aiSearchEnabled: true,
    aiSearchScope: 'global',
    aiSearchThreadKey: undefined,
    aiSearchStateDir: '/tmp/web-fetch-mcp-test',
    aiSearchRequireThreadKey: false,
    aiSearchWorkspaceRoot: undefined,
    aiSearchAccountId: undefined,
    aiSearchName: undefined,
    aiSearchApiToken: undefined,
    aiSearchR2AccessKeyId: undefined,
    aiSearchR2SecretAccessKey: undefined,
    aiSearchR2Bucket: undefined,
    aiSearchR2Endpoint: undefined,
    aiSearchR2Prefix: undefined,
    aiSearchMaxFileBytes: 4 * 1024 * 1024,
    aiSearchQueryTimeoutMs: 15000,
    aiSearchQueryWaitMs: 0,
    aiSearchMaxQueryWaitMs: 15000,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeAiSearchQuery', () => {
  it('returns failure when AI Search returns an error', async () => {
    const config = createConfig();
    vi.spyOn(configModule, 'getConfig').mockReturnValue(config);
    vi.spyOn(aiSearchModule, 'queryAiSearchScoped').mockResolvedValue({
      mode: 'search',
      request: { query: 'test' },
      error: { code: 'AI_SEARCH_NOT_CONFIGURED', message: 'Missing config' },
    });

    const result = await executeAiSearchQuery({ query: { query: 'test' } });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AI_SEARCH_NOT_CONFIGURED');
    expect(result.result?.request).toEqual({ query: 'test' });
  });

  it('returns success when AI Search returns a response', async () => {
    const config = createConfig();
    vi.spyOn(configModule, 'getConfig').mockReturnValue(config);
    vi.spyOn(aiSearchModule, 'queryAiSearchScoped').mockResolvedValue({
      mode: 'search',
      request: { query: 'test' },
      response: { results: [] },
    });

    const result = await executeAiSearchQuery({ query: { query: 'test' } });

    expect(result.success).toBe(true);
    expect(result.result?.response).toEqual({ results: [] });
  });
});
