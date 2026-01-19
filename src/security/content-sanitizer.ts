/**
 * Content Sanitization
 *
 * Removes potentially dangerous or irrelevant content from HTML/DOM
 * before extraction. This helps with both security and content quality.
 */

import type { JSDOM } from 'jsdom';

// Elements to completely remove (including their content)
const REMOVE_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',         // Can contain scripts
  'math',        // Can contain scripts
  'canvas',
  'audio',
  'video',
  'source',
  'track',
  'map',
  'area',
  'template',
  'slot',
  'portal',
];

// Elements that are typically boilerplate/navigation
const BOILERPLATE_SELECTORS = [
  'header:not(article header)',
  'footer:not(article footer)',
  'nav',
  'aside',
  '.sidebar',
  '.navigation',
  '.nav',
  '.menu',
  '.header',
  '.footer',
  '.cookie-banner',
  '.cookie-consent',
  '.cookie-notice',
  '.gdpr',
  '.advertisement',
  '.ad',
  '.ads',
  '.advert',
  '.sponsor',
  '.sponsored',
  '.promo',
  '.promotion',
  '.newsletter',
  '.subscribe',
  '.subscription',
  '.social-share',
  '.share-buttons',
  '.related-posts',
  '.related-articles',
  '.recommendations',
  '.comments',
  '.comment-section',
  '.disqus',
  '.popup',
  '.modal',
  '.overlay',
  '.lightbox',
  '.toast',
  '.notification',
  '.alert:not(.alert-important)',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
];

// Attributes to remove for security
const REMOVE_ATTRIBUTES = [
  'onclick',
  'onload',
  'onerror',
  'onmouseover',
  'onmouseout',
  'onmousedown',
  'onmouseup',
  'onkeydown',
  'onkeyup',
  'onkeypress',
  'onfocus',
  'onblur',
  'onchange',
  'onsubmit',
  'onreset',
  'onselect',
  'onabort',
  'ondblclick',
  'ondrag',
  'ondragend',
  'ondragenter',
  'ondragleave',
  'ondragover',
  'ondragstart',
  'ondrop',
  'oncontextmenu',
  'onwheel',
  'onscroll',
  'oncopy',
  'oncut',
  'onpaste',
  'style', // Remove inline styles (can hide content)
];

// Dangerous URL schemes
const DANGEROUS_SCHEMES = [
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
];

export interface SanitizeOptions {
  removeBoilerplate?: boolean;
  removeHiddenContent?: boolean;
  removeComments?: boolean;
  customRemoveSelectors?: string[];
  preserveSelectors?: string[];
}

/**
 * Sanitize a JSDOM document for safe content extraction
 */
export function sanitizeDOM(dom: JSDOM, options: SanitizeOptions = {}): void {
  const {
    removeBoilerplate = true,
    removeHiddenContent = true,
    removeComments = true,
    customRemoveSelectors = [],
    preserveSelectors = [],
  } = options;

  const doc = dom.window.document;

  // Build preserve set if any
  const preserveSet = new Set<Element>();
  for (const selector of preserveSelectors) {
    try {
      const elements = doc.querySelectorAll(selector);
      elements.forEach(el => preserveSet.add(el));
    } catch {
      // Invalid selector, skip
    }
  }

  // Helper to check if element should be preserved
  const shouldPreserve = (el: Element): boolean => {
    if (preserveSet.has(el)) return true;
    for (const preserved of preserveSet) {
      if (preserved.contains(el)) return true;
    }
    return false;
  };

  // Remove dangerous elements
  for (const tagName of REMOVE_ELEMENTS) {
    const elements = doc.querySelectorAll(tagName);
    elements.forEach(el => {
      if (!shouldPreserve(el)) {
        el.remove();
      }
    });
  }

  // Remove boilerplate
  if (removeBoilerplate) {
    const allSelectors = [...BOILERPLATE_SELECTORS, ...customRemoveSelectors];
    for (const selector of allSelectors) {
      try {
        const elements = doc.querySelectorAll(selector);
        elements.forEach(el => {
          if (!shouldPreserve(el)) {
            el.remove();
          }
        });
      } catch {
        // Invalid selector, skip
      }
    }
  }

  // Remove hidden content
  if (removeHiddenContent) {
    const allElements = doc.querySelectorAll('*');
    allElements.forEach(el => {
      if (shouldPreserve(el)) return;

      const computedStyle = dom.window.getComputedStyle?.(el);
      if (computedStyle) {
        if (computedStyle.display === 'none' ||
            computedStyle.visibility === 'hidden' ||
            computedStyle.opacity === '0') {
          el.remove();
          return;
        }
      }

      // Check for hidden via attributes
      if (el.hasAttribute('hidden') ||
          el.getAttribute('aria-hidden') === 'true' ||
          el.getAttribute('data-hidden') === 'true') {
        el.remove();
      }
    });
  }

  // Remove comments
  if (removeComments) {
    removeHTMLComments(doc);
  }

  // Sanitize remaining elements
  const remaining = doc.querySelectorAll('*');
  remaining.forEach(el => {
    // Remove dangerous attributes
    for (const attr of REMOVE_ATTRIBUTES) {
      el.removeAttribute(attr);
    }

    // Sanitize href and src attributes
    sanitizeUrlAttribute(el, 'href');
    sanitizeUrlAttribute(el, 'src');
    sanitizeUrlAttribute(el, 'action');
    sanitizeUrlAttribute(el, 'formaction');
  });
}

/**
 * Remove HTML comments from document
 */
function removeHTMLComments(doc: Document): void {
  const walker = doc.createTreeWalker(
    doc.documentElement,
    128, // NodeFilter.SHOW_COMMENT
    null
  );

  const comments: Comment[] = [];
  let node: Comment | null;
  while ((node = walker.nextNode() as Comment | null)) {
    comments.push(node);
  }

  for (const comment of comments) {
    comment.remove();
  }
}

/**
 * Sanitize a URL attribute
 */
function sanitizeUrlAttribute(el: Element, attrName: string): void {
  const value = el.getAttribute(attrName);
  if (!value) return;

  const lowerValue = value.toLowerCase().trim();
  for (const scheme of DANGEROUS_SCHEMES) {
    if (lowerValue.startsWith(scheme)) {
      el.removeAttribute(attrName);
      return;
    }
  }
}

/**
 * Extract visible text content from HTML, removing all markup
 */
export function extractVisibleText(html: string): string {
  // Simple text extraction without DOM parsing
  // Remove script and style contents
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode HTML entities
  text = decodeHTMLEntities(text);

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Decode common HTML entities
 */
function decodeHTMLEntities(text: string): string {
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&lsquo;': '\u2018',
    '&rsquo;': '\u2019',
    '&ldquo;': '"',
    '&rdquo;': '"',
  };

  let result = text;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replace(new RegExp(entity, 'gi'), char);
  }

  // Handle numeric entities
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  result = result.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return result;
}

/**
 * Check if content appears to be paywalled
 */
export function detectPaywall(dom: JSDOM): boolean {
  const doc = dom.window.document;

  // Common paywall indicators
  const paywallSelectors = [
    '.paywall',
    '.subscription-wall',
    '.metered-paywall',
    '.subscriber-only',
    '.premium-content',
    '[data-paywall]',
    '[data-subscriber-content]',
    '.piano-paywall',
  ];

  for (const selector of paywallSelectors) {
    if (doc.querySelector(selector)) {
      return true;
    }
  }

  // Check for common paywall text patterns
  const bodyText = doc.body?.textContent?.toLowerCase() || '';
  const paywallPhrases = [
    'subscribe to continue reading',
    'this content is for subscribers',
    'to read the full article',
    'sign up to read',
    'premium subscribers only',
    'members-only content',
  ];

  for (const phrase of paywallPhrases) {
    if (bodyText.includes(phrase)) {
      return true;
    }
  }

  return false;
}
