/**
 * Content Chunker
 *
 * Splits content into semantic chunks that respect context limits
 * while maintaining structural coherence.
 */

import type {
  LLMPacket,
  ChunkSet,
  Chunk,
  ChunkOptions,
  ChunkStrategy,
  BlockKind,
} from '../types.js';
import { estimateTokens } from '../utils/tokens.js';
import { generateChunkId } from '../utils/hash.js';

interface ChunkBoundary {
  type: 'heading' | 'paragraph' | 'code' | 'list' | 'force';
  level?: number;
  position: number;
  headingsPath: string;
}

interface ContentBlock {
  text: string;
  kind: BlockKind;
  headingsPath: string;
  headingLevel?: number;
}

/**
 * Chunk content into manageable pieces
 */
export function chunkContent(
  packet: LLMPacket,
  options: ChunkOptions
): ChunkSet {
  const {
    max_tokens,
    margin_ratio = 0.10,
    strategy = 'headings_first',
  } = options;

  const effectiveMaxTokens = Math.floor(max_tokens * (1 - margin_ratio));
  const content = packet.content;

  const blocks = buildBlocksFromKeyBlocks(packet);
  if (blocks.length > 0) {
    return chunkBlocks(
      packet.source_id,
      blocks,
      max_tokens,
      effectiveMaxTokens,
      strategy,
    );
  }

  // Find chunk boundaries
  const boundaries = findChunkBoundaries(content, strategy);

  // Create chunks
  const chunks: Chunk[] = [];
  let currentChunkStart = 0;
  let currentHeadingsPath = '';
  let chunkIndex = 0;

  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i]!;
    const nextBoundary = boundaries[i + 1];

    // Update headings path
    if (boundary.position === currentChunkStart && boundary.headingsPath) {
      currentHeadingsPath = boundary.headingsPath;
    }

    // Calculate potential chunk
    const chunkEnd = nextBoundary ? nextBoundary.position : content.length;
    const chunkText = content.substring(currentChunkStart, chunkEnd).trim();
    const chunkTokens = estimateTokens(chunkText);

    // Check if we need to split here
    if (chunkTokens > effectiveMaxTokens) {
      // Current chunk is too large, split at previous boundary
      if (i > 0 && boundary.position > currentChunkStart) {
        const splitText = content.substring(currentChunkStart, boundary.position).trim();

        if (splitText) {
          chunks.push(createChunk(
            packet.source_id,
            chunkIndex++,
            splitText,
            currentHeadingsPath,
          ));
        }

        currentChunkStart = boundary.position;
        if (boundary.headingsPath) {
          currentHeadingsPath = boundary.headingsPath;
        }
      } else {
        // Single section is too large, force split within it
        const forceSplitChunks = forceSplitContent(
          chunkText,
          effectiveMaxTokens,
          packet.source_id,
          chunkIndex,
          currentHeadingsPath,
        );

        chunks.push(...forceSplitChunks);
        chunkIndex += forceSplitChunks.length;
        currentChunkStart = chunkEnd;
      }
    }
  }

  // Add remaining content
  if (currentChunkStart < content.length) {
    const remainingText = content.substring(currentChunkStart).trim();
    if (remainingText) {
      // Check if it needs splitting
      const remainingTokens = estimateTokens(remainingText);

      if (remainingTokens > effectiveMaxTokens) {
        const forceSplitChunks = forceSplitContent(
          remainingText,
          effectiveMaxTokens,
          packet.source_id,
          chunkIndex,
          currentHeadingsPath,
        );
        chunks.push(...forceSplitChunks);
      } else {
        chunks.push(createChunk(
          packet.source_id,
          chunkIndex,
          remainingText,
          currentHeadingsPath,
        ));
      }
    }
  }

  // Merge small chunks if possible
  const mergedChunks = mergeSmallChunks(chunks, effectiveMaxTokens);

  // Calculate totals
  const totalEstTokens = mergedChunks.reduce((sum, c) => sum + c.est_tokens, 0);

  return {
    source_id: packet.source_id,
    max_tokens,
    total_chunks: mergedChunks.length,
    total_est_tokens: totalEstTokens,
    chunks: mergedChunks,
  };
}

function buildBlocksFromKeyBlocks(packet: LLMPacket): ContentBlock[] {
  if (!packet.key_blocks || packet.key_blocks.length === 0) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  const pathStack: string[] = [];
  let currentPath = '';

  for (const block of packet.key_blocks) {
    if (!block.text.trim()) {
      continue;
    }

    let blockPath = currentPath;
    let headingLevel: number | undefined;

    if (block.kind === 'heading') {
      const firstLine = block.text.split('\n')[0] ?? '';
      const match = firstLine.match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        headingLevel = match[1]!.length;
        const headingText = match[2]!.trim();
        while (pathStack.length >= headingLevel) {
          pathStack.pop();
        }
        pathStack.push(headingText);
        currentPath = pathStack.join(' > ');
        blockPath = currentPath;
      }
    }

    blocks.push({
      text: block.text.trim(),
      kind: block.kind,
      headingsPath: blockPath,
      headingLevel,
    });
  }

  return blocks;
}

function chunkBlocks(
  sourceId: string,
  blocks: ContentBlock[],
  maxTokens: number,
  effectiveMaxTokens: number,
  strategy: ChunkStrategy
): ChunkSet {
  const chunks: Chunk[] = [];
  let currentBlocks: string[] = [];
  let currentTokens = 0;
  let currentHeadingPath = '';
  let chunkIndex = 0;

  const flush = (): void => {
    if (currentBlocks.length === 0) return;
    const chunkText = currentBlocks.join('\n\n').trim();
    if (chunkText) {
      chunks.push(createChunk(sourceId, chunkIndex++, chunkText, currentHeadingPath));
    }
    currentBlocks = [];
    currentTokens = 0;
  };

  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text);
    const isHeadingStart =
      strategy === 'headings_first' &&
      block.kind === 'heading' &&
      (block.headingLevel ?? 6) <= 3;

    if (isHeadingStart && currentBlocks.length > 0) {
      flush();
    }

    if (blockTokens > effectiveMaxTokens) {
      flush();
      const splitBlocks = splitLargeBlock(block, effectiveMaxTokens);
      for (const splitBlock of splitBlocks) {
        chunks.push(createChunk(sourceId, chunkIndex++, splitBlock, block.headingsPath));
      }
      continue;
    }

    if (currentTokens + blockTokens > effectiveMaxTokens && currentBlocks.length > 0) {
      flush();
    }

    if (currentBlocks.length === 0) {
      currentHeadingPath = block.headingsPath;
    }

    currentBlocks.push(block.text);
    currentTokens += blockTokens;
  }

  flush();

  const totalEstTokens = chunks.reduce((sum, chunk) => sum + chunk.est_tokens, 0);

  return {
    source_id: sourceId,
    max_tokens: maxTokens,
    total_chunks: chunks.length,
    total_est_tokens: totalEstTokens,
    chunks,
  };
}

/**
 * Find natural chunk boundaries in content
 */
function findChunkBoundaries(
  content: string,
  strategy: ChunkStrategy
): ChunkBoundary[] {
  const boundaries: ChunkBoundary[] = [];
  const lines = content.split('\n');
  let position = 0;
  const pathStack: string[] = [];
  let inCodeBlock = false;
  let fenceChar = '';
  let fenceLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Detect code fences (toggle in/out of code blocks)
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1]!;
      const markerChar = fenceMarker[0]!;
      if (!inCodeBlock) {
        inCodeBlock = true;
        fenceChar = markerChar;
        fenceLength = fenceMarker.length;
      } else if (markerChar === fenceChar && fenceMarker.length >= fenceLength) {
        inCodeBlock = false;
        fenceChar = '';
        fenceLength = 0;
      }

      boundaries.push({
        type: 'code',
        position,
        headingsPath: pathStack.join(' > '),
      });

      position += line.length + 1;
      continue;
    }

    if (inCodeBlock) {
      position += line.length + 1;
      continue;
    }

    // Detect headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();

      // Update path stack
      while (pathStack.length >= level) {
        pathStack.pop();
      }
      pathStack.push(text);

      boundaries.push({
        type: 'heading',
        level,
        position,
        headingsPath: pathStack.join(' > '),
      });
    }

    // Detect paragraph breaks (double newline)
    if (line.trim() === '' && i > 0 && lines[i - 1]?.trim() !== '') {
      if (strategy === 'balanced') {
        boundaries.push({
          type: 'paragraph',
          position,
          headingsPath: pathStack.join(' > '),
        });
      }
    }

    position += line.length + 1; // +1 for newline
  }

  // Sort by position
  boundaries.sort((a, b) => a.position - b.position);

  // If headings_first, prioritize heading boundaries
  if (strategy === 'headings_first') {
    // Filter to only include heading boundaries at H2 level or higher
    return boundaries.filter(b =>
      b.type === 'heading' && (b.level ?? 0) <= 3
    );
  }

  return boundaries;
}

/**
 * Create a chunk object
 */
function createChunk(
  sourceId: string,
  index: number,
  text: string,
  headingsPath: string,
): Chunk {
  return {
    chunk_id: generateChunkId(sourceId, index),
    chunk_index: index,
    headings_path: headingsPath,
    est_tokens: estimateTokens(text),
    text,
    char_len: text.length,
  };
}

function splitLargeBlock(block: ContentBlock, maxTokens: number): string[] {
  switch (block.kind) {
    case 'code':
      return splitCodeBlock(block.text, maxTokens);
    case 'list':
      return splitListBlock(block.text, maxTokens);
    case 'table':
      return splitTableBlock(block.text, maxTokens);
    default:
      return splitTextByTokens(block.text, maxTokens);
  }
}

function splitTextByTokens(content: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (estimateTokens(remaining) <= maxTokens) {
      const trimmed = remaining.trim();
      if (trimmed) {
        chunks.push(trimmed);
      }
      break;
    }

    const estimatedChars = Math.floor(maxTokens * 3.5);
    let splitPoint = Math.min(estimatedChars, remaining.length);

    const paragraphEnd = remaining.lastIndexOf('\n\n', splitPoint);
    if (paragraphEnd > splitPoint * 0.7) {
      splitPoint = paragraphEnd;
    } else {
      const sentenceEnd = remaining.substring(0, splitPoint).search(/[.!?]\s+[A-Z][^.!?]*$/);
      if (sentenceEnd > splitPoint * 0.7) {
        splitPoint = sentenceEnd + 1;
      } else {
        const lineEnd = remaining.lastIndexOf('\n', splitPoint);
        if (lineEnd > splitPoint * 0.8) {
          splitPoint = lineEnd;
        }
      }
    }

    const chunkText = remaining.substring(0, splitPoint).trim();
    if (chunkText) {
      chunks.push(chunkText);
    }

    remaining = remaining.substring(splitPoint).trim();
  }

  return chunks;
}

function splitListBlock(content: string, maxTokens: number): string[] {
  const items = splitListItems(content);
  if (items.length === 0) {
    return splitTextByTokens(content, maxTokens);
  }

  const segments: string[] = [];
  let currentItems: string[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const itemTokens = estimateTokens(item);

    if (currentTokens + itemTokens > maxTokens && currentItems.length > 0) {
      segments.push(currentItems.join('\n'));
      currentItems = [];
      currentTokens = 0;
    }

    if (itemTokens > maxTokens) {
      const parts = splitTextByTokens(item, maxTokens);
      segments.push(...parts);
      continue;
    }

    currentItems.push(item);
    currentTokens += itemTokens;
  }

  if (currentItems.length > 0) {
    segments.push(currentItems.join('\n'));
  }

  return segments;
}

function splitListItems(content: string): string[] {
  const lines = content.split('\n');
  const items: string[] = [];
  let current: string[] = [];
  let hasStartedList = false;

  for (const line of lines) {
    if (isListItem(line)) {
      hasStartedList = true;
      if (current.length > 0) {
        items.push(current.join('\n'));
      }
      current = [line];
      continue;
    }

    if (!hasStartedList) {
      continue;
    }

    if (current.length > 0) {
      if (line.trim() === '' || /^\s+/.test(line)) {
        current.push(line);
      } else {
        current.push(line);
      }
    }
  }

  if (current.length > 0) {
    items.push(current.join('\n'));
  }

  return items;
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*+]|[0-9]+[.)])\s+/.test(line);
}

function splitTableBlock(content: string, maxTokens: number): string[] {
  const lines = content.split('\n').filter(line => line.trim().length > 0);
  if (lines.length <= 2) {
    return [content.trim()];
  }

  const separator = lines[1] ?? '';
  const isSeparator = /^\s*\|?[\s:-]+\|/.test(separator);
  if (!isSeparator) {
    return splitTextByTokens(content, maxTokens);
  }

  const header = lines[0] ?? '';
  const rows = lines.slice(2);
  const headerTokens = estimateTokens(`${header}\n${separator}`);
  const rowBudget = maxTokens - headerTokens;

  if (rowBudget <= 0) {
    return splitTextByTokens(content, maxTokens);
  }

  const segments: string[] = [];
  let currentRows: string[] = [];
  let currentTokens = headerTokens;

  for (const row of rows) {
    const rowTokens = estimateTokens(row);
    if (rowTokens > rowBudget) {
      return splitTextByTokens(content, maxTokens);
    }

    if (currentTokens + rowTokens > maxTokens && currentRows.length > 0) {
      segments.push([header, separator, ...currentRows].join('\n'));
      currentRows = [];
      currentTokens = headerTokens;
    }

    currentRows.push(row);
    currentTokens += rowTokens;
  }

  if (currentRows.length > 0) {
    segments.push([header, separator, ...currentRows].join('\n'));
  }

  return segments;
}

function splitCodeBlock(content: string, maxTokens: number): string[] {
  if (estimateTokens(content) <= maxTokens) {
    return [content.trim()];
  }

  const lines = content.split('\n');
  const openingLine = lines[0] ?? '';
  const fenceMatch = openingLine.match(/^\s*(```+|~~~+)\s*(\S*)?/);
  if (!fenceMatch) {
    return splitTextByTokens(content, maxTokens);
  }

  const fence = fenceMatch[1]!;
  const openingFence = openingLine.trim();
  const closingFence = fence;
  const closingIndex = findClosingFence(lines, fence);
  const codeLines = closingIndex > 0 ? lines.slice(1, closingIndex) : lines.slice(1);

  const segments: string[] = [];
  let currentLines: string[] = [];
  let currentTokens = estimateTokens(`${openingFence}\n${closingFence}`);

  for (const line of codeLines) {
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > maxTokens && currentLines.length > 0) {
      segments.push([openingFence, ...currentLines, closingFence].join('\n'));
      currentLines = [];
      currentTokens = estimateTokens(`${openingFence}\n${closingFence}`);
    }

    if (lineTokens > maxTokens - currentTokens) {
      const parts = splitTextByTokens(line, Math.max(10, maxTokens - currentTokens));
      for (const part of parts) {
        segments.push([openingFence, part, closingFence].join('\n'));
      }
      continue;
    }

    currentLines.push(line);
    currentTokens += lineTokens;
  }

  if (currentLines.length > 0) {
    segments.push([openingFence, ...currentLines, closingFence].join('\n'));
  }

  return segments;
}

function findClosingFence(lines: string[], fence: string): number {
  const fenceChar = fence[0] ?? '`';
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i] ?? '';
    const match = line.match(/^\s*(```+|~~~+)/);
    if (!match) {
      continue;
    }
    const candidate = match[1]!;
    if (candidate[0] === fenceChar && candidate.length >= fence.length) {
      return i;
    }
  }
  return -1;
}

/**
 * Force split content that exceeds max tokens
 */
function forceSplitContent(
  content: string,
  maxTokens: number,
  sourceId: string,
  startIndex: number,
  headingsPath: string,
): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = startIndex;
  const parts = splitTextByTokens(content, maxTokens);
  for (const part of parts) {
    chunks.push(createChunk(sourceId, chunkIndex++, part, headingsPath));
  }

  return chunks;
}

/**
 * Merge small adjacent chunks if they fit within limits
 */
function mergeSmallChunks(
  chunks: Chunk[],
  maxTokens: number,
): Chunk[] {
  if (chunks.length <= 1) return chunks;

  const merged: Chunk[] = [];
  let i = 0;

  while (i < chunks.length) {
    const current = chunks[i]!;

    // Check if we can merge with next chunk
    if (i < chunks.length - 1) {
      const next = chunks[i + 1]!;
      const combinedTokens = current.est_tokens + next.est_tokens;

      // Only merge if both are small and same section
      if (combinedTokens < maxTokens * 0.8 &&
          current.est_tokens < maxTokens * 0.3 &&
          current.headings_path === next.headings_path) {
        const mergedText = current.text + '\n\n' + next.text;
        merged.push({
          ...current,
          text: mergedText,
          est_tokens: estimateTokens(mergedText),
          char_len: mergedText.length,
        });
        i += 2;
        continue;
      }
    }

    merged.push(current);
    i++;
  }

  // Re-index chunks
  return merged.map((chunk, index) => ({
    ...chunk,
    chunk_index: index,
    chunk_id: generateChunkId(chunk.chunk_id.split(':')[0]!, index),
  }));
}

/**
 * Get chunk by index
 */
export function getChunk(chunkSet: ChunkSet, index: number): Chunk | undefined {
  return chunkSet.chunks.find(c => c.chunk_index === index);
}

/**
 * Get chunks containing a search term
 */
export function searchChunks(chunkSet: ChunkSet, searchTerm: string): Chunk[] {
  const lowerTerm = searchTerm.toLowerCase();
  return chunkSet.chunks.filter(c =>
    c.text.toLowerCase().includes(lowerTerm)
  );
}
