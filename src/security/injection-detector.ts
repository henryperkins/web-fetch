/**
 * Prompt Injection Detection
 *
 * Detects patterns that look like attempts to inject instructions into LLM context.
 * These are quarantined and flagged rather than removed, allowing downstream
 * systems to decide how to handle them.
 */

import type { UnsafeInstruction } from '../types.js';

// Patterns that suggest instruction injection attempts
const INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Direct instruction override attempts
  {
    pattern: /\bignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|guidelines?)\b/i,
    reason: 'Attempts to override previous instructions',
  },
  {
    pattern: /\bforget\s+(everything|all|what)\s+(you\s+)?(?:know|learned|were\s+told)\b/i,
    reason: 'Attempts to clear LLM context',
  },
  {
    pattern: /\byou\s+are\s+now\s+(a|an|in)\s+/i,
    reason: 'Role reassignment attempt',
  },
  {
    pattern: /\bact\s+as\s+(if\s+you\s+are|a|an)\s+/i,
    reason: 'Role reassignment attempt',
  },
  {
    pattern: /\bpretend\s+(you\s+are|to\s+be)\s+/i,
    reason: 'Role reassignment attempt',
  },
  {
    pattern: /\bswitch\s+to\s+(\w+)\s+mode\b/i,
    reason: 'Mode switching attempt',
  },
  {
    pattern: /\benter\s+(\w+)\s+mode\b/i,
    reason: 'Mode switching attempt',
  },
  {
    pattern: /\benable\s+(developer|debug|admin|root|sudo)\s+mode\b/i,
    reason: 'Privilege escalation attempt',
  },

  // System prompt extraction attempts
  {
    pattern: /\b(show|reveal|display|print|output)\s+(me\s+)?(your\s+)?(system\s+)?(prompt|instructions?|rules?)\b/i,
    reason: 'System prompt extraction attempt',
  },
  {
    pattern: /\bwhat\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions?|rules?)\b/i,
    reason: 'System prompt extraction attempt',
  },
  {
    pattern: /\brepeat\s+(your\s+)?(initial|original|system)\s+(prompt|instructions?)\b/i,
    reason: 'System prompt extraction attempt',
  },

  // Jailbreak patterns
  {
    pattern: /\bDAN\s*[\-:]?\s*(mode|prompt|jailbreak)?\b/i,
    reason: 'Known jailbreak pattern (DAN)',
  },
  {
    pattern: /\bdo\s+anything\s+now\b/i,
    reason: 'Known jailbreak pattern (DAN)',
  },
  {
    pattern: /\bjailbreak(ed)?\b/i,
    reason: 'Jailbreak reference',
  },
  {
    pattern: /\b(bypass|circumvent|evade|override)\s+(your\s+)?(safety|security|restrictions?|filters?|guidelines?)\b/i,
    reason: 'Safety bypass attempt',
  },

  // Encoded/obfuscated instruction attempts
  {
    pattern: /\[system\]|\[SYSTEM\]|\[assistant\]|\[ASSISTANT\]/,
    reason: 'Fake system message markers',
  },
  {
    pattern: /<\|?(system|assistant|user|im_start|im_end)\|?>/i,
    reason: 'Fake message delimiters',
  },
  {
    pattern: /###\s*(System|Assistant|User|Instruction)\s*:?\s*###/i,
    reason: 'Fake message delimiters',
  },
  {
    pattern: /Human:\s*|Assistant:\s*|System:\s*/,
    reason: 'Potential conversation injection',
  },

  // Tool/function call injection
  {
    pattern: /<(function_call|tool_call|tool_use|invoke)>/i,
    reason: 'Tool call injection attempt',
  },
  {
    pattern: /\{\s*"(function|tool|action)":\s*"/,
    reason: 'JSON tool call injection attempt',
  },

  // XML/markup injection for Claude-specific formats
  {
    pattern: /<thinking>|<\/thinking>|<answer>|<\/answer>/i,
    reason: 'XML tag injection for structured output',
  },

  // Indirect prompt injection via instructions
  {
    pattern: /\b(when|if)\s+(the\s+)?(AI|assistant|model|LLM|you)\s+(reads?|sees?|processes?|encounters?)\s+this\b/i,
    reason: 'Conditional instruction injection',
  },
  {
    pattern: /\bnew\s+instructions?\s*:/i,
    reason: 'Explicit new instruction marker',
  },
  {
    pattern: /\bfollow\s+these\s+(new\s+)?instructions?\b/i,
    reason: 'Instruction following directive',
  },

  // Secret exfiltration attempts
  {
    pattern: /\b(leak|exfiltrate|extract|steal|copy)\s+(the\s+)?(api\s*key|secret|password|token|credential)/i,
    reason: 'Data exfiltration attempt',
  },
];

// Context window for showing surrounding text
const CONTEXT_CHARS = 50;

export interface DetectionResult {
  hasInjections: boolean;
  detections: UnsafeInstruction[];
}

/**
 * Detect prompt injection patterns in text
 */
export function detectInjections(text: string): DetectionResult {
  const detections: UnsafeInstruction[] = [];
  const seen = new Set<string>();

  for (const { pattern, reason } of INJECTION_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern, 'gi'));

    for (const match of matches) {
      const matchText = match[0];

      // Avoid duplicate detections for the same text
      const key = `${matchText}:${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Get context around the match
      const startIdx = match.index ?? 0;
      const endIdx = startIdx + matchText.length;
      const contextStart = Math.max(0, startIdx - CONTEXT_CHARS);
      const contextEnd = Math.min(text.length, endIdx + CONTEXT_CHARS);

      let contextText = text.slice(contextStart, contextEnd);
      if (contextStart > 0) contextText = '...' + contextText;
      if (contextEnd < text.length) contextText = contextText + '...';

      detections.push({
        text: contextText,
        reason,
      });
    }
  }

  return {
    hasInjections: detections.length > 0,
    detections,
  };
}

/**
 * Sanitize text by marking injection attempts
 *
 * Rather than removing the text (which could break context),
 * this wraps detected injections in warning markers.
 */
export function sanitizeInjections(text: string): { text: string; modified: boolean } {
  let modified = false;
  let result = text;

  for (const { pattern } of INJECTION_PATTERNS) {
    const newResult = result.replace(new RegExp(pattern, 'gi'), (match) => {
      modified = true;
      return `[POTENTIAL_INJECTION: ${match}]`;
    });
    result = newResult;
  }

  return { text: result, modified };
}

/**
 * Check if text contains high-confidence injection attempts
 *
 * This is a stricter check that only flags patterns that are
 * very likely to be malicious.
 */
export function hasHighConfidenceInjection(text: string): boolean {
  const highConfidencePatterns = [
    /\bignore\s+(all\s+)?previous\s+instructions?\b/i,
    /\[SYSTEM\]|\[system\]/,
    /<\|system\|>/i,
    /\bjailbreak\b/i,
    /\bDAN\s+mode\b/i,
  ];

  return highConfidencePatterns.some(p => p.test(text));
}

/**
 * Score the injection risk of a piece of text
 * Returns a value from 0 (safe) to 1 (very suspicious)
 */
export function scoreInjectionRisk(text: string): number {
  const detections = detectInjections(text);
  if (!detections.hasInjections) return 0;

  // Weight by number and severity
  const count = detections.detections.length;

  // Check for high-confidence patterns
  const hasHighConfidence = hasHighConfidenceInjection(text);

  if (hasHighConfidence) {
    return Math.min(1, 0.7 + count * 0.1);
  }

  return Math.min(1, count * 0.15);
}
