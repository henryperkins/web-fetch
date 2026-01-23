/**
 * Fetch Tool
 *
 * Main tool for fetching and extracting content from URLs.
 */

import type {
  FetchOptions,
  FetchResult,
  LLMPacket,
  NormalizedContent,
  RawFetchResult,
} from '../types.js';
import type { AiSearchIngestResult } from '../ai-search/index.js';
import { httpFetchWithRetry } from '../fetcher/http-fetcher.js';
import { browserRender, isBrowserAvailable } from '../fetcher/browser-renderer.js';
import { applyCrawlDelay, checkRobots } from '../fetcher/robots.js';
import { normalizeContent, toNormalizedContent } from '../processing/normalizer.js';
import { getRateLimiter, waitForRateLimit } from '../security/rate-limiter.js';
import { checkSSRF } from '../security/ssrf-guard.js';
import { getHostname } from '../utils/url.js';
import { getConfig } from '../config.js';
import { ingestPacketToAiSearch } from '../ai-search/index.js';
import { storePacketResource } from '../resources/store.js';

export interface FetchToolInput {
  url: string;
  options?: FetchOptions;
}

export interface FetchToolOutput {
  success: boolean;
  packet?: LLMPacket;
  normalized?: NormalizedContent;
  raw?: {
    bytes_length: number;
    content_type: string;
    headers: Record<string, string>;
  };
  screenshot_base64?: string;
  ai_search?: AiSearchIngestResult;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type FetchToolError = NonNullable<FetchToolOutput['error']>;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function shouldAttemptRenderFallback(
  rawResult: RawFetchResult,
  packet: LLMPacket
): boolean {
  if (!rawResult.contentType.includes('html')) {
    return false;
  }

  const bodyBytes = rawResult.body.length;
  const wordCount = countWords(packet.content);
  const outlineCount = packet.outline.length;

  if (bodyBytes < 5000) {
    return false;
  }

  if (/enable\s+javascript|enable\s+js|requires\s+javascript|turn\s+on\s+javascript/i.test(packet.content)) {
    return true;
  }

  if (wordCount < 40 && bodyBytes >= 5000) {
    return true;
  }

  if (wordCount < 80 && bodyBytes >= 20000) {
    return true;
  }

  if (outlineCount === 0 && wordCount < 200 && bodyBytes >= 10000) {
    return true;
  }

  return false;
}

async function fetchWithRender(
  url: string,
  config: ReturnType<typeof getConfig>,
  options: FetchOptions
): Promise<{ success: true; result: RawFetchResult; screenshot?: Buffer } | { success: false; error: FetchToolError }> {
  const browserAvailable = await isBrowserAvailable();
  if (!browserAvailable) {
    return {
      success: false,
      error: {
        code: 'RENDER_UNAVAILABLE',
        message: 'Browser rendering is not available. Enable PLAYWRIGHT_ENABLED and install Playwright.',
      },
    };
  }

  const effectiveUserAgent = options.user_agent ?? config.userAgent;
  const respectRobots = options.respect_robots ?? config.respectRobots;

  const ssrfCheck = await checkSSRF(url, {
    blockPrivateIp: config.blockPrivateIp,
    allowlistDomains: config.allowlistDomains,
  });

  if (!ssrfCheck.safe) {
    return {
      success: false,
      error: {
        code: 'SSRF_BLOCKED',
        message: ssrfCheck.error || 'Request blocked by SSRF protection',
      },
    };
  }

  if (respectRobots) {
    const robotsResult = await checkRobots(url, {
      timeoutMs: 10000,
      userAgent: effectiveUserAgent,
    });

    if (!robotsResult.allowed) {
      return {
        success: false,
        error: {
          code: 'ROBOTS_BLOCKED',
          message: 'URL is blocked by robots.txt',
        },
      };
    }

    await applyCrawlDelay(new URL(url).origin, robotsResult.crawlDelay, effectiveUserAgent);
  }

  const hostname = getHostname(url);
  if (hostname) {
    const rateLimiter = getRateLimiter(config.rateLimitPerHost);
    const canProceed = await waitForRateLimit(hostname, rateLimiter, 30000);

    if (!canProceed) {
      return {
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Rate limit exceeded for this host',
        },
      };
    }

    rateLimiter.recordRequest(hostname);
  }

  const renderResult = await browserRender(url, {
    wait_until: options.render?.wait_until,
    wait_ms: options.render?.wait_ms,
    block_third_party: options.render?.block_third_party,
    screenshot: options.render?.screenshot,
    selector: options.render?.selector,
    timeout_ms: options.timeout_ms,
    max_bytes: options.max_bytes,
    user_agent: effectiveUserAgent,
  });

  if (!renderResult.success) {
    return {
      success: false,
      error: {
        code: renderResult.error.code,
        message: renderResult.error.message,
      },
    };
  }

  if (respectRobots) {
    const robotsResult = await checkRobots(renderResult.result.finalUrl, {
      timeoutMs: 10000,
      userAgent: effectiveUserAgent,
    });

    if (!robotsResult.allowed) {
      return {
        success: false,
        error: {
          code: 'ROBOTS_BLOCKED',
          message: 'URL is blocked by robots.txt',
        },
      };
    }

    await applyCrawlDelay(new URL(renderResult.result.finalUrl).origin, robotsResult.crawlDelay, effectiveUserAgent);
  }

  return {
    success: true,
    result: renderResult.result,
    screenshot: renderResult.screenshot,
  };
}

/**
 * Execute the fetch tool
 */
export async function executeFetch(input: FetchToolInput): Promise<FetchToolOutput> {
  const { url, options = {} } = input;
  const config = getConfig();

  const {
    mode = 'auto',
    headers,
    timeout_ms,
    max_bytes,
    max_redirects,
    user_agent,
    respect_robots,
    cache_ttl_s,
    extraction,
    format,
  } = options;
  const wantsScreenshot = options.render?.screenshot === true;

  try {
    let rawResult: RawFetchResult | null = null;
    let screenshot: Buffer | undefined;
    let usedRender = false;
    let lastRenderError: FetchToolError | undefined;

    // Determine fetch mode
    let useRender = mode === 'render';

    if (mode === 'auto') {
      // Use render mode for certain domains/patterns that typically need JS
      const jsHeavySites = [
        'twitter.com',
        'x.com',
        'facebook.com',
        'instagram.com',
        'linkedin.com',
        'reddit.com',
        'medium.com',
        'substack.com',
      ];

      const hostname = new URL(url).hostname.toLowerCase();
      useRender = jsHeavySites.some(site =>
        hostname === site || hostname.endsWith('.' + site)
      );

      // Only use render if available
      if (useRender && !config.playwrightEnabled) {
        useRender = false;
      }
    }

    const tryRender = async (): Promise<{ success: true; result: RawFetchResult; screenshot?: Buffer } | { success: false }> => {
      const renderResult = await fetchWithRender(url, config, options);
      if (!renderResult.success) {
        lastRenderError = renderResult.error;
        return { success: false };
      }

      return {
        success: true,
        result: renderResult.result,
        screenshot: renderResult.screenshot,
      };
    };

    if (useRender) {
      const renderAttempt = await tryRender();
      if (!renderAttempt.success) {
        if (mode !== 'auto') {
          return {
            success: false,
            error: lastRenderError,
          };
        }
      } else {
        rawResult = renderAttempt.result;
        screenshot = renderAttempt.screenshot;
        usedRender = true;
      }
    }

    if (!rawResult) {
      const httpResult = await httpFetchWithRetry(url, {
        headers,
        timeout_ms,
        max_bytes,
        max_redirects,
        user_agent,
        respect_robots,
        cache_ttl_s,
      });

      if (!httpResult.success) {
        return {
          success: false,
          error: {
            code: httpResult.error.code,
            message: httpResult.error.message,
            details: httpResult.error.statusCode,
          },
        };
      }

      rawResult = httpResult.result;
    }

    // Check output format
    if (format?.output === 'raw') {
      return {
        success: true,
        raw: {
          bytes_length: rawResult.body.length,
          content_type: rawResult.contentType,
          headers: rawResult.headers,
        },
      };
    }

    let normalizedOutput: NormalizedContent | undefined;

    // Normalize content into LLMPacket
    let normalizeResult = await normalizeContent(rawResult, url, {
      extraction,
      format,
    });

    if (!normalizeResult.success || !normalizeResult.packet) {
      if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
        const renderAttempt = await tryRender();
        if (renderAttempt.success) {
          const renderNormalize = await normalizeContent(renderAttempt.result, url, {
            extraction,
            format,
          });
          if (renderNormalize.success && renderNormalize.packet) {
            normalizeResult = renderNormalize;
            rawResult = renderAttempt.result;
            screenshot = renderAttempt.screenshot;
            usedRender = true;
          }
        }
      }

      if (!normalizeResult.success || !normalizeResult.packet) {
        return {
          success: false,
          error: {
            code: 'EXTRACTION_FAILED',
            message: normalizeResult.error || 'Failed to extract content',
          },
        };
      }
    }

    if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
      if (shouldAttemptRenderFallback(rawResult, normalizeResult.packet)) {
        const renderAttempt = await tryRender();
        if (renderAttempt.success) {
          const renderNormalize = await normalizeContent(renderAttempt.result, url, {
            extraction,
            format,
          });
          if (renderNormalize.success && renderNormalize.packet) {
            normalizeResult = renderNormalize;
            rawResult = renderAttempt.result;
            screenshot = renderAttempt.screenshot;
            usedRender = true;
          }
        }
      }
    }

    if (wantsScreenshot && !screenshot && config.playwrightEnabled) {
      const renderAttempt = await tryRender();
      if (renderAttempt.success) {
        screenshot = renderAttempt.screenshot;
      }
    }

    // Add screenshot if taken
    if (screenshot && normalizeResult.packet) {
      normalizeResult.packet.screenshot_base64 = screenshot.toString('base64');
    }

    let aiSearchResult: AiSearchIngestResult | undefined;
    const aiSearchEnabled = options.ai_search?.enabled ?? config.aiSearchEnabled;
    if (aiSearchEnabled && normalizeResult.packet) {
      aiSearchResult = await ingestPacketToAiSearch(
        normalizeResult.packet,
        options.ai_search ?? {},
        config
      );

      const aiSearchError = aiSearchResult.error ?? aiSearchResult.query?.error;
      if (aiSearchError && options.ai_search?.require_success) {
        return {
          success: false,
          error: {
            code: aiSearchError.code,
            message: aiSearchError.message,
            details: aiSearchError.details,
          },
        };
      }
    }

    if (format?.output === 'normalized' && normalizeResult.packet) {
      normalizedOutput = toNormalizedContent(normalizeResult.packet);
    }

    if (normalizeResult.packet) {
      storePacketResource(normalizeResult.packet);
    }

    return {
      success: true,
      packet: format?.output === 'normalized' ? undefined : normalizeResult.packet,
      normalized: normalizedOutput,
      screenshot_base64: screenshot ? screenshot.toString('base64') : normalizeResult.packet?.screenshot_base64,
      ai_search: aiSearchResult,
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
 * Get JSON schema for fetch tool input
 */
export function getFetchInputSchema(): object {
  return {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      options: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['auto', 'http', 'render'],
            description: 'Fetch mode: auto (detect), http (simple fetch), render (browser)',
            default: 'auto',
          },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Custom HTTP headers',
          },
          timeout_ms: {
            type: 'number',
            description: 'Request timeout in milliseconds',
          },
          max_bytes: {
            type: 'number',
            description: 'Maximum response size in bytes',
          },
          max_redirects: {
            type: 'number',
            description: 'Maximum redirects to follow',
          },
          user_agent: {
            type: 'string',
            description: 'Custom User-Agent header',
          },
          respect_robots: {
            type: 'boolean',
            description: 'Whether to respect robots.txt',
          },
          cache_ttl_s: {
            type: 'number',
            description: 'Cache TTL in seconds for this request (0 to disable)',
          },
          render: {
            type: 'object',
            properties: {
              wait_until: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle'],
              },
              wait_ms: {
                type: 'number',
                description: 'Additional wait time after page load',
              },
              block_third_party: {
                type: 'boolean',
                description: 'Block third-party requests',
              },
              screenshot: {
                type: 'boolean',
                description: 'Take a screenshot',
              },
              selector: {
                type: 'string',
                description: 'Wait for specific CSS selector',
              },
            },
          },
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
          ai_search: {
            type: 'object',
            properties: {
              enabled: {
                type: 'boolean',
                description: 'Upload extracted content to Cloudflare R2 for AI Search indexing',
              },
              thread_key: {
                type: 'string',
                description: 'Stable conversation/thread identifier used to scope the knowledge base (overrides WEB_FETCH_THREAD_KEY)',
              },
              prefix: {
                type: 'string',
                description: 'Optional prefix for R2 object keys',
              },
              max_file_bytes: {
                type: 'number',
                description: 'Maximum bytes per uploaded file (default: 4MB)',
              },
              wait_ms: {
                type: 'number',
                description: 'Optional delay before running AI Search query (ms)',
              },
              skip_if_exists: {
                type: 'boolean',
                description: 'Skip upload if the first part already exists',
              },
              require_success: {
                type: 'boolean',
                description: 'Fail the fetch tool if AI Search upload or query fails',
              },
              query: {
                type: 'object',
                description: 'Optional AI Search query after upload',
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
            },
          },
        },
      },
    },
    required: ['url'],
  };
}
