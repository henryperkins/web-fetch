/**
 * Compact Tool Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { executeCompact } from '../../src/tools/compact.js';
import type { LLMPacket } from '../../src/types.js';

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
});
