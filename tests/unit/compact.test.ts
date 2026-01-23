/**
 * Compact Tool Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { executeCompact } from '../../src/tools/compact.js';
import { chunkContent } from '../../src/processing/chunker.js';
import type { LLMPacket, ChunkSet } from '../../src/types.js';

describe('Compact tool', () => {
  it('should compact minimal packet input', () => {
    const minimalPacket = {
      source_id: 'source-1',
      content: '# Title\n\nSome text about Example Domain.',
    } as LLMPacket;

    const result = executeCompact({
      input: minimalPacket,
      options: {
        max_tokens: 50,
        mode: 'salience',
      },
    });

    expect(result.success).toBe(true);
    expect(result.compacted?.source_id).toBe('source-1');
    expect(result.compacted?.compacted.summary.length).toBeGreaterThan(0);
  });

  it('should return a clear error when content is missing', () => {
    const result = executeCompact({
      input: { source_id: 'source-2' } as LLMPacket,
      options: { max_tokens: 50 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('content');
  });

  it('should preserve headings and list items in summaries', () => {
    const packet = {
      source_id: 'source-3',
      content: `# Overview

- First item
- Second item

This paragraph explains the list above.`,
    } as LLMPacket;

    const result = executeCompact({
      input: packet,
      options: {
        max_tokens: 80,
        mode: 'salience',
      },
    });

    expect(result.success).toBe(true);
    const summary = result.compacted?.compacted.summary ?? '';
    expect(summary).toContain('# Overview');
    expect(summary).toContain('- First item');
  });

  it('should summarize large sections instead of dropping them', () => {
    const packet = {
      source_id: 'source-4',
      content: `# Big Section

${'This sentence adds detail. '.repeat(120)}`,
    } as LLMPacket;

    const result = executeCompact({
      input: packet,
      options: {
        max_tokens: 80,
        mode: 'structural',
      },
    });

    expect(result.success).toBe(true);
    const summary = result.compacted?.compacted.summary ?? '';
    expect(summary).toContain('# Big Section');
    expect(summary.length).toBeLessThan(packet.content.length);
  });

  it('should attach citations from key blocks', () => {
    const packet = {
      source_id: 'source-5',
      content: `# Pricing

The price is $10 for early access.`,
      key_blocks: [
        {
          block_id: 'b0',
          kind: 'heading',
          text: '# Pricing',
          char_len: '# Pricing'.length,
        },
        {
          block_id: 'b1',
          kind: 'paragraph',
          text: 'The price is $10 for early access.',
          char_len: 'The price is $10 for early access.'.length,
        },
      ],
    } as LLMPacket;

    const result = executeCompact({
      input: packet,
      options: {
        max_tokens: 50,
        mode: 'salience',
        preserve: ['numbers'],
      },
    });

    expect(result.success).toBe(true);
    const keyPoints = result.compacted?.compacted.key_points ?? [];
    expect(keyPoints.length).toBeGreaterThan(0);
    const pricePoint = keyPoints.find(point => point.text.includes('$10'));
    expect(pricePoint?.citation).toBe('b1');
  });

  it('should preserve original_url and citations when compacting a ChunkSet', () => {
    const packet = {
      source_id: 'source-6',
      original_url: 'https://example.com/pricing',
      canonical_url: 'https://example.com/pricing',
      retrieved_at: new Date().toISOString(),
      status: 200,
      content_type: 'text/markdown',
      metadata: { title: 'Pricing' },
      outline: [],
      key_blocks: [
        {
          block_id: 'b0',
          kind: 'heading',
          text: '# Pricing',
          char_len: '# Pricing'.length,
        },
        {
          block_id: 'b1',
          kind: 'paragraph',
          text: 'The price is $10 for early access.',
          char_len: 'The price is $10 for early access.'.length,
        },
      ],
      content: '# Pricing\n\nThe price is $10 for early access.',
      source_summary: [],
      citations: [],
      unsafe_instructions_detected: [],
      warnings: [],
      hashes: { content_hash: 'abc', raw_hash: 'def' },
    } as LLMPacket;

    const chunkSet = chunkContent(packet, { max_tokens: 200 });

    const result = executeCompact({
      input: chunkSet,
      options: {
        max_tokens: 50,
        mode: 'salience',
        preserve: ['numbers'],
      },
    });

    expect(result.success).toBe(true);
    expect(result.compacted?.original_url).toBe(packet.original_url);
    const keyPoints = result.compacted?.compacted.key_points ?? [];
    expect(keyPoints.some(point => point.citation === 'b1')).toBe(true);
  });

  it('should warn when chunk count exceeds map-reduce token budget', () => {
    const chunkSet: ChunkSet = {
      source_id: 'source-7',
      max_tokens: 10,
      total_chunks: 5,
      total_est_tokens: 5,
      chunks: [
        { chunk_id: 'c0', chunk_index: 0, headings_path: '', est_tokens: 1, text: 'Alpha one.', char_len: 10 },
        { chunk_id: 'c1', chunk_index: 1, headings_path: '', est_tokens: 1, text: 'Bravo two.', char_len: 10 },
        { chunk_id: 'c2', chunk_index: 2, headings_path: '', est_tokens: 1, text: 'Charlie three.', char_len: 14 },
        { chunk_id: 'c3', chunk_index: 3, headings_path: '', est_tokens: 1, text: 'Delta four.', char_len: 11 },
        { chunk_id: 'c4', chunk_index: 4, headings_path: '', est_tokens: 1, text: 'Echo five.', char_len: 10 },
      ],
    };

    const result = executeCompact({
      input: chunkSet,
      options: {
        max_tokens: 2,
        mode: 'map_reduce',
      },
    });

    expect(result.success).toBe(true);
    expect(result.compacted?.compacted.summary.length).toBeGreaterThan(0);
    expect(result.compacted?.compacted.warnings.length).toBeGreaterThan(0);
  });

  it('should avoid JSON-like quotes in important_quotes', () => {
    const packet = {
      source_id: 'source-8',
      content: [
        'Here is a quote: "We ship fast and safe for users every single day."',
        '',
        '"config": "This string should not be treated as a quote in summaries."',
      ].join('\n'),
    } as LLMPacket;

    const result = executeCompact({
      input: packet,
      options: {
        max_tokens: 120,
        mode: 'salience',
      },
    });

    expect(result.success).toBe(true);
    const quotes = result.compacted?.compacted.important_quotes ?? [];
    expect(quotes.some(q => q.text.includes('We ship fast and safe'))).toBe(true);
    expect(quotes.some(q => q.text.includes('should not be treated as a quote'))).toBe(false);
  });
});
