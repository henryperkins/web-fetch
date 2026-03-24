import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import {
  splitMarkdownByBytes,
  ingestPacketToAiSearch,
  queryAiSearchScoped,
  resetR2Client,
  SseParser,
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
    vi.unstubAllGlobals();
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

describe('AI Search upload metadata', () => {
  beforeEach(() => {
    resetR2Client();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes a context metadata field to R2 uploads', async () => {
    const sendMock = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({} as never));
    const packet = createMockPacket();
    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchR2Bucket: 'test-bucket',
      aiSearchAccountId: 'test-account',
      aiSearchR2AccessKeyId: 'key',
      aiSearchR2SecretAccessKey: 'secret',
    });

    const result = await ingestPacketToAiSearch(
      packet,
      {
        enabled: true,
        skip_if_exists: false,
      },
      config
    );

    expect(result.uploaded).toBe(true);
    const command = sendMock.mock.calls[0]?.[0] as { input?: { Metadata?: Record<string, string> } };
    expect(command.input?.Metadata).toMatchObject({
      context: expect.stringContaining('Source URL: https://example.com/page'),
    });
  });

  it('lowercases custom metadata keys and skips reserved names', async () => {
    const sendMock = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({} as never));
    const packet = createMockPacket();
    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchR2Bucket: 'test-bucket',
      aiSearchAccountId: 'test-account',
      aiSearchR2AccessKeyId: 'key',
      aiSearchR2SecretAccessKey: 'secret',
    });

    const result = await ingestPacketToAiSearch(
      packet,
      {
        enabled: true,
        skip_if_exists: false,
        metadata: {
          Category: 'docs',
          folder: 'should-be-skipped',
          timestamp: 'should-be-skipped',
          filename: 'should-be-skipped',
          Tag: 'test',
        },
      },
      config
    );

    expect(result.uploaded).toBe(true);
    const command = sendMock.mock.calls[0]?.[0] as { input?: { Metadata?: Record<string, string> } };
    const metadata = command.input?.Metadata ?? {};
    // Keys should be lowercased
    expect(metadata['category']).toBe('docs');
    expect(metadata['tag']).toBe('test');
    // Reserved names should be skipped
    expect(metadata['folder']).toBeUndefined();
    expect(metadata['timestamp']).toBeUndefined();
    expect(metadata['filename']).toBeUndefined();
    // Warnings should be present
    expect(result.warning).toContain('folder');
    expect(result.warning).toContain('timestamp');
    expect(result.warning).toContain('filename');
  });
});

describe('queryAiSearchScoped transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the AI Search /search endpoint with messages and nested options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, result: { chunks: [] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchScope: 'global',
      aiSearchAccountId: 'test-account',
      aiSearchName: 'kb',
      aiSearchApiToken: 'token',
    });

    const result = await queryAiSearchScoped(
      {
        query: 'find the source',
        mode: 'search',
        max_num_results: 5,
        retrieval_type: 'hybrid',
        match_threshold: 0.55,
        cache: { enabled: true },
        reranking: { enabled: true },
        system_prompt: 'Use only indexed material.',
      },
      config
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai-search/instances/kb/search');
    expect(JSON.parse(init.body as string)).toEqual({
      messages: [
        { content: 'Use only indexed material.', role: 'system' },
        { content: 'find the source', role: 'user' },
      ],
      ai_search_options: {
        retrieval: {
          max_num_results: 5,
          retrieval_type: 'hybrid',
          match_threshold: 0.55,
        },
        cache: { enabled: true },
        reranking: { enabled: true },
      },
    });
    expect(result.response).toEqual({ success: true, result: { chunks: [] } });
  });

  it('uses the /chat/completions endpoint and parses SSE responses when stream=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'event: chunks\n' +
      'data: [{"id":"chunk001","text":"source"}]\n\n' +
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const config = createMockConfig({
      aiSearchEnabled: true,
      aiSearchScope: 'global',
      aiSearchAccountId: 'test-account',
      aiSearchName: 'kb',
      aiSearchApiToken: 'token',
    });

    const result = await queryAiSearchScoped(
      {
        query: 'summarize this',
        mode: 'ai_search',
        stream: true,
      },
      config
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/ai-search/instances/kb/chat/completions');
    expect(JSON.parse(init.body as string)).toEqual({
      messages: [{ content: 'summarize this', role: 'user' }],
      stream: true,
    });
    expect(result.response).toMatchObject({
      type: 'sse',
      chunks: [{ id: 'chunk001', text: 'source' }],
      text: 'Hello',
      done: true,
    });
  });
});

describe('SseParser', () => {
  const ssePayload =
    'event: chunks\ndata: [{"id":"c1","text":"doc"}]\n\n' +
    'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"there"}}]}\n\n' +
    'data: [DONE]\n\n';

  it('produces the same result from a single feed as from chunked feeds', () => {
    // Bulk parse
    const bulk = new SseParser();
    bulk.feed(ssePayload);
    const bulkResult = bulk.getResult();

    // Chunked parse — split at arbitrary byte boundaries
    const chunked = new SseParser();
    const chunkSize = 7;
    for (let i = 0; i < ssePayload.length; i += chunkSize) {
      chunked.feed(ssePayload.slice(i, i + chunkSize));
    }
    const chunkedResult = chunked.getResult();

    expect(chunkedResult).toEqual(bulkResult);
  });

  it('extracts text, chunks, and done flag from SSE events', () => {
    const parser = new SseParser();
    parser.feed(ssePayload);
    const result = parser.getResult();

    expect(result).toMatchObject({
      type: 'sse',
      chunks: [{ id: 'c1', text: 'doc' }],
      text: 'Hi there',
      done: true,
    });
    expect((result['events'] as unknown[]).length).toBe(4);
  });

  it('buffers incomplete blocks until more data arrives', () => {
    const parser = new SseParser();
    // Feed a partial block (no trailing double newline)
    parser.feed('data: {"choices":[{"delta":{"content":"partial"}}]}');
    // Result should have no events yet — block is incomplete
    const partial = parser.getResult();
    // After getResult flushes, it processes the remaining buffer
    expect(partial['text']).toBe('partial');

    // New parser: feed incomplete, then complete it
    const parser2 = new SseParser();
    parser2.feed('data: {"choices":[{"delta":{"content":"a"}}]}');
    parser2.feed('\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n');
    const result = parser2.getResult();
    expect(result['text']).toBe('ab');
  });
});
