/**
 * Content Compactor
 *
 * Intelligently compresses content while preserving key information.
 * Implements multiple compaction strategies.
 */

import type {
  LLMPacket,
  ChunkSet,
  CompactedPacket,
  CompactedKeyPoint,
  CompactOptions,
  CompactMode,
  PreserveType,
  KeyBlock,
} from '../types.js';
import { estimateTokens, truncateToTokens } from '../utils/tokens.js';

interface SectionScore {
  index: number;
  text: string;
  score: number;
  reasons: string[];
}

/**
 * Compact content to fit within token limit
 */
export function compactContent(
  input: LLMPacket | ChunkSet,
  options: CompactOptions
): CompactedPacket {
  const {
    max_tokens,
    mode = 'structural',
    question,
    preserve = ['numbers', 'dates', 'names'],
  } = options;

  // Get content and source info
  const { sourceId, originalUrl, content, chunks, keyBlocks } = extractInput(input);

  // Apply compaction based on mode
  let result: CompactionResult;

  switch (mode) {
    case 'structural':
      result = structuralCompaction(content, chunks, max_tokens, preserve, keyBlocks);
      break;
    case 'salience':
      result = salienceCompaction(content, chunks, max_tokens, preserve, keyBlocks);
      break;
    case 'map_reduce':
      result = mapReduceCompaction(content, chunks, max_tokens, preserve, keyBlocks);
      break;
    case 'question_focused':
      result = questionFocusedCompaction(content, chunks, max_tokens, preserve, keyBlocks, question);
      break;
    default:
      result = structuralCompaction(content, chunks, max_tokens, preserve, keyBlocks);
  }

  const summaryTokens = estimateTokens(result.summary);
  if (summaryTokens > max_tokens) {
    const truncated = truncateToTokens(result.summary, max_tokens);
    if (truncated.truncated) {
      result.summary = truncated.text;
      result.warnings.push('Summary truncated to fit token budget');
    }
  }

  return {
    source_id: sourceId,
    original_url: originalUrl,
    compacted: {
      summary: result.summary,
      key_points: result.keyPoints,
      important_quotes: result.importantQuotes,
      omissions: result.omissions,
      warnings: result.warnings,
    },
    est_tokens: estimateTokens(result.summary + result.keyPoints.map(k => k.text).join(' ')),
  };
}

interface CompactionResult {
  summary: string;
  keyPoints: CompactedKeyPoint[];
  importantQuotes: CompactedKeyPoint[];
  omissions: string[];
  warnings: string[];
}

/**
 * Extract input into common format
 */
function extractInput(input: LLMPacket | ChunkSet): {
  sourceId: string;
  originalUrl: string;
  content: string;
  chunks: string[];
  keyBlocks: KeyBlock[];
} {
  if (isChunkSet(input)) {
    const chunkSet = input;
    return {
      sourceId: chunkSet.source_id,
      originalUrl: '',
      content: chunkSet.chunks.map(c => c.text).join('\n\n'),
      chunks: chunkSet.chunks.map(c => c.text),
      keyBlocks: [],
    };
  }

  const packet = input as Partial<LLMPacket>;
  if (typeof packet.content !== 'string') {
    throw new Error('Compact input must include content or chunks');
  }
  if (typeof packet.source_id !== 'string') {
    throw new Error('Compact input must include source_id');
  }

  // It's an LLMPacket or minimal packet input.
  return {
    sourceId: packet.source_id,
    originalUrl: packet.original_url ?? '',
    content: packet.content,
    chunks: [packet.content],
    keyBlocks: packet.key_blocks ?? [],
  };
}

function isChunkSet(input: LLMPacket | ChunkSet): input is ChunkSet {
  return Array.isArray((input as ChunkSet).chunks);
}

/**
 * Structural compaction - removes boilerplate, keeps structure
 */
function structuralCompaction(
  content: string,
  chunks: string[],
  maxTokens: number,
  preserve: PreserveType[],
  keyBlocks: KeyBlock[],
): CompactionResult {
  const sections = splitIntoSections(content);
  const omissions: string[] = [];
  const warnings: string[] = [];

  // Score sections for importance
  const scoredSections = sections.map((section, idx) => ({
    index: idx,
    text: section,
    score: scoreSection(section, preserve),
    reasons: getSectionReasons(section, preserve),
  }));

  // Sort by score (descending)
  scoredSections.sort((a, b) => b.score - a.score);

  // Build summary from top sections until we hit limit
  const includedSections: SectionScore[] = [];
  let currentTokens = 0;

  for (const section of scoredSections) {
    const sectionTokens = estimateTokens(section.text);
    const remainingTokens = maxTokens - currentTokens;

    if (remainingTokens <= 0) {
      omissions.push(summarizeOmission(section.text));
      continue;
    }

    if (currentTokens + sectionTokens <= maxTokens) {
      includedSections.push(section);
      currentTokens += sectionTokens;
      continue;
    }

    if (remainingTokens >= 40) {
      const summarized = summarizeSection(section.text, remainingTokens, preserve);
      const summaryTokens = estimateTokens(summarized);
      if (summaryTokens > 0 && summaryTokens <= remainingTokens) {
        includedSections.push({
          ...section,
          text: summarized,
        });
        currentTokens += summaryTokens;
        omissions.push(`Summarized ${summarizeOmission(section.text)}`);
        continue;
      }
    }

    omissions.push(summarizeOmission(section.text));
  }

  // Sort included sections by original order
  includedSections.sort((a, b) => a.index - b.index);

  const summary = includedSections.map(s => s.text).join('\n\n');
  const keyPoints = extractKeyPoints(summary, preserve, keyBlocks);
  const importantQuotes = extractQuotes(content, keyBlocks);

  return {
    summary,
    keyPoints,
    importantQuotes,
    omissions: omissions.slice(0, 5),
    warnings,
  };
}

/**
 * Salience-based compaction - keeps high-information-density content
 */
function salienceCompaction(
  content: string,
  chunks: string[],
  maxTokens: number,
  preserve: PreserveType[],
  keyBlocks: KeyBlock[],
): CompactionResult {
  const sentences = splitIntoSentences(content);
  const omissions: string[] = [];
  const warnings: string[] = [];

  // Score each sentence
  const scoredSentences = sentences.map((sentence, idx) => ({
    index: idx,
    text: sentence,
    score: scoreSentenceSalience(sentence, preserve),
    reasons: [],
  }));

  // Sort by salience score
  scoredSentences.sort((a, b) => b.score - a.score);

  // Select top sentences until we hit limit
  const includedSentences: SectionScore[] = [];
  let currentTokens = 0;

  for (const sentence of scoredSentences) {
    const sentenceTokens = estimateTokens(sentence.text);

    if (currentTokens + sentenceTokens <= maxTokens) {
      includedSentences.push(sentence);
      currentTokens += sentenceTokens;
    }
  }

  // Sort by original order for coherence
  includedSentences.sort((a, b) => a.index - b.index);

  const summary = formatSummary(dedupeSentences(includedSentences.map(s => s.text)));
  const keyPoints = extractKeyPoints(summary, preserve, keyBlocks);
  const importantQuotes = extractQuotes(content, keyBlocks);

  omissions.push(`Condensed from ${sentences.length} sentences to ${includedSentences.length}`);

  return {
    summary,
    keyPoints,
    importantQuotes,
    omissions,
    warnings,
  };
}

/**
 * Map-reduce style compaction
 */
function mapReduceCompaction(
  content: string,
  chunks: string[],
  maxTokens: number,
  preserve: PreserveType[],
  keyBlocks: KeyBlock[],
): CompactionResult {
  const omissions: string[] = [];
  const warnings: string[] = [];

  // Map: summarize each chunk
  const chunkSummaries = chunks.map((chunk, idx) => {
    const summary = summarizeChunk(chunk, Math.floor(maxTokens / chunks.length), preserve);
    return {
      index: idx,
      summary,
    };
  });

  // Reduce: combine summaries
  let combinedSummary = chunkSummaries.map(c => c.summary).join('\n\n');

  // If still too long, compress further
  while (estimateTokens(combinedSummary) > maxTokens) {
    const sentences = splitIntoSentences(combinedSummary);
    // Remove least important sentences
    const scored = sentences.map((s, i) => ({ text: s, score: scoreSentenceSalience(s, preserve), index: i }));
    scored.sort((a, b) => b.score - a.score);

    const targetLength = Math.floor(sentences.length * 0.8);
    const kept = scored.slice(0, targetLength).sort((a, b) => a.index - b.index);
    combinedSummary = kept.map(s => s.text).join(' ');

    if (targetLength <= 5) break; // Safety
  }

  const keyPoints = extractKeyPoints(combinedSummary, preserve, keyBlocks);
  const importantQuotes = extractQuotes(content, keyBlocks);

  omissions.push(`Combined ${chunks.length} chunks via map-reduce`);

  return {
    summary: combinedSummary,
    keyPoints,
    importantQuotes,
    omissions,
    warnings,
  };
}

/**
 * Question-focused compaction
 */
function questionFocusedCompaction(
  content: string,
  chunks: string[],
  maxTokens: number,
  preserve: PreserveType[],
  keyBlocks: KeyBlock[],
  question?: string,
): CompactionResult {
  const omissions: string[] = [];
  const warnings: string[] = [];

  if (!question) {
    const fallback = salienceCompaction(content, chunks, maxTokens, preserve, keyBlocks);
    fallback.warnings.push('No question provided, falling back to salience compaction');
    return fallback;
  }

  // Extract key terms from question
  const questionTerms = extractQueryTerms(question);

  // Score sentences by relevance to question
  const sentences = splitIntoSentences(content);
  const scoredSentences = sentences.map((sentence, idx) => ({
    index: idx,
    text: sentence,
    score: scoreRelevance(sentence, questionTerms, preserve),
    reasons: [],
  }));

  // Sort by relevance
  scoredSentences.sort((a, b) => b.score - a.score);

  // Select most relevant sentences
  const includedSentences: SectionScore[] = [];
  let currentTokens = 0;

  for (const sentence of scoredSentences) {
    const sentenceTokens = estimateTokens(sentence.text);

    if (currentTokens + sentenceTokens <= maxTokens) {
      includedSentences.push(sentence);
      currentTokens += sentenceTokens;
    }
  }

  // Sort by original order
  includedSentences.sort((a, b) => a.index - b.index);

  const summary = formatSummary(dedupeSentences(includedSentences.map(s => s.text)));
  const keyPoints = extractKeyPoints(summary, preserve, keyBlocks);
  const importantQuotes = extractQuotes(content, keyBlocks);

  omissions.push(`Focused on question: "${question.substring(0, 50)}..."`);
  omissions.push(`Selected ${includedSentences.length} of ${sentences.length} sentences`);

  return {
    summary,
    keyPoints,
    importantQuotes,
    omissions,
    warnings,
  };
}

// Helper functions

function splitIntoSections(content: string): string[] {
  const sections: string[] = [];
  const lines = content.split('\n');
  let current: string[] = [];
  let inCodeBlock = false;
  let fenceChar = '';
  let fenceLength = 0;

  for (const line of lines) {
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
      current.push(line);
      continue;
    }

    if (!inCodeBlock && /^#{1,6}\s+/.test(line)) {
      if (current.length > 0) {
        const sectionText = current.join('\n').trim();
        if (sectionText) {
          sections.push(sectionText);
        }
      }
      current = [line];
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    const sectionText = current.join('\n').trim();
    if (sectionText) {
      sections.push(sectionText);
    }
  }

  return sections;
}

function splitIntoSentences(content: string): string[] {
  const sentences: string[] = [];
  const lines = content.split('\n');
  let paragraphLines: string[] = [];
  let inCodeBlock = false;
  let fenceChar = '';
  let fenceLength = 0;

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    const paragraph = paragraphLines.join(' ').replace(/\s+/g, ' ').trim();
    if (paragraph) {
      sentences.push(...splitParagraphIntoSentences(paragraph));
    }
    paragraphLines = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1]!;
      const markerChar = fenceMarker[0]!;
      if (!inCodeBlock) {
        flushParagraph();
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

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (isHeadingLine(trimmed) || isListLine(trimmed)) {
      flushParagraph();
      sentences.push(trimmed);
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();

  return sentences;
}

function scoreSection(section: string, preserve: PreserveType[]): number {
  let score = 0;

  // Heading boost
  if (/^#{1,3}\s/.test(section)) score += 2;

  // Length normalization (prefer medium-length sections)
  const length = section.length;
  if (length > 100 && length < 2000) score += 1;

  // Preserved element boost
  if (preserve.includes('numbers') && /\d+/.test(section)) score += 1;
  if (preserve.includes('dates') && /\d{4}|January|February|March|April|May|June|July|August|September|October|November|December/i.test(section)) score += 1;
  if (preserve.includes('definitions') && /means|refers to|is defined as|is called/i.test(section)) score += 2;
  if (preserve.includes('procedures') && /step|first|then|next|finally|must|should/i.test(section)) score += 1;

  // Code block boost (technical content)
  if (section.includes('```')) score += 1;

  // List boost (structured info)
  if (/^[-*]\s/m.test(section)) score += 1;

  return score;
}

function getSectionReasons(section: string, preserve: PreserveType[]): string[] {
  const reasons: string[] = [];

  if (/^#{1,3}\s/.test(section)) reasons.push('heading');
  if (/\d+/.test(section)) reasons.push('contains numbers');
  if (section.includes('```')) reasons.push('code block');

  return reasons;
}

function scoreSentenceSalience(sentence: string, preserve: PreserveType[]): number {
  let score = 0;
  const trimmed = sentence.trim();

  // Length penalty for very short or very long sentences
  if (sentence.length < 20) score -= 1;
  if (sentence.length > 300) score -= 1;

  // Preserved elements
  if (preserve.includes('numbers') && /\d+/.test(sentence)) score += 2;
  if (preserve.includes('dates') && /\d{4}|January|February|March|April|May|June|July|August|September|October|November|December/i.test(sentence)) score += 2;
  if (preserve.includes('names') && /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(sentence)) score += 1;
  if (preserve.includes('definitions') && /means|refers to|is defined as|is called/i.test(sentence)) score += 3;
  if (preserve.includes('procedures') && /step|first|then|next|finally|must|should/i.test(sentence)) score += 2;

  // High-value indicators
  if (/according to|reported|announced|discovered|found that/i.test(sentence)) score += 1;
  if (/\$[\d,]+|percent|\d+%/i.test(sentence)) score += 2;

  if (isHeadingLine(trimmed)) score += 3;
  if (isListLine(trimmed)) score += 1;

  return score;
}

function summarizeChunk(chunk: string, maxTokens: number, preserve: PreserveType[]): string {
  const sentences = splitIntoSentences(chunk);
  if (sentences.length <= 3) return chunk;

  // Score and select top sentences
  const scored = sentences.map((s, i) => ({
    text: s,
    score: scoreSentenceSalience(s, preserve),
    index: i,
  }));
  scored.sort((a, b) => b.score - a.score);

  let result: typeof scored = [];
  let tokens = 0;

  for (const s of scored) {
    const t = estimateTokens(s.text);
    if (tokens + t <= maxTokens) {
      result.push(s);
      tokens += t;
    }
  }

  // Restore order
  result.sort((a, b) => a.index - b.index);
  return formatSummary(dedupeSentences(result.map(s => s.text)));
}

function summarizeOmission(text: string): string {
  // Get first line or heading
  const firstLine = text.split('\n')[0]?.trim() || '';
  if (firstLine.startsWith('#')) {
    return `Section: ${firstLine.replace(/^#+\s*/, '')}`;
  }
  if (firstLine.length < 60) {
    return firstLine;
  }
  return firstLine.substring(0, 57) + '...';
}

function extractKeyPoints(text: string, preserve: PreserveType[], keyBlocks: KeyBlock[]): CompactedKeyPoint[] {
  const keyPoints: CompactedKeyPoint[] = [];
  const sentences = splitIntoSentences(text);
  const seen = new Set<string>();

  for (const sentence of sentences) {
    const score = scoreSentenceSalience(sentence, preserve);
    const normalized = normalizeSentence(sentence);
    if (score >= 2 && normalized && !seen.has(normalized)) {
      seen.add(normalized);
      keyPoints.push({
        text: sentence,
        citation: findCitationForText(sentence, keyBlocks),
      });
    }
  }

  return keyPoints.slice(0, 10);
}

function extractQuotes(content: string, keyBlocks: KeyBlock[]): CompactedKeyPoint[] {
  const quotes: CompactedKeyPoint[] = [];

  // Find quoted text
  const quoteMatches = content.matchAll(/"([^"]{20,200})"/g);
  for (const match of quoteMatches) {
    if (match[1]) {
      const quoted = `"${match[1]}"`;
      quotes.push({
        text: quoted,
        citation: findCitationForText(match[1], keyBlocks),
      });
    }
  }

  return quotes.slice(0, 5);
}

function summarizeSection(section: string, maxTokens: number, preserve: PreserveType[]): string {
  if (estimateTokens(section) <= maxTokens) {
    return section;
  }

  const lines = section.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const hasHeading = /^#{1,6}\s+/.test(firstLine);
  const headingLine = hasHeading ? firstLine : '';
  const body = hasHeading ? lines.slice(1).join('\n').trim() : section.trim();

  if (!body) {
    return headingLine;
  }

  const headingTokens = headingLine ? estimateTokens(headingLine) : 0;
  const bodyBudget = Math.max(20, maxTokens - headingTokens);
  const bodySummary = summarizeChunk(body, bodyBudget, preserve);

  if (!headingLine) {
    return bodySummary;
  }

  return [headingLine, bodySummary].filter(Boolean).join('\n\n');
}

function findCitationForText(text: string, keyBlocks: KeyBlock[]): string {
  if (keyBlocks.length === 0) {
    return '';
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  const normalized = normalizeForMatch(trimmed);

  for (const block of keyBlocks) {
    if (!block.text) continue;
    if (block.text.includes(trimmed)) {
      return block.block_id;
    }
    if (normalized && normalizeForMatch(block.text).includes(normalized)) {
      return block.block_id;
    }
  }

  return '';
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitParagraphIntoSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s+/.test(line);
}

function isListLine(line: string): boolean {
  return /^[-*+]\s+/.test(line) || /^[0-9]+[.)]\s+/.test(line);
}

function normalizeSentence(sentence: string): string {
  return sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function dedupeSentences(sentences: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const sentence of sentences) {
    const normalized = normalizeSentence(sentence);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(sentence);
  }

  return result;
}

function formatSummary(sentences: string[]): string {
  const lines: string[] = [];
  let paragraph = '';

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (isHeadingLine(trimmed) || isListLine(trimmed)) {
      if (paragraph) {
        lines.push(paragraph.trim());
        paragraph = '';
      }
      lines.push(trimmed);
      continue;
    }

    paragraph = paragraph ? `${paragraph} ${trimmed}` : trimmed;
  }

  if (paragraph) {
    lines.push(paragraph.trim());
  }

  return lines.join('\n\n');
}

function extractQueryTerms(question: string): string[] {
  // Remove common words and extract meaningful terms
  const stopWords = new Set([
    'what', 'how', 'why', 'when', 'where', 'who', 'which',
    'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did',
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'into', 'through',
    'can', 'could', 'should', 'would', 'will',
    'this', 'that', 'these', 'those',
    'i', 'me', 'my', 'we', 'our', 'you', 'your',
  ]);

  return question
    .toLowerCase()
    .replace(/[?.,!;:'"]/g, '')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function scoreRelevance(sentence: string, queryTerms: string[], preserve: PreserveType[]): number {
  let score = scoreSentenceSalience(sentence, preserve);
  const lowerSentence = sentence.toLowerCase();

  // Boost for query term matches
  for (const term of queryTerms) {
    if (lowerSentence.includes(term)) {
      score += 3;
    }
  }

  return score;
}
