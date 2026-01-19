/**
 * URL utilities for normalization and validation
 */

// Tracking query parameters to strip
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'twclid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'ref',
  'ref_src',
  'source',
  'click_id',
  'affiliate_id',
  'partner_id',
]);

/**
 * Normalize a URL by removing tracking parameters
 */
export function normalizeUrl(urlString: string): string {
  try {
    const url = new URL(urlString);

    // Remove tracking parameters
    for (const param of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(param.toLowerCase())) {
        url.searchParams.delete(param);
      }
    }

    // Sort remaining parameters for consistency
    url.searchParams.sort();

    // Remove trailing slash from path (unless it's the root)
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    // Remove default ports
    if ((url.protocol === 'http:' && url.port === '80') ||
        (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }

    // Lowercase hostname
    url.hostname = url.hostname.toLowerCase();

    return url.toString();
  } catch {
    return urlString;
  }
}

/**
 * Check if URL uses allowed protocol
 */
export function isAllowedProtocol(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Extract hostname from URL
 */
export function getHostname(urlString: string): string | null {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

/**
 * Get the origin of a URL
 */
export function getOrigin(urlString: string): string | null {
  try {
    return new URL(urlString).origin;
  } catch {
    return null;
  }
}

/**
 * Check if two URLs have the same origin
 */
export function sameOrigin(url1: string, url2: string): boolean {
  const origin1 = getOrigin(url1);
  const origin2 = getOrigin(url2);
  return origin1 !== null && origin1 === origin2;
}

/**
 * Resolve a relative URL against a base URL
 */
export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/**
 * Detect content type from URL extension
 */
export function detectContentTypeFromUrl(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    const pathname = url.pathname.toLowerCase();

    if (pathname.endsWith('.md') || pathname.endsWith('.markdown')) {
      return 'text/markdown';
    }
    if (pathname.endsWith('.txt')) {
      return 'text/plain';
    }
    if (pathname.endsWith('.pdf')) {
      return 'application/pdf';
    }
    if (pathname.endsWith('.json')) {
      return 'application/json';
    }
    if (pathname.endsWith('.xml')) {
      return 'application/xml';
    }
    if (pathname.endsWith('.rss')) {
      return 'application/rss+xml';
    }
    if (pathname.endsWith('.atom')) {
      return 'application/atom+xml';
    }
    if (pathname.endsWith('.html') || pathname.endsWith('.htm')) {
      return 'text/html';
    }

    return null;
  } catch {
    return null;
  }
}
