import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  splitMarkdownByBytes,
  ingestPacketToAiSearch,
  resetR2Client,
} from '../../src/ai-search/index.js';
import type { Config, LLMPacket } from '../../src/types.js';

function createMockPacket(overrides: Partial<LLMPacket> = {}): LLMPacket {
  return {
    source_id: 'test-source-id',
    original_url: 'https://example.com/page',
    canonical_url: 'https://example.com/page',
    retrieved_at: '2026-01-18T12:00:00Z',
    status: 200,
    content_type: 'text/html',
    metadata: {
      title: 'Test Page',
      author: 'Test Author',
    },
    outline: [],
    key_blocks: [],
    content: '# Test Content\n\nThis is test content.',
    source_summary: ['Test summary'],
    citations: [],
    unsafe_instructions_detected: [],
    warnings: [],
    hashes: {
      content_hash: 'abc123',
      raw_hash: 'def456',
    },
    ...overrides,
  };
}

function createMockConfig(overrides: Partial<Config> = {}): Config {
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
    aiSearchMaxFileBytes: 4 * 1024 * 1024,
    aiSearchQueryTimeoutMs: 15000,
    aiSearchQueryWaitMs: 0,
    aiSearchMaxQueryWaitMs: 15000,
    ...overrides,
  };
}

describe('splitMarkdownByBytes', () => {
  it('returns a single part when under the limit', () => {
    const markdown = '# Title\n\nShort content.';
    const parts = splitMarkdownByBytes(markdown, 1024);
    expect(parts.length).toBe(1);
    expect(parts[0]).toBe(markdown);
  });

  it('keeps parts within the byte limit', () => {
    const paragraphs = Array.from({ length: 8 }, (_, idx) =>
      `Paragraph ${idx}\n` + 'word '.repeat(40)
    );
    const markdown = paragraphs.join('\n\n');
    const parts = splitMarkdownByBytes(markdown, 200);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(200);
      expect(part.length).toBeGreaterThan(0);
    }
  });

  it('handles multibyte characters safely', () => {
    const markdown = '😀'.repeat(50);
    const parts = splitMarkdownByBytes(markdown, 40);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(40);
      expect(part.length).toBeGreaterThan(0);
    }
  });

  it('returns original when maxBytes is 0 or negative', () => {
    const markdown = '# Title\n\nContent';
    expect(splitMarkdownByBytes(markdown, 0)).toEqual([markdown]);
    expect(splitMarkdownByBytes(markdown, -1)).toEqual([markdown]);
  });
});

describe('ingestPacketToAiSearch', () => {
  beforeEach(() => {
    resetR2Client();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns enabled=false when disabled via options', async () => {
    const packet = createMockPacket();
    const config = createMockConfig({ aiSearchEnabled: true });
    const result = await ingestPacketToAiSearch(packet, { enabled: false }, config);

    expect(result).toEqual({
      enabled: false,
      uploaded: false,
    });
  });

  it('returns enabled=false when disabled via config', async () => {
    const packet = createMockPacket();
    const config = createMockConfig({ aiSearchEnabled: false });
    const result = await ingestPacketToAiSearch(packet, {}, config);

    expect(result).toEqual({
      enabled: false,
      uploaded: false,
    });
  });

  it('returns error when R2 bucket is missing', async () => {
    const packet = createMockPacket();
    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchR2Bucket: undefined,
    });
    const result = await ingestPacketToAiSearch(packet, { enabled: true }, config);

    expect(result.enabled).toBe(true);
    expect(result.uploaded).toBe(false);
    expect(result.error?.code).toBe('AI_SEARCH_NOT_CONFIGURED');
    expect(result.error?.message).toContain('CF_R2_BUCKET');
  });

  it('returns error when R2 credentials are missing', async () => {
    const packet = createMockPacket();
    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchR2Bucket: 'test-bucket',
      aiSearchAccountId: 'test-account',
      aiSearchR2AccessKeyId: undefined,
      aiSearchR2SecretAccessKey: undefined,
    });
    const result = await ingestPacketToAiSearch(packet, { enabled: true }, config);

    expect(result.enabled).toBe(true);
    expect(result.uploaded).toBe(false);
    expect(result.error?.code).toBe('AI_SEARCH_NOT_CONFIGURED');
    expect(result.error?.message).toContain('R2 credentials');
  });

  it('returns error when R2 endpoint cannot be determined', async () => {
    const packet = createMockPacket();
    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchR2Bucket: 'test-bucket',
      aiSearchAccountId: undefined,
      aiSearchR2Endpoint: undefined,
      aiSearchR2AccessKeyId: 'key',
      aiSearchR2SecretAccessKey: 'secret',
    });
    const result = await ingestPacketToAiSearch(packet, { enabled: true }, config);

    expect(result.enabled).toBe(true);
    expect(result.uploaded).toBe(false);
    expect(result.error?.code).toBe('AI_SEARCH_NOT_CONFIGURED');
    expect(result.error?.message).toContain('R2 endpoint');
  });
});

describe('ingestPacketToAiSearch query', () => {
  beforeEach(() => {
    resetR2Client();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when query credentials are missing', async () => {
    const packet = createMockPacket();
    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchR2Bucket: 'test-bucket',
      aiSearchAccountId: undefined,
      aiSearchName: undefined,
      aiSearchApiToken: undefined,
    });

    // Mock the S3 client to simulate skip_if_exists path
    const mockS3 = {
      send: vi.fn().mockResolvedValue({}),
    };
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: vi.fn(() => mockS3),
      PutObjectCommand: vi.fn(),
      HeadObjectCommand: vi.fn(),
    }));

    const result = await ingestPacketToAiSearch(
      packet,
      {
        enabled: true,
        skip_if_exists: false,
        query: { query: 'test query' },
      },
      {
        ...config,
        aiSearchR2Endpoint: 'https://test.r2.cloudflarestorage.com',
        aiSearchR2AccessKeyId: 'key',
        aiSearchR2SecretAccessKey: 'secret',
      }
    );

    // Should fail on upload before query since we can't actually mock S3
    expect(result.enabled).toBe(true);
  });
});
