/**
 * AI Search Query Tool
 *
 * Enables querying the accumulated, conversation-scoped knowledge base without
 * requiring a new fetch.
 */

import type { AiSearchQueryResult } from '../ai-search/index.js';
import { queryAiSearchScoped } from '../ai-search/index.js';
import { getConfig } from '../config.js';
import type { AiSearchQueryOptions, Config } from '../types.js';

export interface AiSearchQueryToolInput {
  /**
   * The AI Search query options.
   *
   * Note: results are automatically scoped to the configured conversation/workspace.
   */
  query: AiSearchQueryOptions;

  /**
   * Optional stable conversation/thread identifier.
   * If provided, overrides WEB_FETCH_THREAD_KEY for this request.
   */
  thread_key?: string;

  /** Optional config override. */
  config?: Partial<Config>;
}

export interface AiSearchQueryToolOutput {
  success: boolean;
  result?: AiSearchQueryResult;
  error?: {
    code: string;
    message: string;
  };
}

export async function executeAiSearchQuery(input: AiSearchQueryToolInput): Promise<AiSearchQueryToolOutput> {
  try {
    const config = input.config ? { ...getConfig(), ...input.config } : getConfig();
    const result = await queryAiSearchScoped(input.query, config, { thread_key: input.thread_key });

    if (result.error) {
      return {
        success: false,
        result,
        error: result.error,
      };
    }

    return {
      success: true,
      result,
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'AI_SEARCH_QUERY_FAILED',
        message: err instanceof Error ? err.message : 'AI Search query failed',
      },
    };
  }
}

export function getAiSearchQueryInputSchema() {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'object',
        description: 'AI Search query options (auto-scoped to the current conversation/workspace)',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string', enum: ['search', 'ai_search'] },
          rewrite_query: { type: 'boolean' },
          max_num_results: { type: 'number' },
          ranking_options: {
            type: 'object',
            properties: {
              score_threshold: { type: 'number' },
            },
          },
          reranking: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              model: { type: 'string' },
            },
          },
          filters: { type: 'object' },
          model: { type: 'string' },
          system_prompt: { type: 'string' },
        },
        required: ['query'],
      },
      thread_key: {
        type: 'string',
        description: 'Stable conversation/thread identifier used for scoping (overrides WEB_FETCH_THREAD_KEY)',
      },
      config: {
        type: 'object',
        description: 'Optional per-call config overrides',
      },
    },
    required: ['query'],
  };
}
