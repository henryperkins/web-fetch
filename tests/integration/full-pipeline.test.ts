/**
 * Full Pipeline Integration Tests
 *
 * Tests the complete flow: fetch -> chunk -> compact
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { executeFetch } from '../../src/tools/fetch.js';
import { executeChunk } from '../../src/tools/chunk.js';
import { executeCompact } from '../../src/tools/compact.js';
import { resetConfig } from '../../src/config.js';

describe('Full Pipeline Integration', () => {
  beforeAll(() => {
    resetConfig();
  });

  it('should complete full pipeline: fetch -> chunk -> compact', async () => {
    // Step 1: Fetch
    const fetchResult = await executeFetch({
      url: 'https://httpbin.org/html',
      options: {
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(fetchResult.success).toBe(true);
    expect(fetchResult.packet).toBeDefined();

    // Step 2: Chunk
    const chunkResult = executeChunk({
      packet: fetchResult.packet!,
      options: {
        max_tokens: 500,
        strategy: 'headings_first',
      },
    });

    expect(chunkResult.success).toBe(true);
    expect(chunkResult.chunks).toBeDefined();
    expect(chunkResult.chunks!.chunks.length).toBeGreaterThan(0);

    // Verify chunk properties
    for (const chunk of chunkResult.chunks!.chunks) {
      expect(chunk.chunk_id).toBeDefined();
      expect(chunk.est_tokens).toBeLessThanOrEqual(500);
      expect(chunk.text.length).toBeGreaterThan(0);
    }

    // Step 3: Compact
    const compactResult = executeCompact({
      input: fetchResult.packet!,
      options: {
        max_tokens: 200,
        mode: 'structural',
        preserve: ['numbers', 'dates', 'names'],
      },
    });

    expect(compactResult.success).toBe(true);
    expect(compactResult.compacted).toBeDefined();
    expect(compactResult.compacted!.compacted.summary).toBeDefined();
  }, 60000);

  it('should handle fetch with extraction options', async () => {
    const result = await executeFetch({
      url: 'https://httpbin.org/html',
      options: {
        mode: 'http',
        timeout_ms: 30000,
        extraction: {
          prefer_readability: true,
          keep_tables: true,
          keep_code_blocks: true,
        },
        format: {
          output: 'llm_packet',
          include_raw_excerpt: true,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.packet?.raw_excerpt).toBeDefined();
    expect(result.packet?.raw_excerpt?.length).toBeGreaterThan(0);
  }, 30000);

  it('should support question-focused compaction', async () => {
    const fetchResult = await executeFetch({
      url: 'https://httpbin.org/html',
      options: {
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(fetchResult.success).toBe(true);

    const compactResult = executeCompact({
      input: fetchResult.packet!,
      options: {
        max_tokens: 200,
        mode: 'question_focused',
        question: 'What is the main topic of this page?',
        preserve: ['names'],
      },
    });

    expect(compactResult.success).toBe(true);
    expect(compactResult.compacted?.compacted.summary).toBeDefined();
  }, 30000);

  it('should chunk and compact from ChunkSet', async () => {
    // Fetch content
    const fetchResult = await executeFetch({
      url: 'https://httpbin.org/html',
      options: {
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(fetchResult.success).toBe(true);

    // Chunk it
    const chunkResult = executeChunk({
      packet: fetchResult.packet!,
      options: { max_tokens: 500 },
    });

    expect(chunkResult.success).toBe(true);

    // Compact from chunks
    const compactResult = executeCompact({
      input: chunkResult.chunks!,
      options: {
        max_tokens: 150,
        mode: 'map_reduce',
      },
    });

    expect(compactResult.success).toBe(true);
    expect(compactResult.compacted?.source_id).toBe(fetchResult.packet?.source_id);
  }, 30000);

  it('should detect prompt injection in fetched content', async () => {
    // Create a simple test - injection detection happens during extraction
    const fetchResult = await executeFetch({
      url: 'https://httpbin.org/html',
      options: {
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(fetchResult.success).toBe(true);
    // The httpbin HTML doesn't contain injections, so this should be empty
    expect(fetchResult.packet?.unsafe_instructions_detected).toBeDefined();
    expect(Array.isArray(fetchResult.packet?.unsafe_instructions_detected)).toBe(true);
  }, 30000);

  it('should generate valid source_id across pipeline', async () => {
    const fetchResult = await executeFetch({
      url: 'https://httpbin.org/html',
      options: {
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(fetchResult.success).toBe(true);
    const sourceId = fetchResult.packet?.source_id;
    expect(sourceId).toBeDefined();
    expect(sourceId?.length).toBeGreaterThan(0);

    // Chunk should preserve source_id
    const chunkResult = executeChunk({
      packet: fetchResult.packet!,
      options: { max_tokens: 500 },
    });

    expect(chunkResult.chunks?.source_id).toBe(sourceId);

    // Compact should include source_id
    const compactResult = executeCompact({
      input: fetchResult.packet!,
      options: { max_tokens: 200 },
    });

    expect(compactResult.compacted?.source_id).toBe(sourceId);
  }, 30000);
});
