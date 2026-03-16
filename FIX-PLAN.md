# Fix Plan: web-fetch-mcp Quality Issues

Based on deep evaluation of all 5 tools. 14 issues across 7 files.

---

## Phase 1: Critical Bugs (data loss / wrong results)

### 1.1 Chunker silently truncates content when key_blocks has abbreviated text

**File:** `src/processing/chunker.ts`
**Function:** `chunkContent()` (line 36) and `buildBlocksFromKeyBlocks()` (line 176)
**Problem:** When `key_blocks` is populated, `buildBlocksFromKeyBlocks()` is called first (line 52-53). If key_blocks contains truncated text (e.g. from a manual caller or serialization), the chunker uses that instead of the full `content` field, silently losing content.
**Root cause:** No validation that key_blocks text coverage matches content length.

**Fix — 3 steps:**

1. In `chunkContent()`, after `buildBlocksFromKeyBlocks(packet)` returns, compute the total character length of all block texts joined. Compare it to `packet.content.length`.

2. If block text total is less than 80% of content length, discard the blocks result and fall through to the `findChunkBoundaries` path (the existing fallback that uses `content` directly).

3. Add a unit test in `tests/unit/chunker.test.ts`:
   - Pass a packet with `content` = 500 chars of prose, `key_blocks` = [one block with truncated 30-char text]
   - Assert: chunks cover the full 500 chars of content, not just 30

**Specific code change in `chunkContent()`:**
```typescript
const blocks = buildBlocksFromKeyBlocks(packet);
if (blocks.length > 0) {
  // Validate blocks cover the content
  const blocksTextLen = blocks.reduce((sum, b) => sum + b.text.length, 0);
  const contentLen = content.length;
  if (blocksTextLen >= contentLen * 0.8) {
    // ... existing block-based chunking path ...
  }
  // else: fall through to boundary-based chunking below
}
```

---

### 1.2 question_focused compaction fails on semantic matching

**File:** `src/processing/compactor.ts`
**Functions:** `buildQueryTerms()` (line 1088), `extractQueryTerms()` (line 1096), `expandTermVariants()` (line 1127), `countTermMatches()` (line 1163)
**Problem:** "What are the health stories?" fails to match "meningitis", "hospital", "antibiotics", "died" because the only expansion is a basic suffix stemmer. No synonym or semantic-neighbor expansion.

**Fix — 4 steps:**

1. Create a new file `src/processing/synonyms.ts` containing a curated synonym/related-term map for common query domains. This is NOT a full thesaurus — it's a small, targeted map (~50-80 entries) of common query concepts to their likely content terms:
   ```typescript
   const SYNONYM_MAP: Record<string, string[]> = {
     health: ['medical', 'hospital', 'disease', 'illness', 'death', 'died',
              'vaccine', 'symptom', 'outbreak', 'infection', 'patient',
              'doctor', 'treatment', 'diagnosis', 'antibiotics', 'meningitis',
              'cancer', 'surgery', 'pandemic', 'epidemic'],
     war: ['conflict', 'military', 'troops', 'attack', 'invasion',
           'combat', 'strikes', 'bombing', 'forces', 'weapons'],
     economy: ['economic', 'jobs', 'unemployment', 'inflation', 'gdp',
               'market', 'trade', 'recession', 'growth', 'budget', 'tax'],
     technology: ['tech', 'software', 'ai', 'algorithm', 'data',
                  'digital', 'app', 'platform', 'internet', 'cyber'],
     politics: ['political', 'government', 'election', 'vote', 'parliament',
                'president', 'minister', 'policy', 'legislation', 'party'],
     climate: ['weather', 'warming', 'emissions', 'carbon', 'temperature',
               'flood', 'drought', 'renewable', 'fossil', 'environmental'],
     // ... etc
   };

   export function expandWithSynonyms(term: string): string[] {
     const lower = term.toLowerCase();
     const expanded = new Set<string>([lower]);

     // Direct lookup
     if (SYNONYM_MAP[lower]) {
       SYNONYM_MAP[lower].forEach(s => expanded.add(s));
     }

     // Reverse lookup: if term appears in any synonym list, add that key
     for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
       if (synonyms.includes(lower)) {
         expanded.add(key);
         synonyms.forEach(s => expanded.add(s));
       }
     }

     return [...expanded];
   }
   ```

2. In `expandTermVariants()` (compactor.ts line 1127), after the existing stem expansion, call `expandWithSynonyms(term)` and add results to the variants set.

3. In `countTermMatches()` (line 1163), the existing logic checks exact token match and 4+ char prefix match. This is sufficient — the synonym expansion in step 2 means the variants list now includes related terms, so the existing matching logic will find them.

4. Add a unit test:
   - Question: "What are the health stories?"
   - Content: BBC feed with meningitis, hospital, antibiotics stories
   - Assert: meningitis/hospital sentences are included in the compacted summary
   - Assert: unrelated stories (Oscars, NCP) are excluded

---

### 1.3 map_reduce drops all body content, keeps only headings

**File:** `src/processing/compactor.ts`
**Function:** `scoreSentenceSalience()` (line 775)
**Problem:** Headings get +3, most body sentences get 0 or +1. When map_reduce's iterative compression loop (line 461-472) removes the bottom 20% by salience each iteration, body text is always cut first. For a news feed, the result is just a heading list.

**Fix — 2 steps:**

1. In `scoreSentenceSalience()`, reduce the heading bonus from +3 to +1. Headings should be slightly preferred for structural context, not overwhelmingly preferred over substantive body text.

2. Add a "follows heading" contextual bonus: in `mapReduceCompaction()`, after scoring sentences, give +1 to any sentence that immediately follows a heading (index = heading_index + 1). This preserves the heading's lead paragraph (which usually contains the most important information) while still allowing further body paragraphs to be cut.

**Specific code change in `scoreSentenceSalience()`:**
```typescript
// Change line 794:
if (isHeadingLine(trimmed)) score += 1;  // was: score += 3
```

**Specific code change in `mapReduceCompaction()`** after `scored` array is built (around line 464):
```typescript
// Add context bonus: sentence right after a heading gets +2
for (let i = 1; i < scored.length; i++) {
  if (isHeadingLine(scored[i - 1].text.trim())) {
    scored[i].score += 2;
  }
}
```

**Note:** This change also affects `salienceCompaction` and `questionFocusedCompaction` which both call `scoreSentenceSalience`. The heading score reduction is correct for all modes — the current +3 is too dominant everywhere. But validate with tests that salience mode still includes headings (they also get +1 from list detection if they start with `-`, or +2 from numbers/dates if present).

---

## Phase 2: Medium Issues (poor output quality)

### 2.1 source_summary extracts heading names, not actual topics

**File:** `src/processing/normalizer.ts`
**Function:** `generateSourceSummary()` (line 325)
**Problem:** `Main topics:` line just joins top-level outline heading text. For BBC RSS, this produces "BBC News, Feed Info, Recent Items" instead of actual topics.

**Fix — 3 steps:**

1. After the existing outline-based topic line, add a **term frequency extraction** pass over the body content (excluding headings). Tokenize into words, remove stop words, count frequency, take top 5-8 terms.

2. Format as: `"Key topics: meningitis, Iran, Oscars, NCP, Strait of Hormuz"` — this goes after the existing main topics line (or replaces it if outline headings are generic like "Recent Items").

3. Heuristic for "generic" headings: if a heading is fewer than 3 words or matches common boilerplate patterns (e.g., "Recent Items", "Feed Info", "Navigation", "Contents", "Introduction"), skip it and use the TF-based topics instead.

**New helper function:**
```typescript
function extractTopicTerms(content: string, maxTerms: number = 8): string[] {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'this', 'that', 'it', 'its', 'not', 'more',
    'than', 'will', 'can', 'would', 'could', 'should', 'also', 'as',
    'about', 'which', 'who', 'what', 'when', 'where', 'how', 'their',
    'there', 'they', 'them', 'he', 'she', 'his', 'her', 'our', 'your',
    'all', 'some', 'any', 'most', 'other', 'into', 'over', 'after',
    'before', 'between', 'under', 'new', 'said', 'says', 'just', 'been',
    // Common markdown/structural noise
    'read', 'http', 'https', 'www', 'com', 'html', 'org',
  ]);

  // Strip markdown links, keeping link text
  const cleaned = content
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');

  const freq = new Map<string, number>();
  const words = cleaned.toLowerCase().match(/[a-z]{3,}/g) || [];

  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }

  return [...freq.entries()]
    .filter(([_, count]) => count >= 2) // appears at least twice
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([word]) => word);
}
```

### 2.2 source_summary key numbers are noise

**File:** `src/processing/normalizer.ts`
**Function:** `generateSourceSummary()` (line 337-342)
**Problem:** The regex `\d+(?:,\d{3})*(?:\.\d+)?%?` matches any number, including dates, list indices, URL fragments. "Key numbers: 36, 16, 2026, 22, 15" is useless.

**Fix — 2 steps:**

1. Replace the bare number regex with a **number-in-context** extractor. Only capture numbers that appear next to meaningful words (currency, quantities, percentages, counts):
   ```typescript
   // Match numbers with meaningful context
   const contextPatterns = [
     /\$[\d,]+(?:\.\d+)?[KMB]?/g,                    // Currency: $53m, $1,000
     /\d+(?:,\d{3})*(?:\.\d+)?\s*%/g,                 // Percentages: 15%, 3.5%
     /\d+(?:,\d{3})+/g,                                // Large numbers with commas: 1,000
     /(?:approximately|about|nearly|over|under|around|roughly)\s+\d+/gi, // Qualified numbers
     /\d+\s+(?:people|jobs|deaths|cases|patients|users|dollars|pounds|million|billion|percent)/gi,
   ];
   ```

2. Deduplicate and format: `"Key figures: $53m, 700 jobs, 11 seriously ill"`

### 2.3 key_points are just headings

**File:** `src/processing/compactor.ts`
**Function:** `extractKeyPoints()` (line 854)
**Problem:** Threshold is `score >= 2`. Headings score 1 (after fix 1.3 reduces it from 3) plus they get +1 from isHeadingLine in salience scoring. Body sentences with a number get +2. The threshold is too low for meaningful filtering.

**Fix — 2 steps:**

1. Raise the key_points threshold from `score >= 2` to `score >= 3`. This means a sentence needs at least two positive signals (e.g., contains a number AND a date, or contains a definition AND a name).

2. Exclude pure heading lines from key_points. A heading is structural context, not a key point. Filter:
   ```typescript
   if (score >= 3 && !isHeadingLine(sentence.trim()) && normalized && !seen.has(normalized)) {
   ```

### 2.4 important_quotes always empty

**File:** `src/processing/compactor.ts`
**Function:** `extractQuotes()` (line 874)
**Problem:** Only matches `"double-quoted text"` via regex `/"([^"]{20,200})"/g`. News and web content predominantly uses single quotes (`'beyond devastated'`), smart quotes, or `<blockquote>` elements (already converted to `>` in markdown).

**Fix — 3 steps:**

1. Extend the quote regex to also match single quotes and smart quotes:
   ```typescript
   const quotePatterns = [
     /"([^"]{20,200})"/g,              // straight double quotes
     /\u201c([^\u201d]{20,200})\u201d/g, // smart double quotes
     /'([^']{20,200})'/g,              // straight single quotes (careful: apostrophes)
     /\u2018([^\u2019]{20,200})\u2019/g, // smart single quotes
   ];
   ```

2. For single-quote matches, add an extra validation pass to filter out apostrophe-bounded text (e.g., "it's raining and they're going" shouldn't match). Check: the character before the opening quote should be whitespace or line-start, and the text inside should contain at least one space (multi-word).

3. Also match markdown blockquotes (`> text`) as important quotes:
   ```typescript
   // After the regex-based quote extraction
   for (const line of cleaned.split('\n')) {
     if (line.startsWith('> ')) {
       const quoteText = line.replace(/^>\s*/, '').trim();
       if (quoteText.length >= 20 && quoteText.length <= 200 && isLikelyQuote(quoteText)) {
         // ... add to quotes
       }
     }
   }
   ```

### 2.5 No title extracted from HTML pages

**File:** `src/extractors/html-extractor.ts`
**Problem:** When Readability extraction doesn't return a title, the `<title>` tag value is not used as fallback.

**Fix — 2 steps:**

1. Read the current `extractHtml()` function to confirm the issue. Check if `extractedContent.title` is populated from Readability's `.title` property.

2. Add a fallback: before returning, if `title` is empty, parse `<title>` from raw HTML:
   ```typescript
   if (!title) {
     const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
     if (titleMatch) {
       title = titleMatch[1].trim();
     }
   }
   ```

### 2.6 Force-split breaks mid-sentence in chunker

**File:** `src/processing/chunker.ts`
**Function:** `splitTextByTokens()` (line 436)
**Problem:** For dense prose with no paragraph breaks, the split hierarchy is: paragraph break > sentence boundary > line break > character position. But `findSentenceBoundary` returns the LAST sentence boundary before the split point, and its regex `[.!?]["')\]]?\s+` requires trailing whitespace. At end-of-chunk, the last sentence may not have trailing whitespace, causing fallback to line or character split.

**Fix — 2 steps:**

1. In `splitTextByTokens()`, after computing `splitPoint`, try sentence boundary first (before paragraph):
   ```typescript
   // Prefer sentence boundaries over paragraph breaks for prose
   const sentenceEnd = findSentenceBoundary(remaining.substring(0, splitPoint));
   if (sentenceEnd > splitPoint * 0.5) {
     splitPoint = sentenceEnd;
   } else {
     const paragraphEnd = remaining.lastIndexOf('\n\n', splitPoint);
     if (paragraphEnd > splitPoint * 0.5) {
       splitPoint = paragraphEnd;
     } else {
       const lineEnd = remaining.lastIndexOf('\n', splitPoint);
       if (lineEnd > splitPoint * 0.5) {
         splitPoint = lineEnd;
       }
     }
   }
   ```

2. Fix `findSentenceBoundary()` to also match sentence-final positions (period at end of text without trailing whitespace). The existing code has a fallback for this (lines 428-431) but it only checks the trimmed full text, not substrings. Adjust:
   ```typescript
   // Also check if text ends at a sentence boundary
   const trimmedSubstr = text.substring(0, splitPoint).replace(/\s+$/, '');
   if (/[.!?]["')\]]?$/.test(trimmedSubstr)) {
     return trimmedSubstr.length;
   }
   ```

---

## Phase 3: Low-Priority / Polish

### 3.1 key_blocks treats every paragraph as a block

**File:** `src/processing/normalizer.ts`
**Function:** `extractKeyBlocks()` (line 193)
**Problem:** Every non-empty text region becomes a key_block. A page with 21 small paragraphs gets 21 blocks. "Key" implies selection/ranking.

**Fix — 2 steps:**

1. After building all blocks, if there are more than 15, filter to keep only:
   - All headings
   - Blocks with char_len >= 50 (substantial content)
   - The first 3 and last 1 paragraph blocks (intro + conclusion context)
   - Any code or table blocks

2. Cap key_blocks at 20 entries max. Truncate the list and add a warning.

### 3.2 extract tool deprecation message is confusing

**File:** `src/tools/extract.ts`
**Problem:** The tool's input schema says `"deprecated: use fetch tool"` for both `url` and `raw_bytes` fields. But the extract tool itself still works and has a distinct purpose (process already-fetched content). The deprecation is on the *fields within extract*, not the tool itself — confusing.

**Fix:**

1. Change the field descriptions to clarify:
   - `url`: `"URL to fetch and extract from. Consider using the fetch tool instead for full pipeline (AI Search, caching)."`
   - `raw_bytes`: `"Base64-encoded raw bytes to extract from. Consider using the fetch tool with raw_bytes parameter instead."`

### 3.3 AI Search indexes raw/dirty content for complex pages

**File:** `src/ai-search/index.ts` (the upload/ingest function)
**Problem:** When extraction partially fails or produces dirty markdown (raw JSON/HTML leaking through), that dirty content gets uploaded to R2 and indexed. Later queries surface this noise.

**Fix — 2 steps:**

1. Before uploading to R2, add a content quality check:
   ```typescript
   function isCleanContent(markdown: string): boolean {
     // Reject if content has too many JSON-like patterns
     const jsonPatterns = (markdown.match(/"__typename"|"edges"|"node"/g) || []).length;
     if (jsonPatterns > 5) return false;

     // Reject if content has too many HTML tags
     const htmlTags = (markdown.match(/<[a-z]+[^>]*>/gi) || []).length;
     if (htmlTags > 10) return false;

     // Reject if letter-to-symbol ratio is too low
     const letters = (markdown.match(/[a-zA-Z]/g) || []).length;
     const total = markdown.length;
     if (total > 100 && letters / total < 0.4) return false;

     return true;
   }
   ```

2. If content fails quality check, skip the AI Search upload and add a warning to the response: `"AI Search upload skipped: content quality too low for indexing"`.

---

## Phase 4: Testing

### 4.1 Unit tests for all fixes

**New/modified test files:**

1. **`tests/unit/chunker.test.ts`** — Add:
   - Test: truncated key_blocks falls back to content (1.1)
   - Test: force-split respects sentence boundaries (2.6)

2. **`tests/unit/compact.test.ts`** — Add:
   - Test: question_focused with synonym expansion matches related terms (1.2)
   - Test: map_reduce preserves body text after heading, not just headings (1.3)
   - Test: key_points excludes bare headings (2.3)
   - Test: important_quotes matches single-quoted text (2.4)

3. **`tests/unit/normalizer.test.ts`** — Add (or create):
   - Test: source_summary uses TF-extracted topics for generic headings (2.1)
   - Test: key numbers only captures contextual numbers, not date fragments (2.2)
   - Test: title falls back to `<title>` tag (2.5)
   - Test: key_blocks capped at 20 for large documents (3.1)

4. **`tests/unit/synonyms.test.ts`** — New:
   - Test: "health" expands to include medical/hospital/disease
   - Test: "war" expands to include military/conflict/attack
   - Test: unknown terms return only stem variants (no crash)

### 4.2 Integration test

**`tests/integration/quality.test.ts`** — New:

End-to-end quality assertion: fetch BBC RSS → compact with question_focused("health stories") → assert meningitis content is present in summary.

---

## Execution Order

| Step | Phase | Issue | File(s) | Risk |
|------|-------|-------|---------|------|
| 1 | 1.1 | Chunker key_blocks truncation | chunker.ts | Low — additive guard |
| 2 | 1.3 | Heading score reduction | compactor.ts | Medium — affects all compact modes |
| 3 | 1.2 | Synonym expansion | NEW synonyms.ts, compactor.ts | Low — additive |
| 4 | 2.1 | Source summary topics | normalizer.ts | Low — additive |
| 5 | 2.2 | Key numbers context | normalizer.ts | Low — replace regex |
| 6 | 2.3 | key_points threshold | compactor.ts | Low — threshold change |
| 7 | 2.4 | Quote patterns | compactor.ts | Low — additive |
| 8 | 2.5 | Title fallback | html-extractor.ts | Low — additive |
| 9 | 2.6 | Sentence-boundary splits | chunker.ts | Medium — changes split behavior |
| 10 | 3.1 | key_blocks cap | normalizer.ts | Low — additive filter |
| 11 | 3.2 | Extract deprecation msg | extract.ts | Trivial — text change |
| 12 | 3.3 | AI Search quality gate | ai-search/index.ts | Low — additive guard |
| 13 | 4.x | All tests | tests/ | None |

**Build + test after each step.** Steps 2 and 9 are the highest risk for regressions — run full test suite after those.
