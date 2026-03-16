import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockNormalizeContent = vi.fn();
const mockIngestPacketToAiSearch = vi.fn();
const mockStorePacketResource = vi.fn();

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
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
  }),
}));

vi.mock('../../src/processing/normalizer.js', () => ({
  normalizeContent: (...args: unknown[]) => mockNormalizeContent(...args),
  toNormalizedContent: (packet: Record<string, unknown>) => {
    const { hashes: _hashes, ...normalized } = packet as Record<string, unknown>;
    return normalized;
  },
}));

vi.mock('../../src/ai-search/index.js', () => ({
  ingestPacketToAiSearch: (...args: unknown[]) => mockIngestPacketToAiSearch(...args),
}));

vi.mock('../../src/resources/store.js', () => ({
  storePacketResource: (...args: unknown[]) => mockStorePacketResource(...args),
}));

const { executeFetch } = await import('../../src/tools/fetch.js');

function createPacket() {
  return {
    source_id: 'packet-1',
    original_url: 'https://example.com/article',
    canonical_url: 'https://example.com/article',
    retrieved_at: '2024-01-01T00:00:00Z',
    status: 200,
    content_type: 'text/markdown',
    metadata: { title: 'Example' },
    outline: [],
    key_blocks: [],
    content: '# Example\n\nHello world.',
    source_summary: [],
    citations: [],
    unsafe_instructions_detected: [],
    warnings: [],
    hashes: {
      content_hash: 'content-hash',
      raw_hash: 'raw-hash',
    },
  };
}

describe('executeFetch', () => {
  beforeEach(() => {
    mockNormalizeContent.mockReset();
    mockIngestPacketToAiSearch.mockReset();
    mockStorePacketResource.mockReset();
  });

  it('returns raw output for raw_bytes input without normalizing', async () => {
    const result = await executeFetch({
      options: {
        raw_bytes: Buffer.from('hello'),
        content_type: 'text/plain',
        format: {
          output: 'raw',
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.raw).toEqual({
      bytes_length: 5,
      content_type: 'text/plain',
      headers: {
        'content-type': 'text/plain',
      },
    });
    expect(mockNormalizeContent).not.toHaveBeenCalled();
  });

  it('returns normalized output when requested', async () => {
    mockNormalizeContent.mockResolvedValue({
      success: true,
      packet: createPacket(),
    });

    const result = await executeFetch({
      options: {
        raw_bytes: Buffer.from('# Example\n\nHello world.'),
        content_type: 'text/markdown',
        format: {
          output: 'normalized',
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.packet).toBeUndefined();
    expect(result.normalized?.source_id).toBe('packet-1');
    expect(mockStorePacketResource).toHaveBeenCalledTimes(1);
  });

  it('passes nested ai_search options through to ingestion and honors require_success', async () => {
    mockNormalizeContent.mockResolvedValue({
      success: true,
      packet: createPacket(),
    });
    mockIngestPacketToAiSearch.mockResolvedValue({
      enabled: true,
      uploaded: false,
      error: {
        code: 'AI_SEARCH_UPLOAD_FAILED',
        message: 'upload failed',
        details: { retryable: false },
      },
    });

    const result = await executeFetch({
      options: {
        raw_bytes: Buffer.from('# Example\n\nHello world.'),
        content_type: 'text/markdown',
        ai_search: {
          enabled: true,
          wait_ms: 250,
          require_success: true,
          query: {
            query: 'example',
            mode: 'ai_search',
          },
        },
      },
    });

    expect(mockIngestPacketToAiSearch).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: 'packet-1' }),
      expect.objectContaining({
        enabled: true,
        wait_ms: 250,
        require_success: true,
        query: {
          query: 'example',
          mode: 'ai_search',
        },
      }),
      expect.any(Object)
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AI_SEARCH_UPLOAD_FAILED');
  });
});
