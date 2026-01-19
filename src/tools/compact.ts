/**
 * Compact Tool
 *
 * Intelligently compresses content while preserving key information.
 */

import type { LLMPacket, ChunkSet, CompactedPacket, CompactOptions } from '../types.js';
import { compactContent } from '../processing/compactor.js';
import { getConfig } from '../config.js';

export interface CompactToolInput {
  input: LLMPacket | ChunkSet;
  options?: Partial<CompactOptions>;
}

export interface CompactToolOutput {
  success: boolean;
  compacted?: CompactedPacket;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Execute the compact tool
 */
export function executeCompact(input: CompactToolInput): CompactToolOutput {
  const { input: contentInput, options = {} } = input;
  const config = getConfig();

  try {
    const compactOptions: CompactOptions = {
      max_tokens: options.max_tokens ?? config.defaultMaxTokens,
      mode: options.mode ?? 'structural',
      question: options.question,
      preserve: options.preserve ?? ['numbers', 'dates', 'names'],
    };

    const compacted = compactContent(contentInput, compactOptions);

    return {
      success: true,
      compacted,
    };

  } catch (err) {
    return {
      success: false,
      error: {
        code: 'COMPACT_ERROR',
        message: err instanceof Error ? err.message : 'Failed to compact content',
      },
    };
  }
}

/**
 * Get JSON schema for compact tool input
 */
export function getCompactInputSchema(): object {
  return {
    type: 'object',
    properties: {
      input: {
        type: 'object',
        description: 'LLMPacket or ChunkSet to compact',
        oneOf: [
          {
            properties: {
              source_id: { type: 'string' },
              content: { type: 'string' },
              outline: { type: 'array' },
            },
            required: ['source_id', 'content'],
          },
          {
            properties: {
              source_id: { type: 'string' },
              chunks: { type: 'array' },
            },
            required: ['source_id', 'chunks'],
          },
        ],
      },
      options: {
        type: 'object',
        properties: {
          max_tokens: {
            type: 'number',
            description: 'Target maximum tokens for output',
          },
          mode: {
            type: 'string',
            enum: ['structural', 'salience', 'map_reduce', 'question_focused'],
            description: 'Compaction strategy',
            default: 'structural',
          },
          question: {
            type: 'string',
            description: 'Focus question for question_focused mode',
          },
          preserve: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['numbers', 'dates', 'names', 'definitions', 'procedures'],
            },
            description: 'Types of content to preserve',
            default: ['numbers', 'dates', 'names'],
          },
        },
      },
    },
    required: ['input'],
  };
}
