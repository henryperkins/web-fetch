/**
 * Core types for web-fetch-mcp
 */

// ============================================
// FETCH OPTIONS
// ============================================

export type FetchMode = 'auto' | 'http' | 'render';
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
export type OutputFormat = 'llm_packet' | 'raw' | 'normalized';
export type ChunkStrategy = 'headings_first' | 'balanced';
export type CompactMode = 'structural' | 'salience' | 'map_reduce' | 'question_focused';

export interface RenderOptions {
  wait_until?: WaitUntil;
  wait_ms?: number;
  block_third_party?: boolean;
  screenshot?: boolean;
  selector?: string;
}

export interface ExtractionOptions {
  prefer_readability?: boolean;
  keep_tables?: boolean;
  keep_code_blocks?: boolean;
  remove_selectors?: string[];
}

export interface FormatOptions {
  output?: OutputFormat;
  include_raw_excerpt?: boolean;
}

export interface FetchOptions {
  mode?: FetchMode;
  headers?: Record<string, string>;
  timeout_ms?: number;
  max_bytes?: number;
  max_redirects?: number;
  user_agent?: string;
  respect_robots?: boolean;
  cache_ttl_s?: number;
  render?: RenderOptions;
  extraction?: ExtractionOptions;
  format?: FormatOptions;
  ai_search?: AiSearchOptions;
}

export type AiSearchQueryMode = 'search' | 'ai_search';

export interface AiSearchQueryOptions {
  query: string;
  mode?: AiSearchQueryMode;
  rewrite_query?: boolean;
  max_num_results?: number;
  ranking_options?: {
    score_threshold?: number;
  };
  reranking?: {
    enabled?: boolean;
    model?: string;
  };
  filters?: Record<string, unknown>;
  model?: string;
  system_prompt?: string;
}

export interface AiSearchOptions {
  enabled?: boolean;
  prefix?: string;
  max_file_bytes?: number;
  wait_ms?: number;
  skip_if_exists?: boolean;
  require_success?: boolean;
  query?: AiSearchQueryOptions;
}

// ============================================
// EXTRACT OPTIONS
// ============================================

export interface ExtractInput {
  url?: string;
  raw_bytes?: Buffer;
  content_type?: string;
  canonical_url?: string;
}

export interface ExtractOptions {
  extraction?: ExtractionOptions;
  format?: FormatOptions;
}

// ============================================
// CHUNK OPTIONS
// ============================================

export interface ChunkOptions {
  max_tokens: number;
  margin_ratio?: number;
  strategy?: ChunkStrategy;
}

// ============================================
// COMPACT OPTIONS
// ============================================

export type PreserveType = 'numbers' | 'dates' | 'names' | 'definitions' | 'procedures';

export interface CompactOptions {
  max_tokens: number;
  mode?: CompactMode;
  question?: string;
  preserve?: PreserveType[];
}

// ============================================
// OUTPUT TYPES
// ============================================

export interface OutlineEntry {
  level: number;
  text: string;
  path: string;
}

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'code' | 'table' | 'quote' | 'meta';

export interface KeyBlock {
  block_id: string;
  kind: BlockKind;
  text: string;
  char_len: number;
}

export interface Citation {
  block_id: string;
  loc: {
    start_char: number;
    end_char: number;
  };
}

export interface UnsafeInstruction {
  text: string;
  reason: string;
}

export type WarningType =
  | 'truncated'
  | 'paywalled'
  | 'low_confidence_date'
  | 'scanned_pdf'
  | 'render_timeout'
  | 'extraction_fallback'
  | 'rate_limited'
  | 'robots_blocked'
  | 'injection_detected';

export interface Warning {
  type: WarningType;
  message: string;
}

export interface LLMPacketMetadata {
  title?: string;
  site_name?: string;
  author?: string;
  published_at?: string | null;
  language?: string;
  page_count?: number;
  estimated_reading_time_min?: number;
}

export interface LLMPacket {
  source_id: string;
  original_url: string;
  canonical_url: string;
  retrieved_at: string;
  status: number;
  content_type: string;
  metadata: LLMPacketMetadata;
  outline: OutlineEntry[];
  key_blocks: KeyBlock[];
  content: string;
  source_summary: string[];
  citations: Citation[];
  unsafe_instructions_detected: UnsafeInstruction[];
  warnings: Warning[];
  hashes: {
    content_hash: string;
    raw_hash: string;
  };
  raw_excerpt?: string;
  screenshot_base64?: string;
}

export interface NormalizedContent {
  source_id: string;
  original_url: string;
  canonical_url: string;
  retrieved_at: string;
  status: number;
  content_type: string;
  metadata: LLMPacketMetadata;
  outline: OutlineEntry[];
  key_blocks: KeyBlock[];
  content: string;
  source_summary: string[];
  citations: Citation[];
  unsafe_instructions_detected: UnsafeInstruction[];
  warnings: Warning[];
  raw_excerpt?: string;
  screenshot_base64?: string;
}

export interface Chunk {
  chunk_id: string;
  chunk_index: number;
  headings_path: string;
  est_tokens: number;
  text: string;
  char_len: number;
}

export interface ChunkSet {
  source_id: string;
  max_tokens: number;
  total_chunks: number;
  total_est_tokens: number;
  chunks: Chunk[];
}

export interface CompactedKeyPoint {
  text: string;
  citation: string;
}

export interface CompactedPacket {
  source_id: string;
  original_url: string;
  compacted: {
    summary: string;
    key_points: CompactedKeyPoint[];
    important_quotes: CompactedKeyPoint[];
    omissions: string[];
    warnings: string[];
  };
  est_tokens: number;
}

// ============================================
// FETCH RESULT
// ============================================

export interface FetchResult {
  success: boolean;
  packet?: LLMPacket;
  normalized?: NormalizedContent;
  raw?: {
    bytes: Buffer;
    content_type: string;
    headers: Record<string, string>;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ============================================
// INTERNAL TYPES
// ============================================

export interface RawFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
  contentType: string;
}

export interface ExtractedContent {
  title: string;
  content: string;
  textContent: string;
  excerpt: string;
  byline?: string;
  siteName?: string;
  lang?: string;
  publishedTime?: string;
}

export interface ContentTypeInfo {
  type: 'html' | 'markdown' | 'pdf' | 'json' | 'xml' | 'text' | 'unknown';
  mimeType: string;
  charset?: string;
}

export interface RobotsResult {
  allowed: boolean;
  crawlDelay?: number;
}

// ============================================
// CONFIGURATION
// ============================================

export interface Config {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  blockPrivateIp: boolean;
  allowlistDomains: string[];
  rateLimitPerHost: number;
  defaultMaxTokens: number;
  chunkMarginRatio: number;
  respectRobots: boolean;
  playwrightEnabled: boolean;
  pdfEnabled: boolean;
  cacheTtlS: number;
  renderBlockThirdParty: boolean;
  renderTimeoutMs: number;
  userAgent: string;
  aiSearchEnabled: boolean;
  aiSearchAccountId?: string;
  aiSearchName?: string;
  aiSearchApiToken?: string;
  aiSearchR2AccessKeyId?: string;
  aiSearchR2SecretAccessKey?: string;
  aiSearchR2Bucket?: string;
  aiSearchR2Endpoint?: string;
  aiSearchR2Prefix?: string;
  aiSearchMaxFileBytes: number;
  aiSearchQueryTimeoutMs: number;
  aiSearchQueryWaitMs: number;
  aiSearchMaxQueryWaitMs: number;
}
