/**
 * Plain Text Content Extractor
 *
 * Processes plain text files, detecting structure and
 * normalizing formatting.
 */

import type { ExtractedContent } from '../types.js';

export interface TextExtractionResult {
  success: boolean;
  content?: ExtractedContent;
  markdown?: string;
  error?: string;
  warnings: string[];
  detectedStructure: TextStructure;
}

export interface TextStructure {
  hasHeadings: boolean;
  hasBulletLists: boolean;
  hasNumberedLists: boolean;
  hasCodeBlocks: boolean;
  lineCount: number;
  avgLineLength: number;
  isLikelyCode: boolean;
}

/**
 * Extract content from plain text
 */
export function extractText(
  content: string,
  sourceUrl?: string
): TextExtractionResult {
  const warnings: string[] = [];

  try {
    // Normalize line endings
    const normalized = normalizeLineEndings(content);

    // Detect structure
    const structure = detectTextStructure(normalized);

    // Generate markdown representation
    const markdown = convertToMarkdown(normalized, structure);

    const extractedContent: ExtractedContent = {
      title: detectTitle(normalized) || 'Plain Text',
      content: markdown,
      textContent: normalized,
      excerpt: normalized.substring(0, 300).trim(),
    };

    return {
      success: true,
      content: extractedContent,
      markdown,
      warnings,
      detectedStructure: structure,
    };

  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      warnings,
      detectedStructure: {
        hasHeadings: false,
        hasBulletLists: false,
        hasNumberedLists: false,
        hasCodeBlocks: false,
        lineCount: 0,
        avgLineLength: 0,
        isLikelyCode: false,
      },
    };
  }
}

/**
 * Normalize line endings to Unix-style
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Detect the structure of plain text
 */
function detectTextStructure(text: string): TextStructure {
  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);

  // Calculate average line length
  const totalLength = nonEmptyLines.reduce((sum, l) => sum + l.length, 0);
  const avgLineLength = nonEmptyLines.length > 0 ? totalLength / nonEmptyLines.length : 0;

  // Detect headings (all caps lines, lines ending with :, underlined text)
  const hasHeadings = lines.some((line, idx) => {
    const trimmed = line.trim();
    // All caps short lines
    if (trimmed.length > 0 && trimmed.length < 80 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
      return true;
    }
    // Lines followed by === or ---
    const nextLine = lines[idx + 1]?.trim() || '';
    if (trimmed.length > 0 && (/^=+$/.test(nextLine) || /^-+$/.test(nextLine))) {
      return true;
    }
    return false;
  });

  // Detect bullet lists
  const hasBulletLists = lines.some(line => /^\s*[-*•◦▪►]\s+/.test(line));

  // Detect numbered lists
  const hasNumberedLists = lines.some(line => /^\s*\d+[.)]\s+/.test(line));

  // Detect code-like content
  const isLikelyCode = detectIfCode(text, lines);

  // Code blocks are likely if we have indented blocks
  const hasCodeBlocks = lines.some((line, idx) => {
    if (!/^\s{4,}/.test(line)) return false;
    // Check if previous line is less indented
    const prevLine = lines[idx - 1] || '';
    return prevLine.trim().length > 0 && !/^\s{4,}/.test(prevLine);
  });

  return {
    hasHeadings,
    hasBulletLists,
    hasNumberedLists,
    hasCodeBlocks,
    lineCount: lines.length,
    avgLineLength,
    isLikelyCode,
  };
}

/**
 * Detect if content is likely source code
 */
function detectIfCode(text: string, lines: string[]): boolean {
  let codeScore = 0;

  // Check for common programming patterns
  const patterns = [
    /^(function|const|let|var|class|import|export|def|async|public|private|void)\s/m,
    /[{}\[\]();]/,
    /=>/,
    /^\s*(if|for|while|switch|try|catch)\s*\(/m,
    /^\s*#include/m,
    /^\s*package\s+/m,
    /^\s*using\s+/m,
    /^\s*require\s*\(/m,
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) codeScore++;
  }

  // High indentation frequency
  const indentedLines = lines.filter(l => /^\s{2,}/.test(l)).length;
  if (indentedLines > lines.length * 0.4) codeScore++;

  // Short average line length (code tends to be <80 chars)
  const avgLength = lines.reduce((s, l) => s + l.length, 0) / (lines.length || 1);
  if (avgLength < 60) codeScore++;

  return codeScore >= 3;
}

/**
 * Try to detect a title from the first few lines
 */
function detectTitle(text: string): string | null {
  const lines = text.split('\n').slice(0, 5);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const nextLine = lines[i + 1]?.trim() || '';

    // Skip empty lines
    if (!line) continue;

    // Check for underlined title
    if (/^=+$/.test(nextLine) || /^-+$/.test(nextLine)) {
      return line;
    }

    // Check for all-caps title (first non-empty line if short)
    if (line.length < 80 && line === line.toUpperCase() && /[A-Z]/.test(line)) {
      return titleCase(line);
    }

    // First non-empty short line could be title
    if (line.length < 100 && !line.includes('  ') && !line.endsWith('.')) {
      return line;
    }
  }

  return null;
}

/**
 * Convert plain text to markdown
 */
function convertToMarkdown(text: string, structure: TextStructure): string {
  if (structure.isLikelyCode) {
    // Wrap entire content in code block
    return '```\n' + text + '\n```';
  }

  const lines = text.split('\n');
  const result: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const nextLine = lines[i + 1]?.trim() || '';

    // Handle underlined headings
    if (/^=+$/.test(nextLine) && trimmed.length > 0) {
      result.push('# ' + trimmed);
      i++; // Skip the underline
      continue;
    }
    if (/^-+$/.test(nextLine) && nextLine.length >= 3 && trimmed.length > 0) {
      result.push('## ' + trimmed);
      i++; // Skip the underline
      continue;
    }

    // Handle all-caps headings
    if (trimmed.length > 0 && trimmed.length < 80 &&
        trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed) &&
        !trimmed.startsWith('-') && !trimmed.startsWith('*')) {
      result.push('## ' + titleCase(trimmed));
      continue;
    }

    // Handle bullet lists
    const bulletMatch = line.match(/^(\s*)([-*•◦▪►])\s+(.*)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1]!.length > 0 ? '  ' : '';
      result.push(indent + '- ' + bulletMatch[3]);
      inList = true;
      continue;
    }

    // Handle numbered lists
    const numMatch = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numMatch) {
      const indent = numMatch[1]!.length > 0 ? '  ' : '';
      result.push(indent + numMatch[2] + '. ' + numMatch[3]);
      inList = true;
      continue;
    }

    // End of list
    if (inList && trimmed === '') {
      inList = false;
    }

    // Regular line
    result.push(line);
  }

  return result.join('\n');
}

/**
 * Convert string to title case
 */
function titleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
