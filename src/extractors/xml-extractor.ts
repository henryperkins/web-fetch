/**
 * XML/RSS/Atom Content Extractor
 *
 * Parses XML feeds and documents into structured LLM-friendly format.
 */

import { XMLParser } from 'fast-xml-parser';
import type { ExtractedContent } from '../types.js';

export interface FeedItem {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
  author?: string;
  guid?: string;
}

export interface FeedMetadata {
  title: string;
  description?: string;
  link?: string;
  language?: string;
  lastBuildDate?: string;
  itemCount: number;
}

export interface XmlExtractionResult {
  success: boolean;
  content?: ExtractedContent;
  markdown?: string;
  feedMetadata?: FeedMetadata;
  items?: FeedItem[];
  error?: string;
  warnings: string[];
  isFeed: boolean;
}

// Maximum items to include in output
const MAX_FEED_ITEMS = 20;

// XML Parser options
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
  isArray: (name: string) => ['item', 'entry'].includes(name),
};

/**
 * Extract content from XML/RSS/Atom
 */
export function extractXml(
  content: string,
  sourceUrl?: string
): XmlExtractionResult {
  const warnings: string[] = [];

  try {
    const parser = new XMLParser(parserOptions);
    const parsed = parser.parse(content);

    // Detect feed type
    if (parsed.rss) {
      return extractRss(parsed.rss, sourceUrl, warnings);
    }

    if (parsed.feed) {
      return extractAtom(parsed.feed, sourceUrl, warnings);
    }

    // Generic XML
    return extractGenericXml(parsed, sourceUrl, warnings);

  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to parse XML',
      warnings,
      isFeed: false,
    };
  }
}

/**
 * Extract RSS feed content
 */
function extractRss(
  rss: Record<string, unknown>,
  sourceUrl: string | undefined,
  warnings: string[]
): XmlExtractionResult {
  const channel = (rss['channel'] || {}) as Record<string, unknown>;

  const metadata: FeedMetadata = {
    title: getString(channel['title']) || 'RSS Feed',
    description: getString(channel['description']),
    link: getString(channel['link']),
    language: getString(channel['language']),
    lastBuildDate: getString(channel['lastBuildDate']),
    itemCount: 0,
  };

  const rawItems = channel['item'] as unknown[];
  const items: FeedItem[] = [];

  if (Array.isArray(rawItems)) {
    metadata.itemCount = rawItems.length;

    for (const item of rawItems.slice(0, MAX_FEED_ITEMS)) {
      const itemObj = item as Record<string, unknown>;
      items.push({
        title: getString(itemObj['title']) || 'Untitled',
        link: getString(itemObj['link']) || '',
        description: stripHtml(getString(itemObj['description'])),
        pubDate: getString(itemObj['pubDate']),
        author: getString(itemObj['author']) || getString(itemObj['dc:creator']),
        guid: getString(itemObj['guid']),
      });
    }

    if (rawItems.length > MAX_FEED_ITEMS) {
      warnings.push(`Showing ${MAX_FEED_ITEMS} of ${rawItems.length} items`);
    }
  }

  const markdown = generateFeedMarkdown(metadata, items, 'RSS');
  const textContent = generateFeedText(metadata, items);

  return {
    success: true,
    content: {
      title: metadata.title,
      content: markdown,
      textContent,
      excerpt: metadata.description || textContent.substring(0, 300),
      siteName: metadata.title,
    },
    markdown,
    feedMetadata: metadata,
    items,
    warnings,
    isFeed: true,
  };
}

/**
 * Extract Atom feed content
 */
function extractAtom(
  feed: Record<string, unknown>,
  sourceUrl: string | undefined,
  warnings: string[]
): XmlExtractionResult {
  const metadata: FeedMetadata = {
    title: getAtomText(feed['title']) || 'Atom Feed',
    description: getAtomText(feed['subtitle']),
    link: getAtomLink(feed['link']),
    language: getString(feed['@_xml:lang']),
    lastBuildDate: getString(feed['updated']),
    itemCount: 0,
  };

  const rawEntries = feed['entry'] as unknown[];
  const items: FeedItem[] = [];

  if (Array.isArray(rawEntries)) {
    metadata.itemCount = rawEntries.length;

    for (const entry of rawEntries.slice(0, MAX_FEED_ITEMS)) {
      const entryObj = entry as Record<string, unknown>;
      items.push({
        title: getAtomText(entryObj['title']) || 'Untitled',
        link: getAtomLink(entryObj['link']) || '',
        description: stripHtml(getAtomText(entryObj['summary']) || getAtomText(entryObj['content'])),
        pubDate: getString(entryObj['published']) || getString(entryObj['updated']),
        author: getAtomAuthor(entryObj['author']),
        guid: getString(entryObj['id']),
      });
    }

    if (rawEntries.length > MAX_FEED_ITEMS) {
      warnings.push(`Showing ${MAX_FEED_ITEMS} of ${rawEntries.length} entries`);
    }
  }

  const markdown = generateFeedMarkdown(metadata, items, 'Atom');
  const textContent = generateFeedText(metadata, items);

  return {
    success: true,
    content: {
      title: metadata.title,
      content: markdown,
      textContent,
      excerpt: metadata.description || textContent.substring(0, 300),
      siteName: metadata.title,
    },
    markdown,
    feedMetadata: metadata,
    items,
    warnings,
    isFeed: true,
  };
}

/**
 * Extract generic XML content
 */
function extractGenericXml(
  parsed: Record<string, unknown>,
  sourceUrl: string | undefined,
  warnings: string[]
): XmlExtractionResult {
  // Get root element name
  const rootKeys = Object.keys(parsed).filter(k => !k.startsWith('?'));
  const rootName = rootKeys[0] || 'root';

  // Generate a summary of the XML structure
  const structure = summarizeXmlStructure(parsed, 0);
  const markdown = generateXmlMarkdown(rootName, structure, sourceUrl);

  return {
    success: true,
    content: {
      title: `XML Document (${rootName})`,
      content: markdown,
      textContent: markdown,
      excerpt: `XML document with root element <${rootName}>`,
    },
    markdown,
    warnings,
    isFeed: false,
  };
}

/**
 * Summarize XML structure recursively
 */
function summarizeXmlStructure(obj: unknown, depth: number): string {
  if (depth > 4) return '...';

  if (obj === null || obj === undefined) {
    return 'null';
  }

  if (typeof obj !== 'object') {
    const str = String(obj);
    return str.length > 50 ? str.substring(0, 50) + '...' : str;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[${obj.length} items]`;
  }

  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).filter(k => !k.startsWith('@_'));
  const attrs = Object.keys(record).filter(k => k.startsWith('@_'));

  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  for (const key of keys.slice(0, 10)) {
    const value = record[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      lines.push(`${indent}<${key}>`);
      lines.push(summarizeXmlStructure(value, depth + 1));
      lines.push(`${indent}</${key}>`);
    } else {
      const summary = summarizeXmlStructure(value, depth + 1);
      lines.push(`${indent}<${key}>${summary}</${key}>`);
    }
  }

  if (keys.length > 10) {
    lines.push(`${indent}... (${keys.length - 10} more elements)`);
  }

  return lines.join('\n');
}

/**
 * Generate markdown for feed
 */
function generateFeedMarkdown(metadata: FeedMetadata, items: FeedItem[], feedType: string): string {
  const lines: string[] = [];

  lines.push(`# ${metadata.title}\n`);

  if (metadata.description) {
    lines.push(`${metadata.description}\n`);
  }

  lines.push('## Feed Info\n');
  lines.push(`- **Type:** ${feedType}`);
  lines.push(`- **Items:** ${metadata.itemCount}`);
  if (metadata.link) lines.push(`- **Link:** ${metadata.link}`);
  if (metadata.lastBuildDate) lines.push(`- **Updated:** ${metadata.lastBuildDate}`);
  lines.push('');

  if (items.length > 0) {
    lines.push('## Recent Items\n');

    for (const item of items) {
      lines.push(`### ${item.title}\n`);
      if (item.link) lines.push(`[Read more](${item.link})\n`);
      if (item.pubDate) lines.push(`*Published: ${item.pubDate}*`);
      if (item.author) lines.push(`*By: ${item.author}*`);
      if (item.description) {
        lines.push('\n' + item.description.substring(0, 500));
        if (item.description.length > 500) lines.push('...');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Generate plain text summary for feed
 */
function generateFeedText(metadata: FeedMetadata, items: FeedItem[]): string {
  const lines: string[] = [];

  lines.push(metadata.title);
  if (metadata.description) lines.push(metadata.description);
  lines.push(`${metadata.itemCount} items`);
  lines.push('');

  for (const item of items.slice(0, 5)) {
    lines.push(`- ${item.title}`);
    if (item.pubDate) lines.push(`  ${item.pubDate}`);
  }

  if (items.length > 5) {
    lines.push(`... and ${items.length - 5} more items`);
  }

  return lines.join('\n');
}

/**
 * Generate markdown for generic XML
 */
function generateXmlMarkdown(rootName: string, structure: string, sourceUrl?: string): string {
  const lines: string[] = [];

  lines.push(`# XML Document\n`);
  lines.push(`Root element: \`<${rootName}>\`\n`);

  if (sourceUrl) {
    lines.push(`Source: ${sourceUrl}\n`);
  }

  lines.push('## Structure\n');
  lines.push('```xml');
  lines.push(structure);
  lines.push('```');

  return lines.join('\n');
}

// Helper functions

function getString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('#text' in obj) return getString(obj['#text']);
  }
  return undefined;
}

function getAtomText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('#text' in obj) return getString(obj['#text']);
    if ('$' in obj) return getString(obj['$']);
  }
  return undefined;
}

function getAtomLink(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    // Find alternate link
    for (const link of value) {
      const linkObj = link as Record<string, unknown>;
      if (linkObj['@_rel'] === 'alternate' || !linkObj['@_rel']) {
        return getString(linkObj['@_href']);
      }
    }
    // Fall back to first link
    const first = value[0] as Record<string, unknown> | undefined;
    return first ? getString(first['@_href']) : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    return getString((value as Record<string, unknown>)['@_href']);
  }
  return undefined;
}

function getAtomAuthor(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return getString(obj['name']) || getString(obj['email']);
  }
  return undefined;
}

function stripHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
