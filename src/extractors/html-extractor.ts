/**
 * HTML Content Extractor
 *
 * Extracts readable content from HTML using Readability,
 * then converts to Markdown-ish format using Turndown.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { sanitizeDOM, detectPaywall } from '../security/content-sanitizer.js';
import type { ExtractedContent, ExtractionOptions } from '../types.js';

// Configure Turndown
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
});

// Add GFM support (tables, strikethrough, etc.)
turndownService.use(gfm);

// Custom rules for better output
turndownService.addRule('removeEmptyParagraphs', {
  filter: (node) => {
    return node.nodeName === 'P' && node.textContent?.trim() === '';
  },
  replacement: () => '',
});

turndownService.addRule('preserveLineBreaksInPre', {
  filter: ['pre'],
  replacement: (content, node) => {
    const code = node.textContent || '';
    // Detect language from class
    const codeEl = node.querySelector('code');
    const className = codeEl?.className || '';
    const langMatch = className.match(/language-(\w+)/);
    const lang = langMatch ? langMatch[1] : '';
    return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
  },
});

// Better table handling
turndownService.addRule('tableCells', {
  filter: ['th', 'td'],
  replacement: (content, node) => {
    // Escape pipes in cell content
    const cleanContent = content.replace(/\|/g, '\\|').trim();
    return ` ${cleanContent} |`;
  },
});

export interface HtmlExtractionResult {
  success: boolean;
  content?: ExtractedContent;
  markdown?: string;
  error?: string;
  warnings: string[];
  isPaywalled: boolean;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function shouldUseReadability(readability: ExtractedContent, fallback: ExtractedContent): boolean {
  const readabilityWords = countWords(readability.textContent || '');
  const fallbackWords = countWords(fallback.textContent || '');

  if (readabilityWords === 0) {
    return false;
  }

  if (fallbackWords === 0) {
    return true;
  }

  if (fallbackWords >= 600 && readabilityWords / fallbackWords < 0.35) {
    return false;
  }

  if (fallbackWords >= 300 && readabilityWords < 120) {
    return false;
  }

  return true;
}

/**
 * Extract content from HTML
 */
export function extractHtml(
  html: string,
  baseUrl: string,
  options: ExtractionOptions = {}
): HtmlExtractionResult {
  const {
    prefer_readability = true,
    keep_tables = true,
    keep_code_blocks = true,
    remove_selectors = [],
  } = options;

  const warnings: string[] = [];

  try {
    // Parse HTML
    const dom = new JSDOM(html, {
      url: baseUrl,
    });

    // Check for paywall before sanitization
    const isPaywalled = detectPaywall(dom);
    if (isPaywalled) {
      warnings.push('Content appears to be paywalled');
    }

    // Sanitize DOM
    sanitizeDOM(dom, {
      removeBoilerplate: true,
      removeHiddenContent: true,
      removeComments: true,
      customRemoveSelectors: remove_selectors,
    });

    // Extract metadata from head
    const doc = dom.window.document;
    const title =
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
      doc.querySelector('title')?.textContent ||
      '';

    const siteName =
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
      '';

    const author =
      doc.querySelector('meta[name="author"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="article:author"]')?.getAttribute('content') ||
      '';

    const publishedTime =
      doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
      doc.querySelector('time[datetime]')?.getAttribute('datetime') ||
      '';

    const lang = doc.documentElement.lang || '';

    // Try Readability extraction
    let readabilityContent: ExtractedContent | null = null;

    if (prefer_readability) {
      // Clone DOM for Readability (it modifies the document)
      const clonedDom = new JSDOM(dom.serialize(), { url: baseUrl });
      const reader = new Readability(clonedDom.window.document, {
        charThreshold: 100,
      });
      const article = reader.parse();

      if (article) {
        readabilityContent = {
          title: article.title || title,
          content: article.content,
          textContent: article.textContent,
          excerpt: article.excerpt,
          byline: article.byline || author,
          siteName: article.siteName || siteName,
          lang: article.lang || lang,
          publishedTime,
        };
      } else {
        warnings.push('Readability extraction failed, using fallback');
      }
    }

    const body = doc.body;
    const mainContent = doc.querySelector('main, article, [role="main"]') || body;

    const fallbackContent: ExtractedContent = {
      title,
      content: mainContent?.innerHTML || '',
      textContent: mainContent?.textContent || '',
      excerpt: (mainContent?.textContent || '').substring(0, 200),
      byline: author,
      siteName,
      lang,
      publishedTime,
    };

    let extractedContent: ExtractedContent = fallbackContent;

    if (readabilityContent) {
      if (shouldUseReadability(readabilityContent, fallbackContent)) {
        extractedContent = readabilityContent;
      } else {
        warnings.push('Readability content too short, using fallback');
      }
    }

    // Convert HTML content to Markdown
    let markdown: string;

    if (extractedContent.content) {
      // Create a clean DOM for conversion
      const contentDom = new JSDOM(extractedContent.content, { url: baseUrl });

      // Remove tables if not wanted
      if (!keep_tables) {
        const tables = contentDom.window.document.querySelectorAll('table');
        tables.forEach(t => {
          const placeholder = contentDom.window.document.createElement('p');
          placeholder.textContent = '[Table content removed]';
          t.replaceWith(placeholder);
        });
      }

      // Remove code blocks if not wanted
      if (!keep_code_blocks) {
        const codeBlocks = contentDom.window.document.querySelectorAll('pre, code');
        codeBlocks.forEach(c => {
          if (c.tagName === 'PRE') {
            const placeholder = contentDom.window.document.createElement('p');
            placeholder.textContent = '[Code block removed]';
            c.replaceWith(placeholder);
          }
        });
      }

      markdown = turndownService.turndown(contentDom.window.document.body);
    } else {
      markdown = extractedContent.textContent;
    }

    // Clean up markdown
    markdown = cleanMarkdown(markdown);

    return {
      success: true,
      content: extractedContent,
      markdown,
      warnings,
      isPaywalled,
    };

  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error during HTML extraction',
      warnings,
      isPaywalled: false,
    };
  }
}

/**
 * Clean up extracted markdown
 */
function cleanMarkdown(md: string): string {
  return md
    // Remove excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    // Remove trailing whitespace
    .replace(/[ \t]+$/gm, '')
    // Normalize bullet points
    .replace(/^[•◦▪▸►]\s*/gm, '- ')
    // Clean up link formatting
    .replace(/\[([^\]]+)\]\(\s*\)/g, '$1')
    // Remove empty headers
    .replace(/^#{1,6}\s*$/gm, '')
    // Trim
    .trim();
}

/**
 * Extract headings from HTML for outline generation
 */
export function extractHeadings(html: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];

  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const headingElements = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');

    headingElements.forEach(el => {
      const level = parseInt(el.tagName.charAt(1), 10);
      const text = el.textContent?.trim() || '';

      if (text) {
        headings.push({ level, text });
      }
    });
  } catch {
    // Return empty array on error
  }

  return headings;
}

/**
 * Extract metadata from HTML head
 */
export function extractMetadata(html: string): Record<string, string | null> {
  const metadata: Record<string, string | null> = {};

  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    metadata['title'] = doc.querySelector('title')?.textContent || null;
    metadata['og:title'] = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || null;
    metadata['og:description'] = doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || null;
    metadata['og:site_name'] = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content') || null;
    metadata['og:image'] = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
    metadata['description'] = doc.querySelector('meta[name="description"]')?.getAttribute('content') || null;
    metadata['author'] = doc.querySelector('meta[name="author"]')?.getAttribute('content') || null;
    metadata['article:published_time'] = doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || null;
    metadata['canonical'] = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || null;
    metadata['lang'] = doc.documentElement.lang || null;
  } catch {
    // Return partial metadata on error
  }

  return metadata;
}
