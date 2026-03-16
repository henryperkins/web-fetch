/**
 * HTML Fetch Integration Tests
 *
 * These tests require network access and test the full pipeline.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { executeFetch } from '../../src/tools/fetch.js';
import { resetConfig } from '../../src/config.js';

describe('HTML Fetch Integration', () => {
  beforeAll(() => {
    // Reset config for tests
    resetConfig();
  });

  // Using httpbin.org for reliable test endpoints
  it('should fetch and extract HTML from httpbin', async () => {
    const result = await executeFetch({
      options: {
        url: 'https://httpbin.org/html',
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(result.success).toBe(true);
    expect(result.packet).toBeDefined();
    expect(result.packet?.content_type).toContain('text/html');
    expect(result.packet?.content).toBeDefined();
    // httpbin.org/html returns a page with "Herman Melville" text
    expect(result.packet?.content).toContain('Herman Melville');
  }, 30000);

  it('should handle 404 errors', async () => {
    const result = await executeFetch({
      options: {
        url: 'https://httpbin.org/status/404',
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('HTTP_404');
  }, 30000);

  it('should follow redirects', async () => {
    const result = await executeFetch({
      options: {
        url: 'https://httpbin.org/redirect/2',
        mode: 'http',
        max_redirects: 5,
        timeout_ms: 30000,
      },
    });

    expect(result.success).toBe(true);
  }, 30000);

  it('should respect max_redirects limit', async () => {
    const result = await executeFetch({
      options: {
        url: 'https://httpbin.org/redirect/5',
        mode: 'http',
        max_redirects: 2,
        timeout_ms: 30000,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOO_MANY_REDIRECTS');
  }, 30000);

  it('should block private IP addresses', async () => {
    const result = await executeFetch({
      options: {
        url: 'http://127.0.0.1:8080',
        mode: 'http',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SSRF_BLOCKED');
  });

  it('should block localhost', async () => {
    const result = await executeFetch({
      options: {
        url: 'http://localhost:8080',
        mode: 'http',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SSRF_BLOCKED');
  });

  it('should include raw excerpt when requested', async () => {
    const result = await executeFetch({
      options: {
        url: 'https://httpbin.org/html',
        mode: 'http',
        include_raw_excerpt: true,
        timeout_ms: 30000,
      },
    });

    expect(result.success).toBe(true);
    expect(result.packet).toBeDefined();
    expect(result.packet?.raw_excerpt).toBeDefined();
    expect(result.packet?.raw_excerpt?.length).toBeGreaterThan(0);
  }, 30000);

  it('should extract metadata from HTML', async () => {
    const result = await executeFetch({
      options: {
        url: 'https://httpbin.org/html',
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(result.success).toBe(true);
    expect(result.packet?.metadata).toBeDefined();
    // httpbin HTML has title
  }, 30000);

  it('should generate outline from headings', async () => {
    const result = await executeFetch({
      options: {
        url: 'https://httpbin.org/html',
        mode: 'http',
        timeout_ms: 30000,
      },
    });

    expect(result.success).toBe(true);
    expect(result.packet?.outline).toBeDefined();
    expect(Array.isArray(result.packet?.outline)).toBe(true);
  }, 30000);
});
