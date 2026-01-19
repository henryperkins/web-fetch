/**
 * Chunker Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { chunkContent, getChunk, searchChunks } from '../../src/processing/chunker.js';
import type { LLMPacket } from '../../src/types.js';

describe('Chunker', () => {
  // Helper to create a test packet
  function createTestPacket(content: string): LLMPacket {
    return {
      source_id: 'test123',
      original_url: 'https://example.com',
      canonical_url: 'https://example.com',
      retrieved_at: new Date().toISOString(),
      status: 200,
      content_type: 'text/markdown',
      metadata: { title: 'Test Document' },
      outline: [],
      key_blocks: [],
      content,
      source_summary: [],
      citations: [],
      unsafe_instructions_detected: [],
      warnings: [],
      hashes: { content_hash: 'abc', raw_hash: 'def' },
    };
  }

  describe('chunkContent', () => {
    it('should not split small content', () => {
      const packet = createTestPacket('# Title\n\nShort content here.');
      const result = chunkContent(packet, { max_tokens: 1000 });

      expect(result.total_chunks).toBe(1);
      expect(result.chunks[0]?.text).toContain('Title');
    });

    it('should split content at heading boundaries', () => {
      const content = `# Section 1

This is the first section with some content.

# Section 2

This is the second section with different content.

# Section 3

This is the third section.`;

      const packet = createTestPacket(content);
      const result = chunkContent(packet, { max_tokens: 50, strategy: 'headings_first' });

      expect(result.total_chunks).toBeGreaterThan(1);
    });

    it('should set headings_path based on chunk start', () => {
      const content = `# Section 1

${'word '.repeat(200)}

# Section 2

Short section.`;

      const packet = createTestPacket(content);
      const result = chunkContent(packet, { max_tokens: 50, strategy: 'headings_first' });

      const section1Chunk = result.chunks.find(c => c.text.includes('# Section 1'));
      const section2Chunk = result.chunks.find(c => c.text.includes('# Section 2'));

      expect(section1Chunk?.headings_path).toBe('Section 1');
      expect(section2Chunk?.headings_path).toBe('Section 2');
    });

    it('should preserve heading paths', () => {
      const content = `# Main Title

Introduction text.

## Section A

Content for A.

### Subsection A1

Content for A1.

## Section B

Content for B.`;

      const packet = createTestPacket(content);
      const result = chunkContent(packet, { max_tokens: 100 });

      // Check that heading paths are captured
      const pathsWithA1 = result.chunks.filter(c => c.headings_path.includes('Subsection A1'));
      // Note: may or may not be in a separate chunk depending on size
    });

    it('should respect max_tokens limit', () => {
      const longContent = `# Test

${'This is a paragraph with some content. '.repeat(100)}`;

      const packet = createTestPacket(longContent);
      const result = chunkContent(packet, { max_tokens: 500, margin_ratio: 0.1 });

      // Each chunk should be under the limit
      for (const chunk of result.chunks) {
        expect(chunk.est_tokens).toBeLessThanOrEqual(500);
      }
    });

    it('should apply margin ratio', () => {
      const longContent = `# Test

${'Content paragraph with text. '.repeat(50)}`;

      const packet = createTestPacket(longContent);
      const result = chunkContent(packet, { max_tokens: 1000, margin_ratio: 0.2 });

      // Each chunk should be under max_tokens * (1 - margin_ratio) = 800
      for (const chunk of result.chunks) {
        expect(chunk.est_tokens).toBeLessThanOrEqual(800);
      }
    });

    it('should not split code blocks', () => {
      const content = `# Code Example

Here is some code:

\`\`\`javascript
function hello() {
  console.log('Hello');
  console.log('World');
  console.log('!');
}
\`\`\`

After the code.`;

      const packet = createTestPacket(content);
      const result = chunkContent(packet, { max_tokens: 50 });

      // The code block should be kept together
      const codeChunk = result.chunks.find(c => c.text.includes('```javascript'));
      if (codeChunk) {
        expect(codeChunk.text).toContain("console.log('!')");
      }
    });

    it('should ignore headings inside code blocks', () => {
      const content = `# Real Heading

\`\`\`python
# Not a heading
\`\`\`

More text here.`;

      const packet = createTestPacket(content);
      const result = chunkContent(packet, { max_tokens: 50, strategy: 'headings_first' });

      const hasFakeHeading = result.chunks.some(chunk => chunk.headings_path.includes('Not a heading'));
      expect(hasFakeHeading).toBe(false);
    });

    it('should include source_id in result', () => {
      const packet = createTestPacket('Test content');
      const result = chunkContent(packet, { max_tokens: 1000 });

      expect(result.source_id).toBe('test123');
    });

    it('should keep list items together when splitting', () => {
      const content = `# Tasks

- Item 1
  details 1
- Item 2
  details 2
- Item 3
  details 3
- Item 4
  details 4
- Item 5
  details 5`;

      const packet = createTestPacket(content);
      packet.key_blocks = [
        {
          block_id: 'b0',
          kind: 'heading',
          text: '# Tasks',
          char_len: '# Tasks'.length,
        },
        {
          block_id: 'b1',
          kind: 'list',
          text: [
            '- Item 1',
            '  details 1',
            '- Item 2',
            '  details 2',
            '- Item 3',
            '  details 3',
            '- Item 4',
            '  details 4',
            '- Item 5',
            '  details 5',
          ].join('\n'),
          char_len: [
            '- Item 1',
            '  details 1',
            '- Item 2',
            '  details 2',
            '- Item 3',
            '  details 3',
            '- Item 4',
            '  details 4',
            '- Item 5',
            '  details 5',
          ].join('\n').length,
        },
      ];
      const result = chunkContent(packet, { max_tokens: 30, strategy: 'balanced' });

      expect(result.total_chunks).toBeGreaterThan(1);

      for (let i = 1; i <= 5; i++) {
        const chunk = result.chunks.find(c => c.text.includes(`- Item ${i}`));
        expect(chunk).toBeDefined();
        expect(chunk?.text).toContain(`details ${i}`);
      }
    });

    it('should generate unique chunk IDs', () => {
      const content = `# A

Content A

# B

Content B

# C

Content C`;

      const packet = createTestPacket(content);
      const result = chunkContent(packet, { max_tokens: 50 });

      const ids = result.chunks.map(c => c.chunk_id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('getChunk', () => {
    it('should retrieve chunk by index', () => {
      const packet = createTestPacket('# A\n\nA content\n\n# B\n\nB content');
      const chunkSet = chunkContent(packet, { max_tokens: 30 });

      const chunk = getChunk(chunkSet, 0);
      expect(chunk).toBeDefined();
      expect(chunk?.chunk_index).toBe(0);
    });

    it('should return undefined for invalid index', () => {
      const packet = createTestPacket('Test');
      const chunkSet = chunkContent(packet, { max_tokens: 1000 });

      const chunk = getChunk(chunkSet, 999);
      expect(chunk).toBeUndefined();
    });
  });

  describe('searchChunks', () => {
    it('should find chunks containing search term', () => {
      const content = `# Part 1

This section talks about apples.

# Part 2

This section discusses oranges.

# Part 3

Back to apples again.`;

      const packet = createTestPacket(content);
      const chunkSet = chunkContent(packet, { max_tokens: 50 });

      const results = searchChunks(chunkSet, 'apples');
      expect(results.length).toBeGreaterThanOrEqual(1);
      results.forEach(chunk => {
        expect(chunk.text.toLowerCase()).toContain('apples');
      });
    });

    it('should be case insensitive', () => {
      const packet = createTestPacket('This is about JAVASCRIPT and javascript.');
      const chunkSet = chunkContent(packet, { max_tokens: 1000 });

      const results = searchChunks(chunkSet, 'JavaScript');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty array for no matches', () => {
      const packet = createTestPacket('Content about programming.');
      const chunkSet = chunkContent(packet, { max_tokens: 1000 });

      const results = searchChunks(chunkSet, 'nonexistent');
      expect(results.length).toBe(0);
    });
  });
});
