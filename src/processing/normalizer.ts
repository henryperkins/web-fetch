/**
 * Content Normalizer
 *
 * Creates standardized LLMPacket output from various content types.
 */

import type {
  LLMPacket,
  LLMPacketMetadata,
  KeyBlock,
  OutlineEntry,
  Warning,
  UnsafeInstruction,
  ExtractedContent,
  ContentTypeInfo,
  RawFetchResult,
  NormalizedContent,
  ExtractionOptions,
  FormatOptions,
} from '../types.js';
import { sha256, generateSourceId, generateBlockId } from '../utils/hash.js';
import { normalizeUrl } from '../utils/url.js';
import { estimateTokens, estimateReadingTime } from '../utils/tokens.js';
import { detectInjections } from '../security/injection-detector.js';
import { generateOutline } from './outline.js';
import { extractHtml, extractHeadings } from '../extractors/html-extractor.js';
import { extractMarkdown } from '../extractors/markdown-extractor.js';
import { extractPdf } from '../extractors/pdf-extractor.js';
import { extractJson } from '../extractors/json-extractor.js';
import { extractXml } from '../extractors/xml-extractor.js';
import { extractText } from '../extractors/text-extractor.js';

export interface NormalizeOptions {
  extraction?: ExtractionOptions;
  format?: FormatOptions;
}

export interface NormalizeResult {
  success: boolean;
  packet?: LLMPacket;
  error?: string;
}

export function toNormalizedContent(packet: LLMPacket): NormalizedContent {
  return {
    source_id: packet.source_id,
    original_url: packet.original_url,
    canonical_url: packet.canonical_url,
    retrieved_at: packet.retrieved_at,
    status: packet.status,
    content_type: packet.content_type,
    metadata: packet.metadata,
    outline: packet.outline,
    key_blocks: packet.key_blocks,
    content: packet.content,
    source_summary: packet.source_summary,
    citations: packet.citations,
    unsafe_instructions_detected: packet.unsafe_instructions_detected,
    warnings: packet.warnings,
    raw_excerpt: packet.raw_excerpt,
    screenshot_base64: packet.screenshot_base64,
  };
}

/**
 * Detect content type from headers and body
 */
export function detectContentType(
  contentType: string,
  body: Buffer
): ContentTypeInfo {
  // Parse content-type header
  const parts = contentType.toLowerCase().split(';');
  const mimeType = (parts[0] || 'application/octet-stream').trim();

  // Extract charset if present
  const charsetPart = parts.find(p => p.trim().startsWith('charset='));
  const charset = charsetPart?.split('=')[1]?.trim();

  const isTextType = mimeType.startsWith('text/');

  // Determine type category
  if (mimeType.includes('html')) {
    return { type: 'html', mimeType, charset };
  }
  if (mimeType.includes('markdown') || mimeType === 'text/x-markdown') {
    return { type: 'markdown', mimeType, charset };
  }
  if (mimeType === 'application/pdf') {
    return { type: 'pdf', mimeType };
  }
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) {
    return { type: 'json', mimeType, charset };
  }
  if (mimeType.includes('xml') || mimeType === 'application/rss+xml' || mimeType === 'application/atom+xml') {
    return { type: 'xml', mimeType, charset };
  }

  // Sniff content if uncertain
  if (body.length > 0) {
    const start = body.toString('utf-8', 0, Math.min(1000, body.length));

    // Check for PDF magic
    if (start.startsWith('%PDF-')) {
      return { type: 'pdf', mimeType: 'application/pdf' };
    }

    // Check for HTML
    if (/<(!doctype|html|head|body)/i.test(start)) {
      return { type: 'html', mimeType: 'text/html', charset };
    }

    // Check for XML
    if (start.trim().startsWith('<?xml') || /<rss|<feed|<atom/i.test(start)) {
      return { type: 'xml', mimeType: 'application/xml', charset };
    }

    // Check for JSON
    if (/^\s*[{\[]/.test(start)) {
      try {
        JSON.parse(body.toString('utf-8'));
        return { type: 'json', mimeType: 'application/json', charset };
      } catch {
        // Not valid JSON
      }
    }

    // Check for Markdown hints
    if (/^---\r?\n/.test(start) || /^#\s+/.test(start) || /^\[.+\]\(.+\)/.test(start)) {
      return { type: 'markdown', mimeType: 'text/markdown', charset };
    }
  }

  if (isTextType) {
    return { type: 'text', mimeType, charset };
  }

  return { type: 'unknown', mimeType, charset };
}

function resolveEncoding(charset?: string): { encoding: BufferEncoding; note?: string } {
  if (!charset) {
    return { encoding: 'utf-8' };
  }

  const normalized = charset.trim().toLowerCase();
  const charsetMap: Record<string, BufferEncoding> = {
    'utf-8': 'utf-8',
    'utf8': 'utf-8',
    'utf-16': 'utf16le',
    'utf-16le': 'utf16le',
    'utf16le': 'utf16le',
    'us-ascii': 'ascii',
    'ascii': 'ascii',
    'latin1': 'latin1',
    'iso-8859-1': 'latin1',
    'windows-1252': 'latin1',
  };

  if (charsetMap[normalized]) {
    return { encoding: charsetMap[normalized] };
  }

  if (normalized.startsWith('utf-8')) {
    return { encoding: 'utf-8' };
  }
  if (normalized.startsWith('utf-16')) {
    return { encoding: 'utf16le' };
  }
  if (normalized.includes('1252') || normalized.includes('iso-8859')) {
    return { encoding: 'latin1' };
  }

  return {
    encoding: 'utf-8',
    note: `Unsupported charset "${charset}", decoded as utf-8`,
  };
}

function decodeBodyText(body: Buffer, charset?: string): { text: string; warning?: string } {
  const { encoding, note } = resolveEncoding(charset);
  try {
    return { text: body.toString(encoding), warning: note };
  } catch (err) {
    const fallbackWarning = note ?? (charset ? `Failed to decode charset "${charset}", decoded as utf-8` : undefined);
    return { text: body.toString('utf-8'), warning: fallbackWarning };
  }
}

/**
 * Extract key blocks from markdown content
 */
function extractKeyBlocks(markdown: string): KeyBlock[] {
  const blocks: KeyBlock[] = [];
  let blockIndex = 0;

  // Split content into logical blocks
  const lines = markdown.split('\n');
  let currentBlock: string[] = [];
  let currentKind: KeyBlock['kind'] = 'paragraph';

  const flushBlock = () => {
    if (currentBlock.length > 0) {
      const text = currentBlock.join('\n').trim();
      if (text) {
        blocks.push({
          block_id: generateBlockId(blockIndex++),
          kind: currentKind,
          text,
          char_len: text.length,
        });
      }
      currentBlock = [];
    }
  };

  let inCodeBlock = false;
  let inList = false;
  let fenceChar = '';
  let fenceLength = 0;

  for (const line of lines) {
    // Code block detection
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1]!;
      const markerChar = fenceMarker[0]!;
      if (!inCodeBlock) {
        flushBlock();
        inCodeBlock = true;
        fenceChar = markerChar;
        fenceLength = fenceMarker.length;
        currentKind = 'code';
        currentBlock.push(line);
      } else if (markerChar === fenceChar && fenceMarker.length >= fenceLength) {
        currentBlock.push(line);
        flushBlock();
        inCodeBlock = false;
        fenceChar = '';
        fenceLength = 0;
        currentKind = 'paragraph';
      } else {
        currentBlock.push(line);
      }
      continue;
    }

    if (inCodeBlock) {
      currentBlock.push(line);
      continue;
    }

    // Heading detection
    if (/^#{1,6}\s+/.test(line)) {
      flushBlock();
      currentKind = 'heading';
      currentBlock.push(line);
      flushBlock();
      currentKind = 'paragraph';
      continue;
    }

    // List detection
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      if (!inList) {
        flushBlock();
        currentKind = 'list';
        inList = true;
      }
      currentBlock.push(line);
      continue;
    }

    // End of list
    if (inList && line.trim() === '') {
      flushBlock();
      inList = false;
      currentKind = 'paragraph';
      continue;
    }

    // Quote detection
    if (/^>\s*/.test(line)) {
      if (currentKind !== 'quote') {
        flushBlock();
        currentKind = 'quote';
      }
      currentBlock.push(line);
      continue;
    }

    // Table detection
    if (line.includes('|') && (currentKind === 'table' || (currentBlock.length === 0 && /^\|/.test(line.trim())))) {
      if (currentKind !== 'table') {
        flushBlock();
        currentKind = 'table';
      }
      currentBlock.push(line);
      continue;
    }

    // Regular paragraph
    if (currentKind !== 'paragraph') {
      flushBlock();
      currentKind = 'paragraph';
    }

    // Empty line ends paragraph
    if (line.trim() === '') {
      flushBlock();
    } else {
      currentBlock.push(line);
    }
  }

  // Flush remaining
  flushBlock();

  return blocks;
}

const MAX_KEY_BLOCKS = 20;
const MIN_BLOCK_CHAR_LEN = 50;

/**
 * Filter key blocks to keep only the most relevant ones for large documents.
 */
function filterKeyBlocks(blocks: KeyBlock[]): KeyBlock[] {
  if (blocks.length <= MAX_KEY_BLOCKS) {
    return blocks;
  }

  const kept = new Set<number>();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    // Always keep headings, code blocks, and tables
    if (block.kind === 'heading' || block.kind === 'code' || block.kind === 'table') {
      kept.add(i);
      continue;
    }
    // Keep substantial paragraphs/lists/quotes
    if (block.char_len >= MIN_BLOCK_CHAR_LEN) {
      kept.add(i);
      continue;
    }
    // Keep first 3 and last 1 blocks for intro/conclusion context
    if (i < 3 || i === blocks.length - 1) {
      kept.add(i);
    }
  }

  const filtered = blocks.filter((_, i) => kept.has(i));
  return filtered.slice(0, MAX_KEY_BLOCKS);
}

/**
 * Generate source summary from content
 */
function generateSourceSummary(content: string, outline: OutlineEntry[]): string[] {
  const summary: string[] = [];

  // Add main topics — prefer TF-extracted terms over generic headings
  const topLevel = outline.filter(e => e.level <= 2).slice(0, 5);
  const genericPatterns = /^(recent items|feed info|navigation|contents|introduction|overview|summary|main|home|menu|sidebar|footer|header)$/i;
  const substantiveHeadings = topLevel.filter(e => e.text.split(/\s+/).length >= 3 && !genericPatterns.test(e.text.trim()));

  if (substantiveHeadings.length > 0) {
    summary.push(`Main topics: ${substantiveHeadings.map(e => e.text).join(', ')}`);
  }

  // Always extract topic terms from body text via term frequency
  const topicTerms = extractTopicTerms(content);
  if (topicTerms.length > 0) {
    summary.push(`Key topics: ${topicTerms.join(', ')}`);
  } else if (substantiveHeadings.length === 0 && topLevel.length > 0) {
    // Fallback to heading names if TF extraction found nothing
    summary.push(`Main topics: ${topLevel.map(e => e.text).join(', ')}`);
  }

  // Extract key figures — numbers with meaningful context only
  const firstPart = content.substring(0, 3000);
  const contextualNumbers = extractContextualNumbers(firstPart);
  if (contextualNumbers.length > 0) {
    summary.push(`Key figures: ${contextualNumbers.join(', ')}`);
  }

  // Find dates
  const dateMatches = firstPart.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/gi);
  if (dateMatches && dateMatches.length > 0) {
    const uniqueDates = [...new Set(dateMatches)].slice(0, 3);
    summary.push(`Dates mentioned: ${uniqueDates.join(', ')}`);
  }

  // Add content length info
  const wordCount = content.split(/\s+/).length;
  summary.push(`Content length: ~${wordCount} words`);

  return summary;
}

const SUMMARY_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'this', 'that', 'it', 'its', 'not', 'more',
  'than', 'will', 'can', 'would', 'could', 'should', 'also', 'as',
  'about', 'which', 'who', 'what', 'when', 'where', 'how', 'their',
  'there', 'they', 'them', 'he', 'she', 'his', 'her', 'our', 'your',
  'all', 'some', 'any', 'most', 'other', 'into', 'over', 'after',
  'before', 'between', 'under', 'new', 'said', 'says', 'just', 'been',
  'out', 'up', 'one', 'two', 'three', 'may', 'like', 'being', 'does',
  'did', 'get', 'got', 'make', 'made', 'back', 'still', 'own', 'such',
  // Markdown/URL noise
  'read', 'http', 'https', 'www', 'com', 'html', 'org', 'more', 'here',
]);

function extractTopicTerms(content: string, maxTerms: number = 8): string[] {
  // Strip markdown links (keep link text), headings markers, and URLs
  const cleaned = content
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/https?:\/\/\S+/g, '');

  const freq = new Map<string, number>();
  const words = cleaned.toLowerCase().match(/[a-z]{3,}/g) || [];

  for (const word of words) {
    if (SUMMARY_STOP_WORDS.has(word)) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return [...freq.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([word]) => word);
}

function extractContextualNumbers(text: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  const patterns: RegExp[] = [
    // Currency: $53m, £53m, $1,000
    /[£$€]\d+(?:,\d{3})*(?:\.\d+)?[KMBkmb]?/g,
    // Percentages: 15%, 3.5%
    /\d+(?:\.\d+)?\s*%/g,
    // Number + unit: "700 jobs", "11 people", "53m pounds"
    /\d+(?:,\d{3})*(?:\.\d+)?\s*(?:million|billion|trillion|people|jobs|deaths|cases|patients|users|troops|soldiers|miles|kilometers|tonnes|pounds|dollars|euros|percent|years|months|days|hours)\b/gi,
    // Qualified numbers: "nearly 700", "over 11", "about 53"
    /(?:approximately|about|nearly|over|under|around|roughly|more than|fewer than|at least)\s+\d+(?:,\d{3})*(?:\.\d+)?/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const match of matches) {
        const trimmed = match.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          results.push(trimmed);
        }
      }
    }
  }

  return results.slice(0, 5);
}

/**
 * Normalize raw fetch result into LLMPacket
 */
export async function normalizeContent(
  fetchResult: RawFetchResult,
  originalUrl: string,
  options: NormalizeOptions = {}
): Promise<NormalizeResult> {
  const { extraction = {}, format = {} } = options;
  const warnings: Warning[] = [];
  const unsafeInstructions: UnsafeInstruction[] = [];

  try {
    // Detect content type
    const contentTypeInfo = detectContentType(fetchResult.contentType, fetchResult.body);
    const decodedBody = decodeBodyText(fetchResult.body, contentTypeInfo.charset);
    if (decodedBody.warning) {
      warnings.push({
        type: 'extraction_fallback',
        message: decodedBody.warning,
      });
    }
    const bodyText = decodedBody.text;

    // Extract content based on type
    let extractedContent: ExtractedContent | null = null;
    let markdown = '';

    switch (contentTypeInfo.type) {
      case 'html': {
        const result = extractHtml(bodyText, fetchResult.finalUrl, extraction);
        if (result.success && result.content && result.markdown) {
          extractedContent = result.content;
          markdown = result.markdown;
          if (result.isPaywalled) {
            warnings.push({ type: 'paywalled', message: 'Content appears to be paywalled' });
          }
          result.warnings.forEach(w => warnings.push({ type: 'extraction_fallback', message: w }));
        } else {
          return { success: false, error: result.error || 'HTML extraction failed' };
        }
        break;
      }

      case 'markdown': {
        const result = extractMarkdown(bodyText, fetchResult.finalUrl);
        if (result.success && result.content && result.markdown) {
          extractedContent = result.content;
          markdown = result.markdown;
          result.warnings.forEach(w => warnings.push({ type: 'extraction_fallback', message: w }));
        } else {
          return { success: false, error: result.error || 'Markdown extraction failed' };
        }
        break;
      }

      case 'pdf': {
        const result = await extractPdf(fetchResult.body, fetchResult.finalUrl);
        if (result.success && result.content && result.markdown) {
          extractedContent = result.content;
          markdown = result.markdown;
          if (result.lowConfidence) {
            warnings.push({ type: 'scanned_pdf', message: 'PDF may be scanned images with low text extraction confidence' });
          }
          result.warnings.forEach(w => warnings.push({ type: 'extraction_fallback', message: w }));
        } else {
          return { success: false, error: result.error || 'PDF extraction failed' };
        }
        break;
      }

      case 'json': {
        const result = extractJson(bodyText, fetchResult.finalUrl);
        if (result.success && result.content && result.markdown) {
          extractedContent = result.content;
          markdown = result.markdown;
          result.warnings.forEach(w => warnings.push({ type: 'extraction_fallback', message: w }));
        } else {
          return { success: false, error: result.error || 'JSON extraction failed' };
        }
        break;
      }

      case 'xml': {
        const result = extractXml(bodyText, fetchResult.finalUrl);
        if (result.success && result.content && result.markdown) {
          extractedContent = result.content;
          markdown = result.markdown;
          result.warnings.forEach(w => warnings.push({ type: 'extraction_fallback', message: w }));
        } else {
          return { success: false, error: result.error || 'XML extraction failed' };
        }
        break;
      }

      case 'text':
      default: {
        const result = extractText(bodyText, fetchResult.finalUrl);
        if (result.success && result.content && result.markdown) {
          extractedContent = result.content;
          markdown = result.markdown;
          result.warnings.forEach(w => warnings.push({ type: 'extraction_fallback', message: w }));
        } else {
          return { success: false, error: result.error || 'Text extraction failed' };
        }
        break;
      }
    }

    if (!extractedContent) {
      return { success: false, error: 'Failed to extract content' };
    }

    // Check for prompt injections
    const injectionResult = detectInjections(markdown);
    if (injectionResult.hasInjections) {
      unsafeInstructions.push(...injectionResult.detections);
      warnings.push({
        type: 'injection_detected',
        message: `Detected ${injectionResult.detections.length} potential prompt injection pattern(s)`,
      });
    }

    // Generate outline
    const outline = generateOutline(markdown);

    // Extract key blocks — filter and cap for large documents
    const allBlocks = extractKeyBlocks(markdown);
    const keyBlocks = filterKeyBlocks(allBlocks);

    // Generate summary
    const sourceSummary = generateSourceSummary(markdown, outline);

    // Build metadata
    const metadata: LLMPacketMetadata = {
      title: extractedContent.title || undefined,
      site_name: extractedContent.siteName || undefined,
      author: extractedContent.byline || undefined,
      published_at: extractedContent.publishedTime || null,
      language: extractedContent.lang || undefined,
      estimated_reading_time_min: estimateReadingTime(markdown),
    };

    // Compute hashes
    const contentHash = sha256(markdown);
    const rawHash = sha256(fetchResult.body);

    // Generate source ID
    const canonicalUrl = normalizeUrl(fetchResult.finalUrl);
    const sourceId = generateSourceId(canonicalUrl, new Date(), contentHash);

    // Build packet
    const packet: LLMPacket = {
      source_id: sourceId,
      original_url: originalUrl,
      canonical_url: canonicalUrl,
      retrieved_at: new Date().toISOString(),
      status: fetchResult.status,
      content_type: contentTypeInfo.mimeType,
      metadata,
      outline,
      key_blocks: keyBlocks,
      content: markdown,
      source_summary: sourceSummary,
      citations: [], // Will be populated by chunking
      unsafe_instructions_detected: unsafeInstructions,
      warnings,
      hashes: {
        content_hash: contentHash,
        raw_hash: rawHash,
      },
    };

    // Add raw excerpt if requested
    if (format.include_raw_excerpt) {
      packet.raw_excerpt = bodyText.substring(0, 1000);
    }

    return { success: true, packet };

  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Normalization failed',
    };
  }
}
