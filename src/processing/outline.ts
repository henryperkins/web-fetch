/**
 * Outline Generator
 *
 * Generates hierarchical outlines from content for navigation
 * and context understanding.
 */

import type { OutlineEntry } from '../types.js';

interface HeadingMatch {
  level: number;
  text: string;
  position: number;
}

function getFenceMarker(line: string): string | null {
  const match = line.match(/^\s*(```+|~~~+)/);
  return match?.[1] ?? null;
}

function extractHeadings(markdown: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const lines = markdown.split('\n');
  let position = 0;
  let inCodeBlock = false;
  let fenceChar = '';
  let fenceLength = 0;

  for (const line of lines) {
    const fenceMarker = getFenceMarker(line);
    if (fenceMarker) {
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
      position += line.length + 1;
      continue;
    }

    if (!inCodeBlock) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        headings.push({
          level: headingMatch[1]!.length,
          text: headingMatch[2]!.trim(),
          position,
        });
      }
    }

    position += line.length + 1;
  }

  return headings;
}

/**
 * Generate outline from markdown content
 */
export function generateOutline(markdown: string): OutlineEntry[] {
  const outline: OutlineEntry[] = [];
  const pathStack: string[] = [];

  for (const heading of extractHeadings(markdown)) {
    const { level, text } = heading;

    // Update path stack
    // Remove any entries at same or deeper level
    while (pathStack.length >= level) {
      pathStack.pop();
    }
    pathStack.push(text);

    const path = pathStack.join(' > ');

    outline.push({
      level,
      text,
      path,
    });
  }

  return outline;
}

/**
 * Generate outline from raw headings array
 */
export function generateOutlineFromHeadings(
  headings: Array<{ level: number; text: string }>
): OutlineEntry[] {
  const outline: OutlineEntry[] = [];
  const pathStack: string[] = [];

  for (const heading of headings) {
    const { level, text } = heading;

    // Update path stack
    while (pathStack.length >= level) {
      pathStack.pop();
    }
    pathStack.push(text);

    const path = pathStack.join(' > ');

    outline.push({
      level,
      text,
      path,
    });
  }

  return outline;
}

/**
 * Find the heading path for a given character position
 */
export function findHeadingPath(
  markdown: string,
  charPosition: number
): string {
  const pathStack: string[] = [];
  const headings = extractHeadings(markdown);

  for (const heading of headings) {
    if (heading.position > charPosition) {
      break;
    }

    const { level, text } = heading;

    // Update path stack
    while (pathStack.length >= level) {
      pathStack.pop();
    }
    pathStack.push(text);
  }

  return pathStack.join(' > ');
}

/**
 * Get outline as flat text for display
 */
export function outlineToText(outline: OutlineEntry[]): string {
  return outline
    .map(entry => {
      const indent = '  '.repeat(entry.level - 1);
      return `${indent}${entry.text}`;
    })
    .join('\n');
}

/**
 * Get a condensed outline (only top levels)
 */
export function condenseOutline(
  outline: OutlineEntry[],
  maxLevel: number = 2
): OutlineEntry[] {
  return outline.filter(entry => entry.level <= maxLevel);
}
