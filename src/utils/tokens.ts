/**
 * Token estimation utilities
 *
 * Uses a simple heuristic-based approach that approximates GPT/Claude tokenization.
 * For exact counts, you'd need the actual tokenizer, but this is sufficient for chunking.
 */

// Average characters per token for English text
// This is a conservative estimate that tends to slightly overcount
const CHARS_PER_TOKEN = 3.5;

// Adjustments for different content types
const CODE_CHARS_PER_TOKEN = 3.0; // Code tends to tokenize less efficiently
const CJK_CHARS_PER_TOKEN = 1.5; // CJK characters are often their own tokens

// CJK Unicode ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/gu;

/**
 * Estimate token count for a string
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Count CJK characters
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Detect if text is predominantly code
  const isCode = detectCode(text);

  // Remove CJK characters for regular counting
  const nonCjkText = text.replace(CJK_REGEX, '');

  // Estimate tokens
  const charsPerToken = isCode ? CODE_CHARS_PER_TOKEN : CHARS_PER_TOKEN;
  const regularTokens = Math.ceil(nonCjkText.length / charsPerToken);
  const cjkTokens = Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN);

  return regularTokens + cjkTokens;
}

/**
 * Detect if text is predominantly code
 */
function detectCode(text: string): boolean {
  // Quick heuristics for code detection
  const codeIndicators = [
    /^\s*(function|const|let|var|class|import|export|def|async|await)\s/m,
    /[{}\[\]();]/,
    /=>/,
    /^\s*#include/m,
    /^\s*package\s+/m,
    /^\s*use\s+/m,
  ];

  let codeScore = 0;
  for (const indicator of codeIndicators) {
    if (indicator.test(text)) {
      codeScore++;
    }
  }

  // Also check line characteristics
  const lines = text.split('\n');
  const indentedLines = lines.filter(l => /^\s{2,}/.test(l)).length;
  const shortLines = lines.filter(l => l.length < 80).length;

  if (indentedLines > lines.length * 0.3) codeScore++;
  if (shortLines > lines.length * 0.7) codeScore++;

  return codeScore >= 3;
}

/**
 * Truncate text to approximately max tokens
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const currentTokens = estimateTokens(text);

  if (currentTokens <= maxTokens) {
    return { text, truncated: false };
  }

  // Estimate how many characters we need
  const ratio = maxTokens / currentTokens;
  const targetChars = Math.floor(text.length * ratio * 0.95); // 5% safety margin

  // Try to cut at a sentence or paragraph boundary
  let truncated = text.substring(0, targetChars);

  // Try to find a good break point
  const lastParagraph = truncated.lastIndexOf('\n\n');
  const lastSentence = truncated.search(/[.!?]\s+[A-Z][^.!?]*$/);
  const lastNewline = truncated.lastIndexOf('\n');

  if (lastParagraph > targetChars * 0.8) {
    truncated = truncated.substring(0, lastParagraph);
  } else if (lastSentence > targetChars * 0.8) {
    truncated = truncated.substring(0, lastSentence + 1);
  } else if (lastNewline > targetChars * 0.9) {
    truncated = truncated.substring(0, lastNewline);
  }

  return { text: truncated.trim(), truncated: true };
}

/**
 * Calculate estimated reading time in minutes
 */
export function estimateReadingTime(text: string): number {
  // Average reading speed: 200-250 words per minute
  // We'll use 225 wpm
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(1, Math.ceil(words / 225));
}
