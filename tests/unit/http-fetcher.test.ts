import { describe, it, expect, vi, beforeEach } from 'vitest';
import { httpFetch } from '../../src/fetcher/http-fetcher.js';

const requestMock = vi.fn();
const mockCheckSSRF = vi.fn();
const mockCheckRobots = vi.fn();
const mockApplyCrawlDelay = vi.fn();
const mockWaitForRateLimit = vi.fn();
const mockGetRateLimiter = vi.fn();

vi.mock('undici', () => ({
  Agent: class Agent {},
  request: (...args: unknown[]) => requestMock(...args),
}));

vi.mock('../../src/security/ssrf-guard.js', () => ({
  checkSSRF: (...args: unknown[]) => mockCheckSSRF(...args),
}));

vi.mock('../../src/fetcher/robots.js', () => ({
  checkRobots: (...args: unknown[]) => mockCheckRobots(...args),
  applyCrawlDelay: (...args: unknown[]) => mockApplyCrawlDelay(...args),
}));

vi.mock('../../src/security/rate-limiter.js', () => ({
  getRateLimiter: (...args: unknown[]) => mockGetRateLimiter(...args),
  waitForRateLimit: (...args: unknown[]) => mockWaitForRateLimit(...args),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    maxBytes: 1024,
    timeoutMs: 5000,
    maxRedirects: 5,
    userAgent: 'test-agent',
    respectRobots: true,
    blockPrivateIp: true,
    allowlistDomains: [],
    rateLimitPerHost: 60,
    cacheTtlS: 0,
  }),
}));

describe('httpFetch', () => {
  beforeEach(() => {
    requestMock.mockReset();
    mockCheckSSRF.mockReset();
    mockCheckRobots.mockReset();
    mockApplyCrawlDelay.mockReset();
    mockWaitForRateLimit.mockReset();
    mockGetRateLimiter.mockReset();

    mockCheckSSRF.mockResolvedValue({ safe: true });
    mockCheckRobots.mockResolvedValue({ allowed: true, crawlDelay: 0 });
    mockWaitForRateLimit.mockResolvedValue(true);
    mockGetRateLimiter.mockReturnValue({
      recordRequest: vi.fn(),
      recordError: vi.fn(),
    });
    mockApplyCrawlDelay.mockResolvedValue(undefined);
  });

  it('fails when the response is truncated without content encoding', async () => {
    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: {},
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('12345');
          yield Buffer.from('6789');
        },
      },
    });

    const result = await httpFetch('https://example.com', { max_bytes: 5 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONTENT_TOO_LARGE');
  });

  it('blocks redirects that violate robots.txt', async () => {
    mockCheckRobots
      .mockResolvedValueOnce({ allowed: true })  // initial URL
      .mockResolvedValueOnce({ allowed: false }); // redirect target

    requestMock.mockResolvedValue({
      statusCode: 302,
      headers: { location: 'https://blocked.example/path' },
      body: {
        async dump() { /* noop */ },
        async *[Symbol.asyncIterator]() { /* not consumed */ },
      },
    });

    const result = await httpFetch('https://example.com', { max_redirects: 1 });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ROBOTS_BLOCKED');
    expect(mockCheckRobots).toHaveBeenCalledTimes(2);
  });

  it('applies crawl delay when provided by robots.txt', async () => {
    mockCheckRobots.mockResolvedValue({ allowed: true, crawlDelay: 2 });

    requestMock.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('hello');
        },
      },
    });

    const result = await httpFetch('https://example.com/path', { respect_robots: true });

    expect(result.success).toBe(true);
    expect(mockApplyCrawlDelay).toHaveBeenCalledWith('https://example.com', 2, 'test-agent');
  });
});
