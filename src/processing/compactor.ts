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

interface QueryTerm {
  base: string;
  variants: string[];
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
      originalUrl: chunkSet.original_url ?? '',
      content: chunkSet.chunks.map(c => c.text).join('\n\n'),
      chunks: chunkSet.chunks.map(c => c.text),
      keyBlocks: chunkSet.key_blocks ?? [],
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
  let perChunkBudget = Math.floor(maxTokens / Math.max(1, chunks.length));
  if (perChunkBudget < 1) {
    perChunkBudget = 1;
    warnings.push(`Chunk count (${chunks.length}) exceeds token budget (${maxTokens}); using minimum per-chunk budget`);
  }

  const chunkSummaries = chunks.map((chunk, idx) => {
    const summary = summarizeChunk(chunk, perChunkBudget, preserve);
    return {
      index: idx,
      summary,
    };
  });

  // Reduce: combine summaries
  let combinedSummary = chunkSummaries.map(c => c.summary).join('\n\n').trim();

  if (!combinedSummary && content.trim()) {
    warnings.push('Map-reduce produced empty chunk summaries; falling back to truncated content');
    combinedSummary = truncateToTokens(content, Math.max(1, maxTokens)).text;
  }

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
  const questionTerms = buildQueryTerms(question);
  if (questionTerms.length === 0) {
    const fallback = salienceCompaction(content, chunks, maxTokens, preserve, keyBlocks);
    fallback.warnings.push('No meaningful question terms found, falling back to salience compaction');
    return fallback;
  }

  // Score sentences by relevance to question
  const sentences = splitIntoSentences(content);
  const termMatches = sentences.map(sentence => countTermMatches(sentence, questionTerms));
  const totalMatches = termMatches.reduce((sum, count) => sum + count, 0);

  if (totalMatches === 0) {
    const fallback = salienceCompaction(content, chunks, maxTokens, preserve, keyBlocks);
    fallback.warnings.push('No sentence matched question terms, falling back to salience compaction');
    return fallback;
  }

  const scoredSentences = sentences.map((sentence, idx) => {
    const neighborMatches = (termMatches[idx - 1] ?? 0) + (termMatches[idx + 1] ?? 0);
    return {
      index: idx,
      text: sentence,
      score: scoreRelevance(sentence, preserve, termMatches[idx] ?? 0, neighborMatches),
      reasons: [],
      matchCount: termMatches[idx] ?? 0,
    };
  });

  // Sort by relevance
  scoredSentences.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.matchCount ?? 0) !== (a.matchCount ?? 0)) {
      return (b.matchCount ?? 0) - (a.matchCount ?? 0);
    }
    return a.index - b.index;
  });

  // Select most relevant sentences
  const includedSentences: SectionScore[] = [];
  let currentTokens = 0;
  const includedIndexes = new Set<number>();

  for (const sentence of scoredSentences) {
    const sentenceTokens = estimateTokens(sentence.text);

    if (currentTokens + sentenceTokens <= maxTokens) {
      includedSentences.push(sentence);
      currentTokens += sentenceTokens;
      includedIndexes.add(sentence.index);
    }
  }

  const minTokens = Math.floor(maxTokens * 0.7);
  if (currentTokens < minTokens) {
    const fallbackCandidates = sentences.map((sentence, idx) => ({
      index: idx,
      text: sentence,
      score: scoreSentenceSalience(sentence, preserve),
      reasons: [],
    }));
    fallbackCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });

    for (const sentence of fallbackCandidates) {
      if (includedIndexes.has(sentence.index)) continue;
      const sentenceTokens = estimateTokens(sentence.text);
      if (currentTokens + sentenceTokens <= maxTokens) {
        includedSentences.push(sentence);
        currentTokens += sentenceTokens;
        includedIndexes.add(sentence.index);
      }
      if (currentTokens >= minTokens) break;
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
  if (maxTokens <= 0) {
    return '';
  }

  if (estimateTokens(chunk) <= maxTokens) {
    return chunk;
  }

  const sentences = splitIntoSentences(chunk);
  if (sentences.length <= 3) {
    return truncateToTokens(chunk, maxTokens).text;
  }

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
  const summary = formatSummary(dedupeSentences(result.map(s => s.text)));
  if (!summary.trim()) {
    return truncateToTokens(chunk, maxTokens).text;
  }
  return summary;
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
  const seen = new Set<string>();

  const sources = keyBlocks.length > 0
    ? keyBlocks.filter(block => block.text && block.kind !== 'code' && block.kind !== 'table' && block.kind !== 'meta')
    : [{
      block_id: '',
      kind: 'paragraph',
      text: content,
      char_len: content.length,
    } as KeyBlock];

  for (const source of sources) {
    const cleaned = stripInlineCode(stripCodeBlocks(source.text));
    if (!cleaned.trim()) continue;

    for (const line of cleaned.split('\n')) {
      if (isJsonLikeLine(line)) continue;
      const quoteMatches = line.matchAll(/"([^"]{20,200})"/g);
      for (const match of quoteMatches) {
        const raw = match[1]?.trim();
        if (!raw || !isLikelyQuote(raw)) continue;
        const normalized = normalizeSentence(raw);
        if (normalized && seen.has(normalized)) continue;
        if (normalized) seen.add(normalized);
        quotes.push({
          text: `"${raw}"`,
          citation: findCitationForText(raw, keyBlocks),
        });
        if (quotes.length >= 5) {
          return quotes;
        }
      }
    }
  }

  return quotes;
}

function stripInlineCode(text: string): string {
  return text.replace(/`[^`]*`/g, '');
}

function stripCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const output: string[] = [];
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
      continue;
    }

    if (inCodeBlock) continue;
    output.push(line);
  }

  return output.join('\n');
}

function isJsonLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^["'][^"']+["']\s*:/.test(trimmed)) return true;
  if (trimmed.startsWith('{') && /["'][^"']+["']\s*:/.test(trimmed)) return true;
  return false;
}

function isLikelyQuote(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const letters = (trimmed.match(/[A-Za-z]/g) || []).length;
  if (letters < 10) return false;
  const symbolCount = (trimmed.match(/[{}\[\]<>:=;]/g) || []).length;
  if (symbolCount / trimmed.length > 0.2) return false;
  if (/\\[nrtu]/.test(trimmed)) return false;
  if (/https?:\/\//i.test(trimmed)) return false;
  return true;
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

function buildQueryTerms(question: string): QueryTerm[] {
  const baseTerms = extractQueryTerms(question);
  return baseTerms.map(term => ({
    base: term,
    variants: expandTermVariants(term),
  }));
}

function extractQueryTerms(question: string): string[] {
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

  const terms = new Set<string>();
  const tokens = question.matchAll(/[A-Za-z0-9]+/g);

  for (const match of tokens) {
    const raw = match[0] ?? '';
    if (!raw) continue;
    const cleaned = raw.toLowerCase();
    if (stopWords.has(cleaned)) continue;

    const isShort = cleaned.length <= 2;
    const keepShort = isShort && (/[A-Z]/.test(raw) || /\d/.test(raw));
    if (isShort && !keepShort) continue;

    terms.add(cleaned);
  }

  return [...terms];
}

function expandTermVariants(term: string): string[] {
  const variants = new Set<string>([term]);

  const stemmed = stemTerm(term);
  if (stemmed && stemmed !== term) variants.add(stemmed);

  if (term.endsWith('ies') && term.length > 4) {
    variants.add(term.slice(0, -3) + 'y');
  }

  return [...variants].filter(v => v.length > 1);
}

function stemTerm(term: string): string {
  if (term.length <= 4) return term;

  const suffixes = ['ments', 'ment', 'tions', 'tion', 'ations', 'ation', 'ings', 'ing', 'ers', 'er', 'ed', 'es', 's'];

  if (term.endsWith('ies') && term.length > 4) {
    return term.slice(0, -3) + 'y';
  }

  for (const suffix of suffixes) {
    if (suffix === 's' && term.length <= 4) continue;
    if (term.endsWith(suffix) && term.length > suffix.length + 2) {
      return term.slice(0, -suffix.length);
    }
  }

  return term;
}

function tokenizeWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function countTermMatches(sentence: string, terms: QueryTerm[]): number {
  if (terms.length === 0) return 0;
  const tokens = tokenizeWords(sentence);
  if (tokens.length === 0) return 0;

  const tokenSet = new Set(tokens);
  let matches = 0;

  for (const term of terms) {
    const matched = term.variants.some(variant => {
      if (!variant) return false;
      if (tokenSet.has(variant)) return true;
      if (variant.length >= 4) {
        return tokens.some(token => token.startsWith(variant));
      }
      return false;
    });
    if (matched) matches++;
  }

  return matches;
}

function scoreRelevance(
  sentence: string,
  preserve: PreserveType[],
  termMatches: number,
  neighborMatches: number
): number {
  let score = scoreSentenceSalience(sentence, preserve);
  const trimmed = sentence.trim();

  if (termMatches > 0) {
    score += termMatches * 3;
    if (isHeadingLine(trimmed)) score += 2;
  }

  if (neighborMatches > 0) {
    score += Math.min(2, neighborMatches);
  }

  return score;
}
