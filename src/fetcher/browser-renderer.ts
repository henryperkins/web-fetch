/**
 * Browser Renderer
 *
 * Uses Playwright to render JavaScript-heavy pages.
 * Implements strict security controls.
 */

import type { Browser, Page, BrowserContext } from 'playwright';
import { checkSSRF } from '../security/ssrf-guard.js';
import { getConfig } from '../config.js';
import type { RawFetchResult, RenderOptions } from '../types.js';

let browser: Browser | null = null;
let browserInitPromise: Promise<Browser> | null = null;

export interface BrowserRenderOptions extends RenderOptions {
  timeout_ms?: number;
  max_bytes?: number;
  user_agent?: string;
}

export interface BrowserRenderError {
  code: string;
  message: string;
  retryable: boolean;
}

export type BrowserRenderResultSuccess = {
  success: true;
  result: RawFetchResult;
  screenshot?: Buffer;
};

export type BrowserRenderResultError = {
  success: false;
  error: BrowserRenderError;
};

export type BrowserRenderResult = BrowserRenderResultSuccess | BrowserRenderResultError;

/**
 * Initialize browser instance lazily
 */
async function initBrowser(): Promise<Browser> {
  if (browser) return browser;

  if (browserInitPromise) return browserInitPromise;

  browserInitPromise = (async () => {
    const config = getConfig();

    if (!config.playwrightEnabled) {
      throw new Error('Playwright is not enabled. Set PLAYWRIGHT_ENABLED=true');
    }

    try {
      // Dynamic import to avoid loading if not needed
      const { chromium } = await import('playwright');

      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--disable-default-apps',
          '--no-first-run',
          '--mute-audio',
        ],
      });

      return browser;
    } catch (err) {
      browserInitPromise = null;
      throw err;
    }
  })();

  return browserInitPromise;
}

/**
 * Close browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    browserInitPromise = null;
  }
}

/**
 * Render a page using headless browser
 */
export async function browserRender(
  url: string,
  options: BrowserRenderOptions = {}
): Promise<BrowserRenderResult> {
  const config = getConfig();

  const {
    wait_until = 'networkidle',
    wait_ms,
    block_third_party = config.renderBlockThirdParty,
    screenshot = false,
    selector,
    timeout_ms = config.renderTimeoutMs,
    max_bytes = config.maxBytes,
    user_agent = config.userAgent,
  } = options;

  // Validate URL protocol
  try {
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return {
        success: false,
        error: {
          code: 'INVALID_PROTOCOL',
          message: 'Only http:// and https:// protocols are allowed for rendering',
          retryable: false,
        },
      };
    }
  } catch {
    return {
      success: false,
      error: {
        code: 'INVALID_URL',
        message: 'Invalid URL format',
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

  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    const browserInstance = await initBrowser();

    // Create isolated context (no persistent storage)
    context = await browserInstance.newContext({
      userAgent: user_agent,
      viewport: { width: 1280, height: 720 },
      javaScriptEnabled: true,
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
      bypassCSP: false,
    });

    page = await context.newPage();

    // Set up request interception
    const targetOrigin = new URL(url).origin;

    await page.route('**/*', async (route, request) => {
      const requestUrl = request.url();

      // Block non-http(s) protocols
      if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) {
        await route.abort('blockedbyclient');
        return;
      }

      // Block downloads
      const resourceType = request.resourceType();
      if (resourceType === 'media' || resourceType === 'font') {
        // Allow but don't wait for these
        await route.continue();
        return;
      }

      // SSRF check for each request
      const requestSsrf = await checkSSRF(requestUrl, {
        blockPrivateIp: config.blockPrivateIp,
        allowlistDomains: config.allowlistDomains,
      });

      if (!requestSsrf.safe) {
        await route.abort('blockedbyclient');
        return;
      }

      // Block third-party if configured
      if (block_third_party) {
        const requestOrigin = new URL(requestUrl).origin;
        if (requestOrigin !== targetOrigin) {
          // Allow CDN resources but block tracking/ads
          const isCommonCDN =
            requestUrl.includes('cdn') ||
            requestUrl.includes('static') ||
            requestUrl.includes('assets');

          const isTracker =
            requestUrl.includes('analytics') ||
            requestUrl.includes('tracking') ||
            requestUrl.includes('pixel') ||
            requestUrl.includes('beacon') ||
            requestUrl.includes('ads') ||
            requestUrl.includes('doubleclick') ||
            requestUrl.includes('googlesyndication') ||
            requestUrl.includes('facebook.net') ||
            requestUrl.includes('twitter.com/i/');

          if (isTracker || (!isCommonCDN && resourceType === 'script')) {
            await route.abort('blockedbyclient');
            return;
          }
        }
      }

      await route.continue();
    });

    // Navigate with timeout
    const waitUntilMap = {
      load: 'load' as const,
      domcontentloaded: 'domcontentloaded' as const,
      networkidle: 'networkidle' as const,
    };

    await page.goto(url, {
      timeout: timeout_ms,
      waitUntil: waitUntilMap[wait_until],
    });

    // Additional wait if specified
    if (wait_ms && wait_ms > 0) {
      await page.waitForTimeout(Math.min(wait_ms, 30000));
    }

    // Wait for specific selector if provided
    if (selector) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
      } catch {
        // Continue even if selector not found
      }
    }

    // Get page content
    const html = await page.content();
    const htmlBuffer = Buffer.from(html, 'utf-8');

    // Check size limit
    if (htmlBuffer.length > max_bytes) {
      return {
        success: false,
        error: {
          code: 'CONTENT_TOO_LARGE',
          message: `Rendered content exceeds ${max_bytes} bytes`,
          retryable: false,
        },
      };
    }

    // Take screenshot if requested
    let screenshotBuffer: Buffer | undefined;
    if (screenshot) {
      screenshotBuffer = await page.screenshot({
        type: 'png',
        fullPage: false,
      });
    }

    const finalUrl = page.url();

    return {
      success: true,
      result: {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
        body: htmlBuffer,
        finalUrl,
        contentType: 'text/html',
      },
      screenshot: screenshotBuffer,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';

    // Check for timeout
    if (message.includes('Timeout') || message.includes('timeout')) {
      return {
        success: false,
        error: {
          code: 'RENDER_TIMEOUT',
          message: 'Page render timed out',
          retryable: true,
        },
      };
    }

    // Check for navigation errors
    if (message.includes('net::ERR_')) {
      return {
        success: false,
        error: {
          code: 'NAVIGATION_ERROR',
          message: `Navigation failed: ${message}`,
          retryable: true,
        },
      };
    }

    return {
      success: false,
      error: {
        code: 'RENDER_ERROR',
        message,
        retryable: false,
      },
    };

  } finally {
    // Always clean up
    if (page) {
      try {
        await page.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    if (context) {
      try {
        await context.close();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Check if browser rendering is available
 */
export async function isBrowserAvailable(): Promise<boolean> {
  const config = getConfig();

  if (!config.playwrightEnabled) {
    return false;
  }

  try {
    await initBrowser();
    return true;
  } catch {
    return false;
  }
}
