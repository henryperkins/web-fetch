/**
 * Markdown Content Extractor
 *
 * Processes Markdown files, extracting frontmatter and
 * normalizing content for LLM consumption.
 */

import { parse as parseYaml } from 'yaml';
import type { ExtractedContent } from '../types.js';

export interface MarkdownFrontmatter {
  title?: string;
  author?: string;
  date?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface MarkdownExtractionResult {
  success: boolean;
  content?: ExtractedContent;
  markdown?: string;
  frontmatter?: MarkdownFrontmatter;
  error?: string;
  warnings: string[];
}

// Frontmatter regex: matches --- delimited YAML at start of file
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Extract frontmatter from markdown content
 */
export function extractFrontmatter(content: string): {
  frontmatter: MarkdownFrontmatter | null;
  body: string;
  error?: string;
} {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return { frontmatter: null, body: content };
  }

  const yamlContent = match[1];
  const body = match[2] || '';

  try {
    const frontmatter = parseYaml(yamlContent || '') as MarkdownFrontmatter;
    return { frontmatter, body };
  } catch (err) {
    return {
      frontmatter: null,
      body: content,
      error: `Failed to parse frontmatter: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Sanitize markdown content
 * - Remove potentially dangerous embedded HTML
 * - Normalize code blocks
 * - Clean up structure
 */
export function sanitizeMarkdown(md: string): { markdown: string; warnings: string[] } {
  const warnings: string[] = [];
  let result = md;

  // Remove script tags (they shouldn't be in markdown, but could be in embedded HTML)
  const scriptMatches = result.match(/<script[\s\S]*?<\/script>/gi);
  if (scriptMatches && scriptMatches.length > 0) {
    warnings.push(`Removed ${scriptMatches.length} script tag(s) from markdown`);
    result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  // Remove style tags
  const styleMatches = result.match(/<style[\s\S]*?<\/style>/gi);
  if (styleMatches && styleMatches.length > 0) {
    warnings.push(`Removed ${styleMatches.length} style tag(s) from markdown`);
    result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
  }

  // Remove iframes
  const iframeMatches = result.match(/<iframe[\s\S]*?(<\/iframe>|\/?>)/gi);
  if (iframeMatches && iframeMatches.length > 0) {
    warnings.push(`Removed ${iframeMatches.length} iframe(s) from markdown`);
    result = result.replace(/<iframe[\s\S]*?(<\/iframe>|\/?>)/gi, '[iframe removed]');
  }

  // Remove onclick and other event handlers from HTML tags
  result = result.replace(/\s+on\w+="[^"]*"/gi, '');
  result = result.replace(/\s+on\w+='[^']*'/gi, '');

  // Normalize code fence markers (ensure consistent ```)
  result = result.replace(/^~~~(\w*)/gm, '```$1');

  // Ensure code blocks have newline after opening fence
  result = result.replace(/```(\w+)([^\n])/g, '```$1\n$2');

  return { markdown: result, warnings };
}

/**
 * Extract headings from markdown for outline
 */
export function extractMarkdownHeadings(md: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];

  const lines = md.split('\n');
  let inCodeBlock = false;
  let fenceChar = '';
  let fenceLength = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1]!;
      const markerChar = fenceMarker[0]!;
      if (!inCodeBlock) {
        inCodeBlock = true;
        fenceChar = markerChar;
        fenceLength = fenceMarker.length;
      } else if (markerChar === fenceChar && fenceMarker.length >= fenceLength) {
        inCodeBlock = false;
        fenceChar = '';
        fenceLength = 0;
      }
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    // ATX-style headings: # Heading
    const atxMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (atxMatch) {
      const level = atxMatch[1]!.length;
      const text = atxMatch[2]!.trim();
      if (text) {
        headings.push({ level, text });
      }
      continue;
    }

    // Setext-style headings (underlined)
    if (i < lines.length - 1) {
      const currentLine = line.trim();
      const nextLine = lines[i + 1]!.trim();
      const nextLineIsFence = /^\s*(```+|~~~+)/.test(lines[i + 1] || '');

      if (currentLine && !currentLine.startsWith('#') && !nextLineIsFence) {
        if (/^=+$/.test(nextLine)) {
          headings.push({ level: 1, text: currentLine });
        } else if (/^-+$/.test(nextLine) && nextLine.length >= 2) {
          // Avoid confusion with horizontal rules or list items
          headings.push({ level: 2, text: currentLine });
        }
      }
    }
  }

  return headings;
}

/**
 * Extract content from Markdown file
 */
export function extractMarkdown(
  content: string,
  sourceUrl?: string
): MarkdownExtractionResult {
  const warnings: string[] = [];

  try {
    // Extract frontmatter
    const { frontmatter, body, error: fmError } = extractFrontmatter(content);

    if (fmError) {
      warnings.push(fmError);
    }

    // Sanitize markdown body
    const { markdown: sanitizedBody, warnings: sanitizeWarnings } = sanitizeMarkdown(body);
    warnings.push(...sanitizeWarnings);

    // Get plain text (strip markdown syntax)
    const textContent = markdownToPlainText(sanitizedBody);

    // Create excerpt
    const excerpt = textContent.substring(0, 300).trim();

    // Get title from frontmatter or first heading
    let title = frontmatter?.title || '';
    if (!title) {
      const headings = extractMarkdownHeadings(sanitizedBody);
      if (headings.length > 0 && headings[0]) {
        title = headings[0].text;
      }
    }

    const extractedContent: ExtractedContent = {
      title: String(title || ''),
      content: sanitizedBody,
      textContent,
      excerpt,
      byline: frontmatter?.author ? String(frontmatter.author) : undefined,
      publishedTime: frontmatter?.date ? String(frontmatter.date) : undefined,
    };

    return {
      success: true,
      content: extractedContent,
      markdown: sanitizedBody,
      frontmatter: frontmatter || undefined,
      warnings,
    };

  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error during markdown extraction',
      warnings,
    };
  }
}

/**
 * Convert markdown to plain text (strip all formatting)
 */
function markdownToPlainText(md: string): string {
  return md
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    .replace(/`[^`]+`/g, ' ')
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove reference-style links
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    // Remove emphasis
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // Remove headings markers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove blockquote markers
    .replace(/^>\s*/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Normalize whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
