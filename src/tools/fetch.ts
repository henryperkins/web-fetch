/**
 * Fetch Tool
 *
 * Main tool for fetching and extracting content from URLs or raw bytes.
 */

import { randomUUID } from 'crypto';
import type {
  AiSearchOptions,
  ExtractionOptions,
  FetchMode,
  FetchOptions,
  FormatOptions,
  LLMPacket,
  NormalizedContent,
  RawFetchResult,
  RenderOptions,
} from '../types.js';
import type { AiSearchIngestResult } from '../ai-search/index.js';
import { httpFetchWithRetry, type HttpFetchError } from '../fetcher/http-fetcher.js';
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
  options?: FetchOptions;
}

export interface FetchToolOutput {
  success: boolean;
  request_id: string;
  duration_ms: number;
  retry_count: number;
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
type FetchToolOutputBase = Omit<FetchToolOutput, 'request_id' | 'duration_ms' | 'retry_count'>;

interface RuntimeFetchOptions {
  url?: string;
  raw_bytes?: Buffer;
  content_type?: string;
  canonical_url?: string;
  mode: FetchMode;
  headers?: Record<string, string>;
  timeout_ms?: number;
  max_bytes?: number;
  max_redirects?: number;
  user_agent?: string;
  respect_robots?: boolean;
  cache_ttl_s?: number;
  render_requested: boolean;
  render: RenderOptions;
  extraction?: ExtractionOptions;
  format?: FormatOptions;
  ai_search?: AiSearchOptions;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function hasDefinedValue(record: Record<string, unknown>): boolean {
  return Object.values(record).some(value => value !== undefined);
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

function buildFetchErrorDetails(error: HttpFetchError): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {};
  if (error.url) {
    details['url'] = error.url;
  }
  if (typeof error.statusCode === 'number') {
    details['status_code'] = error.statusCode;
  }
  if (error.retryAfter !== undefined) {
    details['retry_after'] = error.retryAfter;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function resolveRenderOptions(options: FetchOptions): { requested: boolean; render?: RenderOptions } {
  const nestedRender = typeof options.render === 'object' && options.render !== null
    ? options.render
    : undefined;
  const requested = options.render === true || nestedRender !== undefined;
  const renderOptions: RenderOptions = {
    wait_until: options.render_wait_until ?? nestedRender?.wait_until,
    wait_ms: options.render_wait_ms ?? nestedRender?.wait_ms,
    block_third_party: options.render_block_third_party ?? nestedRender?.block_third_party,
    screenshot: options.render_screenshot ?? nestedRender?.screenshot,
    selector: options.render_selector ?? nestedRender?.selector,
  };

  return {
    requested,
    render: hasDefinedValue(renderOptions as Record<string, unknown>) ? renderOptions : undefined,
  };
}

function resolveExtractionOptions(options: FetchOptions): ExtractionOptions | undefined {
  const extraction: ExtractionOptions = {
    prefer_readability: options.extraction?.prefer_readability ?? options.extract_readability,
    keep_tables: options.extraction?.keep_tables ?? options.extract_tables,
    keep_code_blocks: options.extraction?.keep_code_blocks ?? options.extract_code_blocks,
    remove_selectors: options.extraction?.remove_selectors ?? options.extract_remove_selectors,
  };

  return hasDefinedValue(extraction as Record<string, unknown>) ? extraction : undefined;
}

function resolveFormatOptions(options: FetchOptions): FormatOptions | undefined {
  const format: FormatOptions = {
    output: options.format?.output,
    include_raw_excerpt: options.format?.include_raw_excerpt ?? options.include_raw_excerpt,
  };

  return hasDefinedValue(format as Record<string, unknown>) ? format : undefined;
}

function resolveAiSearchOptions(options: FetchOptions): AiSearchOptions | undefined {
  const aliasQuery = options.search_query
    ? {
        query: options.search_query,
        mode: options.search_mode,
        rewrite_query: options.search_rewrite_query,
        max_num_results: options.search_max_results,
      }
    : undefined;

  if (options.ai_search) {
    return {
      ...options.ai_search,
      thread_key: options.ai_search.thread_key ?? options.search_thread_key,
      query: options.ai_search.query ?? aliasQuery,
    };
  }

  if (!aliasQuery && options.search_thread_key === undefined) {
    return undefined;
  }

  return {
    enabled: true,
    thread_key: options.search_thread_key,
    query: aliasQuery,
  };
}

function normalizeFetchOptions(options: FetchOptions): RuntimeFetchOptions {
  const render = resolveRenderOptions(options);
  const extraction = resolveExtractionOptions(options);
  const format = resolveFormatOptions(options);
  const aiSearch = resolveAiSearchOptions(options);

  return {
    url: options.url,
    raw_bytes: options.raw_bytes,
    content_type: options.content_type,
    canonical_url: options.canonical_url,
    mode: options.mode ?? 'auto',
    headers: options.headers,
    timeout_ms: options.timeout_ms,
    max_bytes: options.max_bytes,
    max_redirects: options.max_redirects,
    user_agent: options.user_agent,
    respect_robots: options.respect_robots,
    cache_ttl_s: options.cache_ttl_s,
    render_requested: render.requested,
    render: render.render ?? {},
    extraction,
    format,
    ai_search: aiSearch,
  };
}

async function fetchWithRender(
  url: string,
  config: ReturnType<typeof getConfig>,
  options: RuntimeFetchOptions
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
    wait_until: options.render.wait_until,
    wait_ms: options.render.wait_ms,
    block_third_party: options.render.block_third_party,
    screenshot: options.render.screenshot,
    selector: options.render.selector,
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
 * Execute the fetch tool.
 */
export async function executeFetch(input: FetchToolInput): Promise<FetchToolOutput> {
  const rawOptions = input.options ?? {};
  const options = normalizeFetchOptions(rawOptions);
  const config = getConfig();
  const requestId = randomUUID();
  const startTime = Date.now();
  let retryCount = 0;

  const withDiagnostics = (output: FetchToolOutputBase): FetchToolOutput => ({
    ...output,
    request_id: requestId,
    duration_ms: Date.now() - startTime,
    retry_count: retryCount,
  });

  const {
    url,
    raw_bytes,
    content_type,
    canonical_url,
    mode,
    headers,
    timeout_ms,
    max_bytes,
    max_redirects,
    user_agent,
    respect_robots,
    cache_ttl_s,
    render_requested,
    extraction,
    format,
    ai_search,
  } = options;
  const wantsScreenshot = options.render.screenshot === true;

  if ((url && raw_bytes) || (!url && !raw_bytes)) {
    return withDiagnostics({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Provide exactly one of url or raw_bytes',
      },
    });
  }

  try {
    let rawResult: RawFetchResult | null = null;
    let screenshot: Buffer | undefined;
    let usedRender = false;
    let lastRenderError: FetchToolError | undefined;
    let sourceUrl = url ?? canonical_url ?? 'unknown://source';

    if (raw_bytes) {
      const effectiveContentType = content_type || 'application/octet-stream';
      rawResult = {
        status: 200,
        headers: {
          'content-type': effectiveContentType,
        },
        body: raw_bytes,
        finalUrl: sourceUrl,
        contentType: effectiveContentType,
      };
    } else {
      sourceUrl = url!;

      let useRender = mode === 'render' || render_requested;
      if (mode === 'auto' && !useRender) {
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

        const hostname = new URL(sourceUrl).hostname.toLowerCase();
        useRender = jsHeavySites.some(site =>
          hostname === site || hostname.endsWith(`.${site}`)
        );

        if (useRender && !config.playwrightEnabled) {
          useRender = false;
        }
      }

      const tryRender = async (): Promise<{ success: true; result: RawFetchResult; screenshot?: Buffer } | { success: false }> => {
        const renderResult = await fetchWithRender(sourceUrl, config, options);
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
          if (mode !== 'auto' || render_requested) {
            return withDiagnostics({
              success: false,
              error: lastRenderError,
            });
          }
        } else {
          rawResult = renderAttempt.result;
          screenshot = renderAttempt.screenshot;
          usedRender = true;
        }
      }

      if (!rawResult) {
        const httpResult = await httpFetchWithRetry(sourceUrl, {
          headers,
          timeout_ms,
          max_bytes,
          max_redirects,
          user_agent,
          respect_robots,
          cache_ttl_s,
        });
        retryCount = Math.max(0, httpResult.attempts - 1);

        if (!httpResult.success) {
          return withDiagnostics({
            success: false,
            error: {
              code: httpResult.error.code,
              message: httpResult.error.message,
              details: buildFetchErrorDetails(httpResult.error),
            },
          });
        }

        rawResult = httpResult.result;
      }

      if (format?.output === 'raw') {
        return withDiagnostics({
          success: true,
          raw: {
            bytes_length: rawResult.body.length,
            content_type: rawResult.contentType,
            headers: rawResult.headers,
          },
        });
      }

      let normalizeResult = await normalizeContent(rawResult, sourceUrl, {
        extraction,
        format,
      });

      if (!normalizeResult.success || !normalizeResult.packet) {
        if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
          const renderAttempt = await tryRender();
          if (renderAttempt.success) {
            const renderNormalize = await normalizeContent(renderAttempt.result, sourceUrl, {
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
          return withDiagnostics({
            success: false,
            error: {
              code: 'EXTRACTION_FAILED',
              message: normalizeResult.error || 'Failed to extract content',
            },
          });
        }
      }

      if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
        if (shouldAttemptRenderFallback(rawResult, normalizeResult.packet)) {
          const renderAttempt = await tryRender();
          if (renderAttempt.success) {
            const renderNormalize = await normalizeContent(renderAttempt.result, sourceUrl, {
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

      const packet = normalizeResult.packet!;

      if (screenshot) {
        packet.screenshot_base64 = screenshot.toString('base64');
      }

      let aiSearchResult: AiSearchIngestResult | undefined;
      const aiSearchEnabled = ai_search?.enabled ?? config.aiSearchEnabled;
      if (aiSearchEnabled) {
        aiSearchResult = await ingestPacketToAiSearch(
          packet,
          ai_search ?? {},
          config
        );

        const aiSearchError = aiSearchResult.error ?? aiSearchResult.query?.error;
        if (aiSearchError && ai_search?.require_success) {
          return withDiagnostics({
            success: false,
            error: {
              code: aiSearchError.code,
              message: aiSearchError.message,
              details: aiSearchError.details,
            },
          });
        }
      }

      const normalizedOutput = format?.output === 'normalized'
        ? toNormalizedContent(packet)
        : undefined;

      storePacketResource(packet);

      return withDiagnostics({
        success: true,
        packet: format?.output === 'normalized' ? undefined : packet,
        normalized: normalizedOutput,
        screenshot_base64: screenshot ? screenshot.toString('base64') : packet.screenshot_base64,
        ai_search: aiSearchResult,
      });
    }

    if (format?.output === 'raw') {
      return withDiagnostics({
        success: true,
        raw: {
          bytes_length: rawResult.body.length,
          content_type: rawResult.contentType,
          headers: rawResult.headers,
        },
      });
    }

    const normalizeResult = await normalizeContent(rawResult, sourceUrl, {
      extraction,
      format,
    });

    if (!normalizeResult.success || !normalizeResult.packet) {
      return withDiagnostics({
        success: false,
        error: {
          code: 'EXTRACTION_FAILED',
          message: normalizeResult.error || 'Failed to extract content',
        },
      });
    }

    const packet = normalizeResult.packet!;
    let aiSearchResult: AiSearchIngestResult | undefined;
    const aiSearchEnabled = ai_search?.enabled ?? config.aiSearchEnabled;
    if (aiSearchEnabled) {
      aiSearchResult = await ingestPacketToAiSearch(
        packet,
        ai_search ?? {},
        config
      );

      const aiSearchError = aiSearchResult.error ?? aiSearchResult.query?.error;
      if (aiSearchError && ai_search?.require_success) {
        return withDiagnostics({
          success: false,
          error: {
            code: aiSearchError.code,
            message: aiSearchError.message,
            details: aiSearchError.details,
          },
        });
      }
    }

    const normalizedOutput = format?.output === 'normalized'
      ? toNormalizedContent(packet)
      : undefined;

    storePacketResource(packet);

    return withDiagnostics({
      success: true,
      packet: format?.output === 'normalized' ? undefined : packet,
      normalized: normalizedOutput,
      ai_search: aiSearchResult,
    });
  } catch (err) {
    return withDiagnostics({
      success: false,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error occurred',
      },
    });
  }
}

/**
 * Get JSON schema for fetch tool input.
 */
export function getFetchInputSchema(): object {
  return {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch. Required unless raw_bytes is provided instead.',
      },
      raw_bytes: {
        type: 'string',
        description: 'Base64-encoded raw bytes to extract from (alternative to url). If provided, url is not required.',
      },
      content_type: {
        type: 'string',
        description: 'Content type of raw_bytes (for example text/html)',
      },
      canonical_url: {
        type: 'string',
        description: 'Canonical URL for raw_bytes input',
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
                description: 'Stable conversation/thread identifier used to scope the knowledge base',
              },
              prefix: {
                type: 'string',
                description: 'Optional prefix for R2 object keys',
              },
              max_file_bytes: {
                type: 'number',
                description: 'Maximum bytes per uploaded file',
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
          url: {
            type: 'string',
            description: 'Deprecated: use the top-level url field instead',
          },
          raw_bytes: {
            type: 'string',
            description: 'Deprecated: use the top-level raw_bytes field instead',
          },
          content_type: {
            type: 'string',
            description: 'Deprecated: use the top-level content_type field instead',
          },
          canonical_url: {
            type: 'string',
            description: 'Deprecated: use the top-level canonical_url field instead',
          },
        },
      },
    },
    required: ['url'],
  };
}
