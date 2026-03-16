/**
 * Extract Tool (Deprecated - use fetch tool instead)
 *
 * This tool is deprecated. Use the fetch tool with raw_bytes option instead.
 * Kept for backward compatibility.
 */

import type {
  LLMPacket,
  NormalizedContent,
} from '../types.js';
import { executeFetch } from './fetch.js';

/** @deprecated Use FetchOptions with url or raw_bytes instead */
export interface ExtractInput {
  url?: string;
  raw_bytes?: Buffer;
  content_type?: string;
  canonical_url?: string;
}

/** @deprecated Use FetchOptions instead */
export interface ExtractOptions {
  extraction?: {
    prefer_readability?: boolean;
    keep_tables?: boolean;
    keep_code_blocks?: boolean;
    remove_selectors?: string[];
  };
  format?: {
    output?: 'llm_packet' | 'raw' | 'normalized';
    include_raw_excerpt?: boolean;
  };
}

export interface ExtractToolInput {
  input: ExtractInput;
  options?: ExtractOptions;
}

export interface ExtractToolOutput {
  success: boolean;
  packet?: LLMPacket;
  normalized?: NormalizedContent;
  raw?: {
    bytes_length: number;
    content_type: string;
    headers: Record<string, string>;
  };
  screenshot_base64?: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Execute the extract tool (deprecated - use fetch instead)
 * @deprecated Use executeFetch with raw_bytes or url option
 */
export async function executeExtract(input: ExtractToolInput): Promise<ExtractToolOutput> {
  const { input: extractInput, options = {} } = input;

  try {
    const fetchResult = await executeFetch({
      options: {
        url: extractInput.url,
        raw_bytes: extractInput.raw_bytes,
        content_type: extractInput.content_type,
        canonical_url: extractInput.canonical_url,
        mode: 'http',
        extraction: options.extraction,
        format: options.format,
      },
    });

    if (!fetchResult.success) {
      return {
        success: false,
        error: fetchResult.error,
      };
    }

    return {
      success: true,
      packet: fetchResult.packet,
      normalized: fetchResult.normalized,
      raw: fetchResult.raw,
      screenshot_base64: fetchResult.screenshot_base64,
    };

  } catch (err) {
    return {
      success: false,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error occurred',
      },
    };
  }
}

/**
 * Get JSON schema for extract tool input
 * @deprecated Use fetch tool schema instead
 */
export function getExtractInputSchema(): object {
  return {
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to fetch and extract from. Consider using the fetch tool instead for the full pipeline (AI Search, caching).',
          },
          raw_bytes: {
            type: 'string',
            description: 'Base64-encoded raw bytes to extract from. Consider using the fetch tool with raw_bytes parameter instead.',
          },
          content_type: {
            type: 'string',
            description: 'Content type of raw_bytes (e.g., text/html)',
          },
          canonical_url: {
            type: 'string',
            description: 'Canonical URL for the content',
          },
        },
        anyOf: [
          { required: ['url'] },
          { required: ['raw_bytes'] },
        ],
      },
      options: {
        type: 'object',
        properties: {
          extraction: {
            type: 'object',
            properties: {
              prefer_readability: {
                type: 'boolean',
                default: true,
              },
              keep_tables: {
                type: 'boolean',
                default: true,
              },
              keep_code_blocks: {
                type: 'boolean',
                default: true,
              },
              remove_selectors: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          format: {
            type: 'object',
            properties: {
              output: {
                type: 'string',
                enum: ['llm_packet', 'raw', 'normalized'],
              },
              include_raw_excerpt: {
                type: 'boolean',
              },
            },
          },
        },
      },
    },
    required: ['input'],
  };
}
