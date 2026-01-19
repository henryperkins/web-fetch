/**
 * Extract Tool
 *
 * Extracts and normalizes content from raw bytes or URLs.
 */

import type {
  ExtractInput,
  ExtractOptions,
  LLMPacket,
  NormalizedContent,
  RawFetchResult,
} from '../types.js';
import { normalizeContent, detectContentType, toNormalizedContent } from '../processing/normalizer.js';
import { executeFetch } from './fetch.js';
import { storePacketResource } from '../resources/store.js';

export interface ExtractToolInput {
  input: ExtractInput;
  options?: ExtractOptions;
}

export interface ExtractToolOutput {
  success: boolean;
  packet?: LLMPacket;
  normalized?: NormalizedContent;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Execute the extract tool
 */
export async function executeExtract(input: ExtractToolInput): Promise<ExtractToolOutput> {
  const { input: extractInput, options = {} } = input;

  try {
    // If URL is provided, fetch first
    if (extractInput.url) {
      const fetchResult = await executeFetch({
        url: extractInput.url,
        options: {
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
      };
    }

    // Extract from raw bytes
    if (extractInput.raw_bytes) {
      const contentType = extractInput.content_type || 'application/octet-stream';
      const canonicalUrl = extractInput.canonical_url || 'unknown://source';

      // Create a fake fetch result
      const rawResult: RawFetchResult = {
        status: 200,
        headers: {
          'content-type': contentType,
        },
        body: extractInput.raw_bytes,
        finalUrl: canonicalUrl,
        contentType,
      };

      const normalizeResult = await normalizeContent(rawResult, canonicalUrl, {
        extraction: options.extraction,
        format: options.format,
      });

      if (!normalizeResult.success || !normalizeResult.packet) {
        return {
          success: false,
          error: {
            code: 'EXTRACTION_FAILED',
            message: normalizeResult.error || 'Failed to extract content',
          },
        };
      }

      storePacketResource(normalizeResult.packet);

      if (options.format?.output === 'normalized') {
        return {
          success: true,
          normalized: toNormalizedContent(normalizeResult.packet),
        };
      }

      return {
        success: true,
        packet: normalizeResult.packet,
      };
    }

    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Either url or raw_bytes must be provided',
      },
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
            description: 'URL to fetch and extract from',
          },
          raw_bytes: {
            type: 'string',
            description: 'Base64-encoded raw bytes to extract from',
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
