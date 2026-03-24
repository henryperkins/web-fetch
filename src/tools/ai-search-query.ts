/**
 * AI Search Query Tool
 *
 * Enables querying the accumulated, conversation-scoped knowledge base without
 * requiring a new fetch.
 */

import type { AiSearchQueryResult, AiSearchQueryOptions } from '../ai-search/index.js';
import { queryAiSearchScoped } from '../ai-search/index.js';
import { getConfig } from '../config.js';
import type { Config } from '../types.js';

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
          query: { type: 'string', description: 'Compatibility alias for a single user message' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                role: { type: 'string', enum: ['user', 'system', 'assistant'] },
              },
              required: ['content', 'role'],
            },
          },
          mode: { type: 'string', enum: ['search', 'ai_search'] },
          rewrite_query: { type: 'boolean' },
          stream: { type: 'boolean' },
          max_num_results: { type: 'number' },
          retrieval_type: { type: 'string', enum: ['vector', 'keyword', 'hybrid'] },
          match_threshold: { type: 'number' },
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
          cache: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
          },
          ai_search_options: {
            type: 'object',
            properties: {
              retrieval: {
                type: 'object',
                properties: {
                  filters: { type: 'object' },
                  max_num_results: { type: 'number' },
                  retrieval_type: { type: 'string', enum: ['vector', 'keyword', 'hybrid'] },
                  match_threshold: { type: 'number' },
                },
              },
              cache: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                },
              },
              reranking: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  model: { type: 'string' },
                },
              },
            },
          },
          model: { type: 'string' },
          system_prompt: { type: 'string' },
        },
        anyOf: [
          { required: ['query'] },
          { required: ['messages'] },
        ],
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
