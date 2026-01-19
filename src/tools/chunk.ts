/**
 * Chunk Tool
 *
 * Splits content into manageable chunks for context-limited LLMs.
 */

import type { LLMPacket, ChunkSet, ChunkOptions } from '../types.js';
import { chunkContent } from '../processing/chunker.js';
import { getConfig } from '../config.js';

export interface ChunkToolInput {
  packet: LLMPacket;
  options?: Partial<ChunkOptions>;
}

export interface ChunkToolOutput {
  success: boolean;
  chunks?: ChunkSet;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Execute the chunk tool
 */
export function executeChunk(input: ChunkToolInput): ChunkToolOutput {
  const { packet, options = {} } = input;
  const config = getConfig();

  try {
    const chunkOptions: ChunkOptions = {
      max_tokens: options.max_tokens ?? config.defaultMaxTokens,
      margin_ratio: options.margin_ratio ?? config.chunkMarginRatio,
      strategy: options.strategy ?? 'headings_first',
    };

    const chunks = chunkContent(packet, chunkOptions);

    return {
      success: true,
      chunks,
    };

  } catch (err) {
    return {
      success: false,
      error: {
        code: 'CHUNK_ERROR',
        message: err instanceof Error ? err.message : 'Failed to chunk content',
      },
    };
  }
}

/**
 * Get JSON schema for chunk tool input
 */
export function getChunkInputSchema(): object {
  return {
    type: 'object',
    properties: {
      packet: {
        type: 'object',
        description: 'The LLMPacket to chunk',
        properties: {
          source_id: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['source_id', 'content'],
      },
      options: {
        type: 'object',
        properties: {
          max_tokens: {
            type: 'number',
            description: 'Maximum tokens per chunk',
          },
          margin_ratio: {
            type: 'number',
            description: 'Safety margin ratio (0-0.5)',
            default: 0.10,
          },
          strategy: {
            type: 'string',
            enum: ['headings_first', 'balanced'],
            description: 'Chunking strategy',
            default: 'headings_first',
          },
        },
      },
    },
    required: ['packet'],
  };
}
