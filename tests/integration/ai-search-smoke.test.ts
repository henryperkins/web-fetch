/**
 * AI Search Smoke Test — Live Integration
 *
 * Requires real Cloudflare credentials. Skipped when env vars are missing.
 *
 * Run with: npm run test:smoke
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ingestPacketToAiSearch,
  queryAiSearchScoped,
  resetR2Client,
} from '../../src/ai-search/index.js';
import type { Config, LLMPacket } from '../../src/types.js';
import { resetConfig } from '../../src/config.js';

const HAS_CF_CREDENTIALS = !!(
  process.env.CF_ACCOUNT_ID &&
  process.env.CF_AI_SEARCH_NAME &&
  process.env.CF_AI_SEARCH_API_TOKEN &&
  process.env.CF_R2_BUCKET &&
  process.env.CF_R2_ACCESS_KEY_ID &&
  process.env.CF_R2_SECRET_ACCESS_KEY
);

const SENTINEL = `SMOKE-TEST-SENTINEL-${Date.now()}`;

function createSmokeTestPacket(): LLMPacket {
  return {
    source_id: `smoke-${Date.now()}`,
    original_url: 'https://smoke-test.example.com/doc',
    canonical_url: 'https://smoke-test.example.com/doc',
    retrieved_at: new Date().toISOString(),
    status: 200,
    content_type: 'text/html',
    metadata: { title: 'Smoke Test Document' },
    outline: [],
    key_blocks: [],
    content: `# Smoke Test\n\nThe Cloudflare smoke test sentinel value is ${SENTINEL}. This document verifies end-to-end AI Search integration.`,
    source_summary: ['Smoke test document for AI Search integration'],
    citations: [],
    unsafe_instructions_detected: [],
    warnings: [],
    hashes: {
      content_hash: `smoke-${Date.now()}`,
      raw_hash: `smoke-raw-${Date.now()}`,
    },
  };
}

function createLiveConfig(): Config {
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
    cacheTtlS: 0,
    renderBlockThirdParty: true,
    renderTimeoutMs: 30000,
    userAgent: 'web-fetch-mcp/smoke-test',
    aiSearchEnabled: true,
    aiSearchScope: 'global' as const,
    aiSearchAccountId: process.env.CF_ACCOUNT_ID!,
    aiSearchName: process.env.CF_AI_SEARCH_NAME!,
    aiSearchApiToken: process.env.CF_AI_SEARCH_API_TOKEN!,
    aiSearchR2Bucket: process.env.CF_R2_BUCKET!,
    aiSearchR2AccessKeyId: process.env.CF_R2_ACCESS_KEY_ID!,
    aiSearchR2SecretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY!,
    aiSearchR2Endpoint: process.env.CF_R2_ENDPOINT,
    aiSearchR2Prefix: 'smoke-test',
    aiSearchMaxFileBytes: 4 * 1024 * 1024,
    aiSearchQueryTimeoutMs: 30000,
    aiSearchQueryWaitMs: 5000,
    aiSearchMaxQueryWaitMs: 60000,
  } as Config;
}

const describeIf = HAS_CF_CREDENTIALS ? describe : describe.skip;

describeIf('AI Search Smoke Test (live)', () => {
  let config: Config;
  let packet: LLMPacket;

  beforeAll(() => {
    resetConfig();
    resetR2Client();
    config = createLiveConfig();
    packet = createSmokeTestPacket();
  });

  afterAll(() => {
    resetR2Client();
  });

  it('uploads a document to R2', async () => {
    const result = await ingestPacketToAiSearch(
      packet,
      { enabled: true, skip_if_exists: false },
      config
    );

    expect(result.enabled).toBe(true);
    expect(result.uploaded).toBe(true);
    expect(result.keys).toBeDefined();
    expect(result.keys!.length).toBeGreaterThanOrEqual(1);
    expect(result.parts).toBeGreaterThanOrEqual(1);
  }, 60000);

  it('/search returns scoped chunks', async () => {
    // Allow time for indexing
    const maxAttempts = 3;
    let result;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      result = await queryAiSearchScoped(
        { query: 'smoke test sentinel', mode: 'search' },
        config
      );
      if (result.status === 200) break;
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    expect(result!.status).toBe(200);
    expect(result!.response).toBeDefined();
  }, 60000);

  it('/chat/completions returns an answer (non-streaming)', async () => {
    const result = await queryAiSearchScoped(
      {
        query: 'What is the smoke test sentinel value?',
        mode: 'ai_search',
        stream: false,
      },
      config
    );

    expect(result.status).toBe(200);
    expect(result.response).toBeDefined();
  }, 90000);

  it('/chat/completions with stream:true returns SSE shape', async () => {
    const result = await queryAiSearchScoped(
      {
        query: 'What is the smoke test sentinel value?',
        mode: 'ai_search',
        stream: true,
      },
      config
    );

    expect(result.status).toBe(200);
    const response = result.response as Record<string, unknown>;
    expect(response.type).toBe('sse');
    expect(typeof response.text).toBe('string');
    expect(response.done).toBe(true);
  }, 90000);
});
