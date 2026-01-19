/**
 * HTTP Fetcher
 *
 * Handles all HTTP-based fetching with proper security, rate limiting,
 * and error handling.
 */

import { request, Agent } from 'undici';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'zlib';
import { checkSSRF } from '../security/ssrf-guard.js';
import { getRateLimiter, waitForRateLimit } from '../security/rate-limiter.js';
import { applyCrawlDelay, checkRobots } from './robots.js';
import { getHostname, normalizeUrl, isAllowedProtocol, getOrigin } from '../utils/url.js';
import { getConfig } from '../config.js';
import { getFetchCache } from '../utils/cache.js';
import type { RawFetchResult, Config } from '../types.js';

export interface HttpFetchOptions {
  headers?: Record<string, string>;
  timeout_ms?: number;
  max_bytes?: number;
  max_redirects?: number;
  user_agent?: string;
  respect_robots?: boolean;
  cache_ttl_s?: number;
}

export interface HttpFetchError {
  code: string;
  message: string;
  statusCode?: number;
  retryable: boolean;
}

export type HttpFetchResultSuccess = {
  success: true;
  result: RawFetchResult;
};

export type HttpFetchResultError = {
  success: false;
  error: HttpFetchError;
};

export type HttpFetchResult = HttpFetchResultSuccess | HttpFetchResultError;

// Keep-alive agent for connection pooling
const agent = new Agent({
  keepAliveTimeout: 30000,
  keepAliveMaxTimeout: 60000,
  connections: 50,
});

/**
 * Fetch a URL with all security checks and rate limiting
 */
export async function httpFetch(
  url: string,
  options: HttpFetchOptions = {}
): Promise<HttpFetchResult> {
  const config = getConfig();

  const {
    headers = {},
    timeout_ms = config.timeoutMs,
    max_bytes = config.maxBytes,
    max_redirects = config.maxRedirects,
    user_agent = config.userAgent,
    respect_robots = config.respectRobots,
    cache_ttl_s = config.cacheTtlS,
  } = options;

  const cacheTtlMs = cache_ttl_s && cache_ttl_s > 0 ? cache_ttl_s * 1000 : 0;
  const cacheKey = cacheTtlMs > 0
    ? buildCacheKey(url, headers, user_agent, max_bytes, max_redirects)
    : null;

  // Validate URL protocol
  if (!isAllowedProtocol(url)) {
    return {
      success: false,
      error: {
        code: 'INVALID_PROTOCOL',
        message: 'Only http:// and https:// protocols are allowed',
        retryable: false,
      },
    };
  }

  // SSRF check
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
        retryable: false,
      },
    };
  }

  const origin = getOrigin(url);

  // Robots.txt check
  if (respect_robots) {
    const robotsResult = await checkRobots(url, {
      timeoutMs: 10000,
      userAgent: user_agent,
    });

    if (!robotsResult.allowed) {
      return {
        success: false,
        error: {
          code: 'ROBOTS_BLOCKED',
          message: 'URL is blocked by robots.txt',
          retryable: false,
        },
      };
    }

    if (origin) {
      await applyCrawlDelay(origin, robotsResult.crawlDelay, user_agent);
    }
  }

  if (cacheKey) {
    const cache = getFetchCache(cacheTtlMs);
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        success: true,
        result: cloneRawFetchResult(cached),
      };
    }
  }

  // Rate limiting
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
          retryable: true,
        },
      };
    }

    rateLimiter.recordRequest(hostname);
  }

  // Perform fetch with redirect handling
  let currentUrl = url;
  let redirectCount = 0;
  const visitedUrls = new Set<string>();

  while (redirectCount <= max_redirects) {
    // Check for redirect loops
    if (visitedUrls.has(currentUrl)) {
      return {
        success: false,
        error: {
          code: 'REDIRECT_LOOP',
          message: 'Redirect loop detected',
          retryable: false,
        },
      };
    }
    visitedUrls.add(currentUrl);

    try {
      const response = await request(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': user_agent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          ...headers,
        },
        dispatcher: agent,
        maxRedirections: 0, // We handle redirects manually
        headersTimeout: timeout_ms,
        bodyTimeout: timeout_ms,
      });

      const statusCode = response.statusCode;

      // Handle redirects
      if (statusCode >= 300 && statusCode < 400) {
        const location = response.headers['location'];
        await response.body.dump();

        if (!location || typeof location !== 'string') {
          return {
            success: false,
            error: {
              code: 'INVALID_REDIRECT',
              message: 'Redirect without location header',
              statusCode,
              retryable: false,
            },
          };
        }

        // Resolve relative redirect
        const redirectUrl = new URL(location, currentUrl).toString();

        // SSRF check the redirect target
        const redirectSsrfCheck = await checkSSRF(redirectUrl, {
          blockPrivateIp: config.blockPrivateIp,
          allowlistDomains: config.allowlistDomains,
        });

        if (!redirectSsrfCheck.safe) {
          return {
            success: false,
            error: {
              code: 'SSRF_BLOCKED',
              message: `Redirect to ${redirectUrl} blocked by SSRF protection`,
              retryable: false,
            },
          };
        }

        let redirectCrawlDelay: number | undefined;
        if (respect_robots) {
          const redirectRobots = await checkRobots(redirectUrl, {
            timeoutMs: 10000,
            userAgent: user_agent,
          });

          if (!redirectRobots.allowed) {
            return {
              success: false,
              error: {
                code: 'ROBOTS_BLOCKED',
                message: 'URL is blocked by robots.txt',
                retryable: false,
              },
            };
          }
          redirectCrawlDelay = redirectRobots.crawlDelay;
        }

        const redirectOrigin = getOrigin(redirectUrl);
        if (redirectOrigin) {
          await applyCrawlDelay(redirectOrigin, redirectCrawlDelay, user_agent);
        }

        currentUrl = redirectUrl;
        redirectCount++;
        continue;
      }

      // Handle errors
      if (statusCode >= 400) {
        await response.body.dump();

        const retryable = statusCode === 429 || statusCode >= 500;

        // Handle rate limit response
        if (statusCode === 429 && hostname) {
          const retryAfter = response.headers['retry-after'];
          const retrySeconds = retryAfter ? parseInt(String(retryAfter), 10) : undefined;
          getRateLimiter(config.rateLimitPerHost).recordError(hostname, retrySeconds);
        }

        return {
          success: false,
          error: {
            code: `HTTP_${statusCode}`,
            message: `HTTP ${statusCode} error`,
            statusCode,
            retryable,
          },
        };
      }

      // Read body with size limit
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let truncated = false;

      for await (const chunk of response.body) {
        const bufferChunk = Buffer.from(chunk);
        totalSize += bufferChunk.length;

        if (totalSize > max_bytes) {
          // Truncate at limit
          const remaining = max_bytes - (totalSize - bufferChunk.length);
          if (remaining > 0) {
            chunks.push(bufferChunk.slice(0, remaining));
          }
          truncated = true;
          break;
        }

        chunks.push(bufferChunk);
      }

      let body = Buffer.concat(chunks);

      // Decompress response if needed
      const contentEncodingHeader = response.headers['content-encoding'];
      const contentEncoding = Array.isArray(contentEncodingHeader)
        ? contentEncodingHeader.join(',')
        : contentEncodingHeader;
      const encodings = contentEncoding
        ? contentEncoding.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
        : [];
      const hasDecoding = encodings.some(encoding => encoding !== 'identity');

      if (hasDecoding && truncated) {
        return {
          success: false,
          error: {
            code: 'CONTENT_TOO_LARGE',
            message: `Response exceeds ${max_bytes} bytes`,
            retryable: false,
          },
        };
      }

      if (encodings.length > 0) {
        try {
          for (const encoding of encodings.slice().reverse()) {
            if (encoding === 'identity') continue;

            switch (encoding) {
              case 'gzip':
              case 'x-gzip':
                body = gunzipSync(body, { maxOutputLength: max_bytes });
                break;
              case 'deflate':
              case 'x-deflate':
                body = inflateSync(body, { maxOutputLength: max_bytes });
                break;
              case 'br':
                body = brotliDecompressSync(body, { maxOutputLength: max_bytes });
                break;
              default:
                return {
                  success: false,
                  error: {
                    code: 'UNSUPPORTED_ENCODING',
                    message: `Unsupported content-encoding: ${encoding}`,
                    retryable: false,
                  },
                };
            }
          }
        } catch (err) {
          return {
            success: false,
            error: {
              code: 'DECOMPRESSION_FAILED',
              message: err instanceof Error ? err.message : 'Failed to decompress response',
              retryable: false,
            },
          };
        }
      }

      if (truncated) {
        return {
          success: false,
          error: {
            code: 'CONTENT_TOO_LARGE',
            message: `Response exceeds ${max_bytes} bytes`,
            retryable: false,
          },
        };
      }

      // Extract content type
      const contentTypeHeader = response.headers['content-type'];
      const contentType = Array.isArray(contentTypeHeader)
        ? contentTypeHeader[0] || 'application/octet-stream'
        : contentTypeHeader || 'application/octet-stream';

      // Build headers record
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') {
          responseHeaders[key] = value;
        } else if (Array.isArray(value)) {
          responseHeaders[key] = value.join(', ');
        }
      }
      if (hasDecoding) {
        delete responseHeaders['content-encoding'];
        delete responseHeaders['content-length'];
      }

      const result: RawFetchResult = {
        status: statusCode,
        headers: responseHeaders,
        body,
        finalUrl: currentUrl,
        contentType,
      };

      if (cacheKey && cacheTtlMs > 0) {
        const cache = getFetchCache(cacheTtlMs);
        cache.set(cacheKey, cloneRawFetchResult(result), cacheTtlMs);
      }

      return {
        success: true,
        result,
      };

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      // Check if retryable
      const retryable = message.includes('ECONNREFUSED') ||
                       message.includes('ETIMEDOUT') ||
                       message.includes('ENOTFOUND') ||
                       message.includes('socket hang up');

      if (hostname && retryable) {
        getRateLimiter(config.rateLimitPerHost).recordError(hostname);
      }

      return {
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message,
          retryable,
        },
      };
    }
  }

  return {
    success: false,
    error: {
      code: 'TOO_MANY_REDIRECTS',
      message: `Exceeded maximum redirects (${max_redirects})`,
      retryable: false,
    },
  };
}

/**
 * Retry a fetch with exponential backoff
 */
export async function httpFetchWithRetry(
  url: string,
  options: HttpFetchOptions & { maxRetries?: number } = {}
): Promise<HttpFetchResult> {
  const { maxRetries = 3, ...fetchOptions } = options;

  let lastError: HttpFetchError | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await httpFetch(url, fetchOptions);

    if (result.success) {
      return result;
    }

    lastError = result.error;

    if (!result.error.retryable) {
      return result;
    }

    // Exponential backoff
    if (attempt < maxRetries - 1) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return {
    success: false,
    error: lastError || {
      code: 'UNKNOWN_ERROR',
      message: 'Unknown error after retries',
      retryable: false,
    },
  };
}

function buildCacheKey(
  url: string,
  headers: Record<string, string>,
  userAgent: string,
  maxBytes: number,
  maxRedirects: number,
): string {
  const normalizedUrl = normalizeUrl(url);
  const headerPart = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key.toLowerCase()}:${value}`)
    .join('|');
  return `${normalizedUrl}::${userAgent}::${headerPart}::${maxBytes}::${maxRedirects}`;
}

function cloneRawFetchResult(result: RawFetchResult): RawFetchResult {
  return {
    status: result.status,
    headers: { ...result.headers },
    body: Buffer.from(result.body),
    finalUrl: result.finalUrl,
    contentType: result.contentType,
  };
}
