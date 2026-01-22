Below are the **complete, drop-in files** to implement a **conversation/thread-scoped, session-resilient KB** for `web-fetch-mcp`.

**What this delivers**

- **Per-thread (per conversation) isolation** via a stable `thread_key`

- **Persistence across restarts/sessions** via `~/.config/web-fetch-mcp/ai-search-state.json`

- **Auto-scoped uploads + auto-scoped queries** (queries only search what that thread fetched)

- **No need to pass special prefixes**: scoping is handled internally

- Optional fallback to **workspace scope** when `thread_key` is missing


---

## 1) `src/types.ts`

```ts
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
export type AiSearchScope = 'conversation' | 'workspace' | 'global';

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
  /** Optional per-request thread key to scope uploads/queries to a conversation. */
  thread_key?: string;
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
  original_url?: string;
  key_blocks?: KeyBlock[];
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
    key_points: string[];
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

  // AI Search / KB
  aiSearchEnabled: boolean;
  aiSearchScope: AiSearchScope;
  aiSearchThreadKey?: string;
  aiSearchStateDir: string;
  aiSearchRequireThreadKey: boolean;
  aiSearchWorkspaceRoot?: string;

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
```

---

## 2) `src/config.ts`

```ts
/**
 * Configuration management for web-fetch-mcp
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type { AiSearchScope, Config } from './types.js';

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseFloat_(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseStringArray(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function parseAiSearchScope(value: string | undefined, defaultValue: AiSearchScope): AiSearchScope {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'conversation' || normalized === 'thread') return 'conversation';
  if (normalized === 'workspace' || normalized === 'project' || normalized === 'cwd') return 'workspace';
  if (normalized === 'global') return 'global';
  return defaultValue;
}

export function loadConfig(): Config {
  return {
    maxBytes: parseNumber(process.env['MAX_BYTES'], 10 * 1024 * 1024), // 10MB
    timeoutMs: parseNumber(process.env['TIMEOUT_MS'], 30000),
    maxRedirects: parseNumber(process.env['MAX_REDIRECTS'], 5),
    blockPrivateIp: parseBoolean(process.env['BLOCK_PRIVATE_IP'], true),
    allowlistDomains: parseStringArray(process.env['ALLOWLIST_DOMAINS']),
    rateLimitPerHost: parseNumber(process.env['RATE_LIMIT_PER_HOST'], 60),
    defaultMaxTokens: parseNumber(process.env['DEFAULT_MAX_TOKENS'], 4000),
    chunkMarginRatio: parseFloat_(process.env['CHUNK_MARGIN_RATIO'], 0.10),
    respectRobots: parseBoolean(process.env['RESPECT_ROBOTS'], true),
    playwrightEnabled: parseBoolean(process.env['PLAYWRIGHT_ENABLED'], false),
    pdfEnabled: parseBoolean(process.env['PDF_ENABLED'], true),
    cacheTtlS: parseNumber(process.env['CACHE_TTL_S'], 300),
    renderBlockThirdParty: parseBoolean(process.env['RENDER_BLOCK_THIRD_PARTY'], true),
    renderTimeoutMs: parseNumber(process.env['RENDER_TIMEOUT_MS'], 60000),
    userAgent: process.env['USER_AGENT'] || 'web-fetch-mcp/1.0 (+https://github.com/example/web-fetch-mcp)',

    // AI Search / KB
    aiSearchEnabled: parseBoolean(process.env['AI_SEARCH_ENABLED'], false),
    aiSearchScope: parseAiSearchScope(process.env['AI_SEARCH_SCOPE'], 'conversation'),
    aiSearchThreadKey: process.env['WEB_FETCH_THREAD_KEY'] ?? process.env['AI_SEARCH_THREAD_KEY'],
    aiSearchStateDir: process.env['AI_SEARCH_STATE_DIR'] || path.join(os.homedir(), '.config', 'web-fetch-mcp'),
    aiSearchRequireThreadKey: parseBoolean(process.env['AI_SEARCH_REQUIRE_THREAD_KEY'], false),
    aiSearchWorkspaceRoot: process.env['AI_SEARCH_WORKSPACE_ROOT'],

    aiSearchAccountId: process.env['CF_ACCOUNT_ID'],
    aiSearchName: process.env['CF_AI_SEARCH_NAME'],
    aiSearchApiToken: process.env['CF_AI_SEARCH_API_TOKEN'],

    aiSearchR2AccessKeyId: process.env['CF_R2_ACCESS_KEY_ID'],
    aiSearchR2SecretAccessKey: process.env['CF_R2_SECRET_ACCESS_KEY'],
    aiSearchR2Bucket: process.env['CF_R2_BUCKET'],
    aiSearchR2Endpoint: process.env['CF_R2_ENDPOINT'],
    aiSearchR2Prefix: process.env['CF_R2_PREFIX'],

    aiSearchMaxFileBytes: parseNumber(process.env['AI_SEARCH_MAX_FILE_BYTES'], 4 * 1024 * 1024),
    aiSearchQueryTimeoutMs: parseNumber(process.env['AI_SEARCH_QUERY_TIMEOUT_MS'], 15000),
    aiSearchQueryWaitMs: parseNumber(process.env['AI_SEARCH_QUERY_WAIT_MS'], 0),
    aiSearchMaxQueryWaitMs: parseNumber(process.env['AI_SEARCH_MAX_QUERY_WAIT_MS'], 15000),
  };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}

// Validate configuration
export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (config.maxBytes < 1024) {
    errors.push('MAX_BYTES must be at least 1024 bytes');
  }
  if (config.maxBytes > 100 * 1024 * 1024) {
    errors.push('MAX_BYTES must be at most 100MB');
  }
  if (config.timeoutMs < 1000) {
    errors.push('TIMEOUT_MS must be at least 1000ms');
  }
  if (config.timeoutMs > 300000) {
    errors.push('TIMEOUT_MS must be at most 300000ms (5 minutes)');
  }
  if (config.maxRedirects < 0 || config.maxRedirects > 20) {
    errors.push('MAX_REDIRECTS must be between 0 and 20');
  }
  if (config.rateLimitPerHost < 1 || config.rateLimitPerHost > 1000) {
    errors.push('RATE_LIMIT_PER_HOST must be between 1 and 1000');
  }
  if (config.chunkMarginRatio < 0 || config.chunkMarginRatio > 0.5) {
    errors.push('CHUNK_MARGIN_RATIO must be between 0 and 0.5');
  }
  if (config.defaultMaxTokens < 100) {
    errors.push('DEFAULT_MAX_TOKENS must be at least 100');
  }
  if (config.aiSearchMaxFileBytes < 1024) {
    errors.push('AI_SEARCH_MAX_FILE_BYTES must be at least 1024 bytes');
  }
  if (config.aiSearchQueryTimeoutMs < 1000) {
    errors.push('AI_SEARCH_QUERY_TIMEOUT_MS must be at least 1000ms');
  }
  if (config.aiSearchMaxQueryWaitMs < 0) {
    errors.push('AI_SEARCH_MAX_QUERY_WAIT_MS must be at least 0ms');
  }

  // Validate AI Search credentials when enabled
  if (config.aiSearchEnabled) {
    if (!config.aiSearchStateDir || config.aiSearchStateDir.trim() === '') {
      errors.push('AI_SEARCH_STATE_DIR must be set (or allow default)');
    }

    if (
      config.aiSearchScope === 'conversation' &&
      config.aiSearchRequireThreadKey &&
      !config.aiSearchThreadKey
    ) {
      errors.push(
        'WEB_FETCH_THREAD_KEY (or AI_SEARCH_THREAD_KEY) is required when AI_SEARCH_SCOPE=conversation and AI_SEARCH_REQUIRE_THREAD_KEY=true'
      );
    }

    if (!config.aiSearchAccountId) {
      errors.push('CF_ACCOUNT_ID is required when AI_SEARCH_ENABLED=true');
    }
    if (!config.aiSearchR2Bucket) {
      errors.push('CF_R2_BUCKET is required when AI_SEARCH_ENABLED=true');
    }
    if (!config.aiSearchR2AccessKeyId) {
      errors.push('CF_R2_ACCESS_KEY_ID is required when AI_SEARCH_ENABLED=true');
    }
    if (!config.aiSearchR2SecretAccessKey) {
      errors.push('CF_R2_SECRET_ACCESS_KEY is required when AI_SEARCH_ENABLED=true');
    }
  }

  return errors;
}
```

---

## 3) `src/ai-search/state.ts` (NEW)

```ts
/**
 * AI Search scope state
 *
 * Provides a stable, session-resilient mapping from a (workspace_id, thread_key)
 * to a conversation_id, persisted on disk.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AiSearchScope, Config } from '../types.js';

export type ScopeMode = 'conversation' | 'workspace' | 'global';

export interface ScopeResolution {
  /** The effective scope mode used for this request. */
  scope: ScopeMode;
  /** Stable id derived from workspace root, present for workspace/conversation scopes. */
  workspace_id?: string;
  /** Stable id mapped from (workspace_id, thread_key), present for conversation scope. */
  conversation_id?: string;
  /** The R2 prefix used for uploads (includes base prefix + scope prefix), always normalized with trailing '/'. */
  upload_prefix: string;
  /** The folder prefix used for query scoping. Empty string means "do not scope queries". */
  folder_scope_prefix: string;
}

interface StateFile {
  version: 1;
  threads: Record<string, ThreadEntry>;
}

interface ThreadEntry {
  conversation_id: string;
  created_at: string;
  last_used_at: string;
}

export class AiSearchScopeError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AiSearchScopeError';
    this.code = code;
    this.details = details;
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const noLeading = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  return noLeading.endsWith('/') ? noLeading : `${noLeading}/`;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.git');
    if (await exists(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function resolveWorkspaceRoot(config: Config, cwdOverride?: string): Promise<string> {
  const override = config.aiSearchWorkspaceRoot?.trim();
  if (override) {
    return path.resolve(override);
  }

  const cwd = cwdOverride ? path.resolve(cwdOverride) : process.cwd();
  const gitRoot = await findGitRoot(cwd);
  return gitRoot ?? cwd;
}

export function computeWorkspaceId(workspaceRoot: string): string {
  // Stable but opaque id.
  return sha256Hex(path.resolve(workspaceRoot)).slice(0, 12);
}

function computeThreadKeyId(threadKey: string): string {
  return sha256Hex(threadKey).slice(0, 16);
}

function getStateFilePath(config: Config): string {
  const dir = config.aiSearchStateDir?.trim() || path.join(process.env.HOME || '', '.config', 'web-fetch-mcp');
  return path.join(dir, 'ai-search-state.json');
}

async function loadState(config: Config): Promise<StateFile> {
  const filePath = getStateFilePath(config);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    if (!parsed || parsed.version !== 1 || typeof parsed.threads !== 'object' || !parsed.threads) {
      return { version: 1, threads: {} };
    }
    return { version: 1, threads: parsed.threads as Record<string, ThreadEntry> };
  } catch {
    return { version: 1, threads: {} };
  }
}

async function saveState(config: Config, state: StateFile): Promise<void> {
  const filePath = getStateFilePath(config);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

async function getOrCreateConversationId(config: Config, workspaceId: string, threadKey: string): Promise<string> {
  const state = await loadState(config);

  const threadKeyId = computeThreadKeyId(threadKey);
  const stateKey = `${workspaceId}::${threadKeyId}`;

  const now = new Date().toISOString();
  const existing = state.threads[stateKey];
  if (existing) {
    existing.last_used_at = now;
    await saveState(config, state);
    return existing.conversation_id;
  }

  const conversationId = crypto.randomUUID();
  state.threads[stateKey] = {
    conversation_id: conversationId,
    created_at: now,
    last_used_at: now,
  };
  await saveState(config, state);
  return conversationId;
}

function scopePrefixFor(scope: ScopeMode, workspaceId?: string, conversationId?: string): string {
  if (scope === 'global') {
    return '';
  }
  if (scope === 'workspace') {
    return `workspaces/${workspaceId}/`;
  }
  return `workspaces/${workspaceId}/conversations/${conversationId}/`;
}

export async function resolveAiSearchScope(
  config: Config,
  threadKeyOverride?: string,
  cwdOverride?: string
): Promise<ScopeResolution> {
  const basePrefix = normalizePrefix(config.aiSearchR2Prefix ?? '');

  const requestedScope: AiSearchScope = config.aiSearchScope ?? 'conversation';

  if (requestedScope === 'global') {
    return {
      scope: 'global',
      upload_prefix: basePrefix,
      folder_scope_prefix: '',
    };
  }

  const workspaceRoot = await resolveWorkspaceRoot(config, cwdOverride);
  const workspaceId = computeWorkspaceId(workspaceRoot);

  if (requestedScope === 'workspace') {
    const scoped = `${basePrefix}${scopePrefixFor('workspace', workspaceId)}`;
    return {
      scope: 'workspace',
      workspace_id: workspaceId,
      upload_prefix: scoped,
      folder_scope_prefix: scoped,
    };
  }

  const threadKey = (threadKeyOverride ?? config.aiSearchThreadKey)?.trim();
  if (!threadKey) {
    if (config.aiSearchRequireThreadKey) {
      throw new AiSearchScopeError(
        'AI_SEARCH_MISSING_THREAD_KEY',
        'Missing thread_key. Provide WEB_FETCH_THREAD_KEY/AI_SEARCH_THREAD_KEY or options.ai_search.thread_key.',
        { requested_scope: 'conversation' }
      );
    }

    // Graceful fallback: keep isolation at workspace granularity.
    const scoped = `${basePrefix}${scopePrefixFor('workspace', workspaceId)}`;
    return {
      scope: 'workspace',
      workspace_id: workspaceId,
      upload_prefix: scoped,
      folder_scope_prefix: scoped,
    };
  }

  const conversationId = await getOrCreateConversationId(config, workspaceId, threadKey);
  const scoped = `${basePrefix}${scopePrefixFor('conversation', workspaceId, conversationId)}`;
  return {
    scope: 'conversation',
    workspace_id: workspaceId,
    conversation_id: conversationId,
    upload_prefix: scoped,
    folder_scope_prefix: scoped,
  };
}
```

---

## 4) `src/ai-search/index.ts` (UPDATED)

```ts
/**
 * Cloudflare AI Search integration
 *
 * Uploads extracted markdown to R2 and optionally queries AI Search.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type {
  AiSearchOptions,
  AiSearchQueryOptions,
  AiSearchQueryMode,
  Config,
  LLMPacket,
} from '../types.js';
import { getConfig } from '../config.js';
import { AiSearchScopeError, resolveAiSearchScope } from './state.js';
import type { ScopeResolution } from './state.js';

const DEFAULT_UPLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 500;

export interface AiSearchQueryResult {
  mode: AiSearchQueryMode;
  request: Record<string, unknown>;
  status?: number;
  response?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface AiSearchIngestResult {
  enabled: boolean;
  uploaded: boolean;
  bucket?: string;
  prefix?: string;
  keys?: string[];
  bytes?: number;
  parts?: number;
  skipped_existing?: boolean;
  query?: AiSearchQueryResult;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

// Track config hash to detect changes
let r2Client: S3Client | null = null;
let r2ClientConfigHash: string | null = null;

function computeConfigHash(config: Config): string {
  return [
    config.aiSearchR2Endpoint ?? '',
    config.aiSearchAccountId ?? '',
    config.aiSearchR2AccessKeyId ?? '',
    config.aiSearchR2SecretAccessKey ?? '',
  ].join('|');
}

function buildR2Endpoint(config: Config): string | undefined {
  if (config.aiSearchR2Endpoint) {
    return config.aiSearchR2Endpoint;
  }
  if (config.aiSearchAccountId) {
    return `https://${config.aiSearchAccountId}.r2.cloudflarestorage.com`;
  }
  return undefined;
}

function getR2Client(config: Config): S3Client {
  const configHash = computeConfigHash(config);

  // Return existing client if config hasn't changed
  if (r2Client && r2ClientConfigHash === configHash) {
    return r2Client;
  }

  const endpoint = buildR2Endpoint(config);
  if (!endpoint) {
    throw new Error('Missing R2 endpoint; set CF_ACCOUNT_ID or CF_R2_ENDPOINT');
  }

  if (!config.aiSearchR2AccessKeyId || !config.aiSearchR2SecretAccessKey) {
    throw new Error('Missing R2 credentials; set CF_R2_ACCESS_KEY_ID and CF_R2_SECRET_ACCESS_KEY');
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.aiSearchR2AccessKeyId,
      secretAccessKey: config.aiSearchR2SecretAccessKey,
    },
  });
  r2ClientConfigHash = configHash;

  return r2Client;
}

/** Reset the cached R2 client (for testing or config reload). */
export function resetR2Client(): void {
  r2Client = null;
  r2ClientConfigHash = null;
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return '';
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const noLeading = trimmed.replace(/^\/+/, '');
  return noLeading.endsWith('/') ? noLeading : `${noLeading}/`;
}

function sanitizePath(path: string): string {
  // Decode URL-encoded characters first, then sanitize
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  return decoded.replace(/[^a-zA-Z0-9/_\-.]/g, '_');
}

function buildKeyBase(packet: LLMPacket, prefix: string): string {
  const url = new URL(packet.canonical_url);
  const rawPath = url.pathname === '/' ? '/root' : url.pathname.replace(/\/$/, '');
  // Remove leading slash from path since we'll join with hostname
  const safePath = sanitizePath(rawPath).replace(/^\/+/, '');
  const normalizedPrefix = normalizePrefix(prefix);
  const base = normalizedPrefix
    ? `${normalizedPrefix}${url.hostname}/${safePath}`
    : `${url.hostname}/${safePath}`;
  return base.replace(/\/{2,}/g, '/');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildFrontmatter(packet: LLMPacket, part: number, parts: number): string {
  const lines: string[] = ['---'];
  lines.push(`source_url: ${yamlString(packet.canonical_url)}`);
  lines.push(`original_url: ${yamlString(packet.original_url)}`);
  lines.push(`retrieved_at: ${yamlString(packet.retrieved_at)}`);
  lines.push(`content_hash: ${packet.hashes.content_hash}`);
  lines.push(`source_id: ${packet.source_id}`);
  lines.push(`content_type: ${yamlString(packet.content_type)}`);
  if (packet.metadata.title) {
    lines.push(`title: ${yamlString(packet.metadata.title)}`);
  }
  if (packet.metadata.author) {
    lines.push(`author: ${yamlString(packet.metadata.author)}`);
  }
  if (packet.metadata.published_at) {
    lines.push(`published_at: ${yamlString(packet.metadata.published_at)}`);
  }
  lines.push(`part: ${part}`);
  lines.push(`parts: ${parts}`);
  lines.push('---');
  return lines.join('\n');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function splitByChars(text: string, maxBytes: number): string[] {
  if (byteLength(text) <= maxBytes) {
    return [text];
  }

  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = byteLength(char);
    if (currentBytes + charBytes > maxBytes && current) {
      parts.push(current);
      current = '';
      currentBytes = 0;
    }
    if (charBytes > maxBytes) {
      parts.push(char);
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function splitByLines(text: string, maxBytes: number): string[] {
  const lines = text.split('\n');
  const parts: string[] = [];
  let current = '';

  const flush = () => {
    if (current) {
      parts.push(current);
      current = '';
    }
  };

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    flush();

    if (byteLength(line) <= maxBytes) {
      current = line;
      continue;
    }

    const charParts = splitByChars(line, maxBytes);
    for (const part of charParts) {
      parts.push(part);
    }
  }

  flush();
  return parts;
}

export function splitMarkdownByBytes(markdown: string, maxBytes: number): string[] {
  if (maxBytes <= 0) {
    return [markdown];
  }

  if (byteLength(markdown) <= maxBytes) {
    return [markdown];
  }

  const paragraphs = markdown.split(/\n{2,}/);
  const parts: string[] = [];
  let current = '';

  const flush = () => {
    if (current) {
      parts.push(current);
      current = '';
    }
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    flush();

    if (byteLength(paragraph) <= maxBytes) {
      current = paragraph;
      continue;
    }

    const lineParts = splitByLines(paragraph, maxBytes);
    for (const linePart of lineParts) {
      if (!current) {
        current = linePart;
        continue;
      }

      const lineCandidate = `${current}\n${linePart}`;
      if (byteLength(lineCandidate) <= maxBytes) {
        current = lineCandidate;
      } else {
        flush();
        current = linePart;
      }
    }
  }

  flush();
  return parts;
}

async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (statusCode === 404 || name === 'NotFound') {
      return false;
    }
    throw err;
  }
}

async function uploadObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  retries: number = DEFAULT_UPLOAD_RETRIES
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'text/markdown; charset=utf-8',
      }));
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

function buildQueryRequest(options: AiSearchQueryOptions): Record<string, unknown> {
  const request: Record<string, unknown> = {
    query: options.query,
  };

  if (options.rewrite_query !== undefined) {
    request['rewrite_query'] = options.rewrite_query;
  }
  if (options.max_num_results !== undefined) {
    request['max_num_results'] = options.max_num_results;
  }
  if (options.ranking_options) {
    request['ranking_options'] = options.ranking_options;
  }
  if (options.reranking) {
    request['reranking'] = options.reranking;
  }
  if (options.filters) {
    request['filters'] = options.filters;
  }
  if (options.model) {
    request['model'] = options.model;
  }
  if (options.system_prompt) {
    request['system_prompt'] = options.system_prompt;
  }

  return request;
}

/**
 * Query AI Search, automatically scoped to the configured conversation/workspace.
 *
 * This is the primary entrypoint for "What did I read about X?" style retrieval
 * without requiring a fetch.
 */
export async function queryAiSearchScoped(
  options: AiSearchQueryOptions,
  config: Config = getConfig(),
  scope?: { thread_key?: string },
): Promise<AiSearchQueryResult> {
  let resolution: ScopeResolution;
  try {
    resolution = await resolveAiSearchScope(config, scope?.thread_key);
  } catch (err) {
    const scopeErr = err instanceof AiSearchScopeError ? err : undefined;
    return {
      mode: options.mode ?? 'search',
      request: buildQueryRequest(options),
      error: {
        code: scopeErr?.code ?? 'AI_SEARCH_SCOPE_ERROR',
        message: err instanceof Error ? err.message : 'AI Search scope resolution failed',
      },
    };
  }

  const scopedApplied = applyScopeToQueryOptions(options, resolution.folder_scope_prefix);
  if (!scopedApplied.ok) {
    return {
      mode: options.mode ?? 'search',
      request: buildQueryRequest(options),
      error: scopedApplied.error,
    };
  }

  return queryAiSearch(scopedApplied.query, config);
}

async function queryAiSearch(
  options: AiSearchQueryOptions,
  config: Config
): Promise<AiSearchQueryResult> {
  if (!config.aiSearchAccountId || !config.aiSearchName || !config.aiSearchApiToken) {
    return {
      mode: options.mode ?? 'search',
      request: buildQueryRequest(options),
      error: {
        code: 'AI_SEARCH_NOT_CONFIGURED',
        message: 'Missing CF_ACCOUNT_ID, CF_AI_SEARCH_NAME, or CF_AI_SEARCH_API_TOKEN',
      },
    };
  }

  const mode = options.mode ?? 'search';
  const endpoint = mode === 'ai_search' ? 'ai-search' : 'search';
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.aiSearchAccountId}/autorag/rags/${encodeURIComponent(config.aiSearchName)}/${endpoint}`;
  const requestBody = buildQueryRequest(options);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiSearchQueryTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.aiSearchApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const status = response.status;
    const text = await response.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      return {
        mode,
        request: requestBody,
        status,
        response: parsed,
        error: {
          code: 'AI_SEARCH_QUERY_FAILED',
          message: `AI Search query failed with status ${status}`,
          details: parsed,
        },
      };
    }

    return {
      mode,
      request: requestBody,
      status,
      response: parsed,
    };
  } catch (err) {
    return {
      mode,
      request: requestBody,
      error: {
        code: 'AI_SEARCH_QUERY_FAILED',
        message: err instanceof Error ? err.message : 'AI Search query failed',
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function clampWaitMs(waitMs: number, config: Config): number {
  if (waitMs <= 0) return 0;
  return Math.min(waitMs, config.aiSearchMaxQueryWaitMs);
}

type AiSearchFilter = {
  type: string;
  key?: string;
  value?: string | number | boolean;
  filters?: AiSearchFilter[];
};

function buildFolderStartsWithComparisons(folderPrefix: string): AiSearchFilter[] {
  const p = normalizePrefix(folderPrefix);
  if (!p) return [];
  // Cloudflare AI Search 'starts with' pattern:
  // folder > prefix + '/' AND folder <= prefix + 'z'
  // (Example: gt 'customer-a//' and lte 'customer-a/z' for prefix 'customer-a/')
  return [
    { type: 'gt', key: 'folder', value: `${p}/` },
    { type: 'lte', key: 'folder', value: `${p}z` },
  ];
}

function mergeFiltersWithScope(
  existing: unknown,
  scopeComparisons: AiSearchFilter[]
): { ok: true; filters: Record<string, unknown> } | { ok: false; error: { code: string; message: string } } {
  if (scopeComparisons.length === 0) {
    return { ok: true, filters: (existing as Record<string, unknown>) ?? {} };
  }

  if (existing === undefined || existing === null) {
    return {
      ok: true,
      filters: { type: 'and', filters: scopeComparisons } as unknown as Record<string, unknown>,
    };
  }

  if (typeof existing !== 'object') {
    return { ok: false, error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: 'filters must be an object' } };
  }

  const ex = existing as AiSearchFilter;
  if (ex.type === 'or') {
    return {
      ok: false,
      error: {
        code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
        message:
          'Cannot apply conversation scoping when filters.type="or" (Cloudflare AI Search does not allow nested compounds).',
      },
    };
  }

  if (ex.type === 'and' && Array.isArray(ex.filters)) {
    return {
      ok: true,
      filters: { ...ex, filters: [...ex.filters, ...scopeComparisons] } as unknown as Record<string, unknown>,
    };
  }

  // Single comparison filter
  if (typeof ex.type === 'string' && typeof ex.key === 'string') {
    return {
      ok: true,
      filters: { type: 'and', filters: [ex, ...scopeComparisons] } as unknown as Record<string, unknown>,
    };
  }

  return {
    ok: false,
    error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: 'Unsupported filters shape' },
  };
}

function applyScopeToQueryOptions(
  query: AiSearchQueryOptions,
  folderScopePrefix: string
): { ok: true; query: AiSearchQueryOptions } | { ok: false; error: { code: string; message: string } } {
  const scopeComparisons = buildFolderStartsWithComparisons(folderScopePrefix);
  if (scopeComparisons.length === 0) return { ok: true, query };

  const merged = mergeFiltersWithScope(query.filters, scopeComparisons);
  if (!merged.ok) return merged;

  return { ok: true, query: { ...query, filters: merged.filters } };
}

export async function ingestPacketToAiSearch(
  packet: LLMPacket,
  options: AiSearchOptions,
  config: Config = getConfig()
): Promise<AiSearchIngestResult> {
  const enabled = options.enabled ?? config.aiSearchEnabled;
  if (!enabled) {
    return {
      enabled: false,
      uploaded: false,
    };
  }

  if (!config.aiSearchR2Bucket) {
    return {
      enabled: true,
      uploaded: false,
      error: {
        code: 'AI_SEARCH_NOT_CONFIGURED',
        message: 'Missing CF_R2_BUCKET configuration',
      },
    };
  }

  let client: S3Client;
  try {
    client = getR2Client(config);
  } catch (err) {
    return {
      enabled: true,
      uploaded: false,
      error: {
        code: 'AI_SEARCH_NOT_CONFIGURED',
        message: err instanceof Error ? err.message : 'Missing R2 configuration',
      },
    };
  }

  const maxFileBytes = options.max_file_bytes ?? config.aiSearchMaxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  let scope: ScopeResolution;
  try {
    scope = await resolveAiSearchScope(config, options.thread_key);
  } catch (err) {
    const scopeErr = err instanceof AiSearchScopeError ? err : undefined;
    return {
      enabled: true,
      uploaded: false,
      error: {
        code: scopeErr?.code ?? 'AI_SEARCH_SCOPE_ERROR',
        message: err instanceof Error ? err.message : 'AI Search scope resolution failed',
        details: scopeErr?.details,
      },
    };
  }

  const effectivePrefix = `${scope.upload_prefix}${normalizePrefix(options.prefix ?? '')}`;
  const keyBase = buildKeyBase(packet, effectivePrefix);
  const keyPrefix = `${keyBase}/${packet.hashes.content_hash}`;

  // Split content by max bytes
  let parts: string[] = [];
  let totalParts = 1;
  let overheadBytes = byteLength(buildFrontmatter(packet, 1, 1)) + 2;

  for (let attempt = 0; attempt < 3; attempt++) {
    const maxContentBytes = Math.max(1, maxFileBytes - overheadBytes);
    parts = splitMarkdownByBytes(packet.content, maxContentBytes);
    const nextTotal = parts.length;
    const nextOverhead = byteLength(buildFrontmatter(packet, nextTotal, nextTotal)) + 2;
    if (nextTotal === totalParts && nextOverhead === overheadBytes) {
      totalParts = nextTotal;
      break;
    }
    totalParts = nextTotal;
    overheadBytes = nextOverhead;
  }

  if (overheadBytes >= maxFileBytes) {
    return {
      enabled: true,
      uploaded: false,
      error: {
        code: 'AI_SEARCH_CONTENT_TOO_LARGE',
        message: 'Frontmatter exceeds AI Search file size limit',
      },
    };
  }

  const keys = parts.map((_, index) => {
    const suffix = String(index + 1).padStart(4, '0');
    return `${keyPrefix}/part-${suffix}.md`;
  });

  const totalBytes = parts.reduce((sum, part, index) => {
    const frontmatter = buildFrontmatter(packet, index + 1, totalParts);
    return sum + byteLength(frontmatter) + 2 + byteLength(part);
  }, 0);

  const skipIfExists = options.skip_if_exists ?? true;

  const scopedQueryApplied = options.query
    ? applyScopeToQueryOptions(options.query, scope.folder_scope_prefix)
    : ({ ok: true, query: undefined } as const);

  const scopedQuery = scopedQueryApplied.ok ? scopedQueryApplied.query : undefined;
  const scopedQueryError = scopedQueryApplied.ok ? undefined : scopedQueryApplied.error;

  try {
    // Check if ALL parts exist (not just first) to handle partial upload recovery
    let allPartsExist = false;
    if (skipIfExists && keys.length > 0) {
      const lastKey = keys[keys.length - 1]!;
      const firstExists = await objectExists(client, config.aiSearchR2Bucket, keys[0]!);
      const lastExists = keys.length === 1 || await objectExists(client, config.aiSearchR2Bucket, lastKey);
      allPartsExist = firstExists && lastExists;
    }

    if (allPartsExist) {
      const query = scopedQueryError
        ? {
            mode: options.query?.mode ?? 'search',
            request: buildQueryRequest({ ...options.query!, filters: options.query?.filters }),
            error: scopedQueryError,
          }
        : scopedQuery
          ? await queryAiSearch(scopedQuery, config)
          : undefined;

      return {
        enabled: true,
        uploaded: false,
        skipped_existing: true,
        bucket: config.aiSearchR2Bucket,
        prefix: keyPrefix,
        keys,
        bytes: totalBytes,
        parts: parts.length,
        query,
      };
    }

    for (let i = 0; i < parts.length; i++) {
      const content = parts[i] ?? '';
      const frontmatter = buildFrontmatter(packet, i + 1, totalParts);
      const body = Buffer.from(`${frontmatter}\n\n${content}`, 'utf8');
      await uploadObject(client, config.aiSearchR2Bucket, keys[i]!, body);
    }

    const waitMs = clampWaitMs(options.wait_ms ?? config.aiSearchQueryWaitMs, config);
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const query = scopedQueryError
      ? {
          mode: options.query?.mode ?? 'search',
          request: buildQueryRequest({ ...options.query!, filters: options.query?.filters }),
          error: scopedQueryError,
        }
      : scopedQuery
        ? await queryAiSearch(scopedQuery, config)
        : undefined;

    return {
      enabled: true,
      uploaded: true,
      bucket: config.aiSearchR2Bucket,
      prefix: keyPrefix,
      keys,
      bytes: totalBytes,
      parts: parts.length,
      query,
    };
  } catch (err) {
    return {
      enabled: true,
      uploaded: false,
      error: {
        code: 'AI_SEARCH_UPLOAD_FAILED',
        message: err instanceof Error ? err.message : 'Failed to upload content to R2',
      },
    };
  }
}
```

---

## 5) `src/tools/fetch.ts` (UPDATED schema: adds `thread_key`)

> Your fetch logic stays the same — the only change is that `ai_search.thread_key` is now accepted and forwarded into ingestion/scoping.

```ts
/**
 * Fetch Tool
 *
 * Main tool for fetching and extracting content from URLs.
 */

import type {
  FetchOptions,
  FetchResult,
  LLMPacket,
  NormalizedContent,
  RawFetchResult,
} from '../types.js';
import type { AiSearchIngestResult } from '../ai-search/index.js';
import { httpFetchWithRetry } from '../fetcher/http-fetcher.js';
import { browserRender, isBrowserAvailable } from '../fetcher/browser-renderer.js';
import { applyCrawlDelay, checkRobots } from '../fetcher/robots.js';
import { normalizeContent, toNormalizedContent } from '../processing/normalizer.js';
import { getRateLimiter, waitForRateLimit } from '../security/rate-limiter.js';
import { checkSSRF } from '../security/ssrf-guard.js';
import { getHostname } from '../utils/url.js';
import { getConfig } from '../config.js';
import { ingestPacketToAiSearch } from '../ai-search/index.js';
import { storePacketResource } from '../resources/store.js';

export interface FetchToolInput {
  url: string;
  options?: FetchOptions;
}

export interface FetchToolOutput {
  success: boolean;
  packet?: LLMPacket;
  normalized?: NormalizedContent;
  raw?: {
    bytes_length: number;
    content_type: string;
    headers: Record<string, string>;
  };
  screenshot_base64?: string;
  ai_search?: AiSearchIngestResult;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type FetchToolError = NonNullable<FetchToolOutput['error']>;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function shouldAttemptRenderFallback(
  rawResult: RawFetchResult,
  packet: LLMPacket
): boolean {
  if (!rawResult.contentType.includes('html')) {
    return false;
  }

  const bodyBytes = rawResult.body.length;
  const wordCount = countWords(packet.content);
  const outlineCount = packet.outline.length;

  if (bodyBytes < 5000) {
    return false;
  }

  if (/enable\s+javascript|enable\s+js|requires\s+javascript|turn\s+on\s+javascript/i.test(packet.content)) {
    return true;
  }

  if (wordCount < 40 && bodyBytes >= 5000) {
    return true;
  }

  if (wordCount < 80 && bodyBytes >= 20000) {
    return true;
  }

  if (outlineCount === 0 && wordCount < 200 && bodyBytes >= 10000) {
    return true;
  }

  return false;
}

async function fetchWithRender(
  url: string,
  config: ReturnType<typeof getConfig>,
  options: FetchOptions
): Promise<{ success: true; result: RawFetchResult; screenshot?: Buffer } | { success: false; error: FetchToolError }> {
  const browserAvailable = await isBrowserAvailable();
  if (!browserAvailable) {
    return {
      success: false,
      error: {
        code: 'RENDER_UNAVAILABLE',
        message: 'Browser rendering is not available. Enable PLAYWRIGHT_ENABLED and install Playwright.',
      },
    };
  }

  const effectiveUserAgent = options.user_agent ?? config.userAgent;
  const respectRobots = options.respect_robots ?? config.respectRobots;

  const ssrfCheck = await checkSSRF(url, {
    blockPrivateIp: config.blockPrivateIp,
    allowlistDomains: config.allowlistDomains,
  });

  if (!ssrfCheck.safe) {
    return {
      success: false,
      error: {
        code: 'SSRF_BLOCKED',
        message: ssrfCheck.error || 'Request blocked by SSRF protection',
      },
    };
  }

  if (respectRobots) {
    const robotsResult = await checkRobots(url, {
      timeoutMs: 10000,
      userAgent: effectiveUserAgent,
    });

    if (!robotsResult.allowed) {
      return {
        success: false,
        error: {
          code: 'ROBOTS_BLOCKED',
          message: 'URL is blocked by robots.txt',
        },
      };
    }

    await applyCrawlDelay(new URL(url).origin, robotsResult.crawlDelay, effectiveUserAgent);
  }

  const hostname = getHostname(url);
  if (hostname) {
    const rateLimiter = getRateLimiter(config.rateLimitPerHost);
    const canProceed = await waitForRateLimit(hostname, rateLimiter, 30000);

    if (!canProceed) {
      return {
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Rate limit exceeded for this host',
        },
      };
    }

    rateLimiter.recordRequest(hostname);
  }

  const renderResult = await browserRender(url, {
    wait_until: options.render?.wait_until,
    wait_ms: options.render?.wait_ms,
    block_third_party: options.render?.block_third_party,
    screenshot: options.render?.screenshot,
    selector: options.render?.selector,
    timeout_ms: options.timeout_ms,
    max_bytes: options.max_bytes,
    user_agent: effectiveUserAgent,
  });

  if (!renderResult.success) {
    return {
      success: false,
      error: {
        code: renderResult.error.code,
        message: renderResult.error.message,
      },
    };
  }

  if (respectRobots) {
    const robotsResult = await checkRobots(renderResult.result.finalUrl, {
      timeoutMs: 10000,
      userAgent: effectiveUserAgent,
    });

    if (!robotsResult.allowed) {
      return {
        success: false,
        error: {
          code: 'ROBOTS_BLOCKED',
          message: 'URL is blocked by robots.txt',
        },
      };
    }

    await applyCrawlDelay(new URL(renderResult.result.finalUrl).origin, robotsResult.crawlDelay, effectiveUserAgent);
  }

  return {
    success: true,
    result: renderResult.result,
    screenshot: renderResult.screenshot,
  };
}

/**
 * Execute the fetch tool
 */
export async function executeFetch(input: FetchToolInput): Promise<FetchToolOutput> {
  const { url, options = {} } = input;
  const config = getConfig();

  const {
    mode = 'auto',
    headers,
    timeout_ms,
    max_bytes,
    max_redirects,
    user_agent,
    respect_robots,
    cache_ttl_s,
    extraction,
    format,
  } = options;

  try {
    let rawResult: RawFetchResult | null = null;
    let screenshot: Buffer | undefined;
    let usedRender = false;
    let lastRenderError: FetchToolError | undefined;

    // Determine fetch mode
    let useRender = mode === 'render';

    if (mode === 'auto') {
      // Use render mode for certain domains/patterns that typically need JS
      const jsHeavySites = [
        'twitter.com',
        'x.com',
        'facebook.com',
        'instagram.com',
        'linkedin.com',
        'reddit.com',
        'medium.com',
        'substack.com',
      ];

      const hostname = new URL(url).hostname.toLowerCase();
      useRender = jsHeavySites.some(site =>
        hostname === site || hostname.endsWith('.' + site)
      );

      // Only use render if available
      if (useRender && !config.playwrightEnabled) {
        useRender = false;
      }
    }

    const tryRender = async (): Promise<{ success: true; result: RawFetchResult; screenshot?: Buffer } | { success: false }> => {
      const renderResult = await fetchWithRender(url, config, options);
      if (!renderResult.success) {
        lastRenderError = renderResult.error;
        return { success: false };
      }

      return {
        success: true,
        result: renderResult.result,
        screenshot: renderResult.screenshot,
      };
    };

    if (useRender) {
      const renderAttempt = await tryRender();
      if (!renderAttempt.success) {
        if (mode !== 'auto') {
          return {
            success: false,
            error: lastRenderError,
          };
        }
      } else {
        rawResult = renderAttempt.result;
        screenshot = renderAttempt.screenshot;
        usedRender = true;
      }
    }

    if (!rawResult) {
      const httpResult = await httpFetchWithRetry(url, {
        headers,
        timeout_ms,
        max_bytes,
        max_redirects,
        user_agent,
        respect_robots,
        cache_ttl_s,
      });

      if (!httpResult.success) {
        return {
          success: false,
          error: {
            code: httpResult.error.code,
            message: httpResult.error.message,
            details: httpResult.error.statusCode,
          },
        };
      }

      rawResult = httpResult.result;
    }

    // Check output format
    if (format?.output === 'raw') {
      return {
        success: true,
        raw: {
          bytes_length: rawResult.body.length,
          content_type: rawResult.contentType,
          headers: rawResult.headers,
        },
      };
    }

    let normalizedOutput: NormalizedContent | undefined;

    // Normalize content into LLMPacket
    let normalizeResult = await normalizeContent(rawResult, url, {
      extraction,
      format,
    });

    if (!normalizeResult.success || !normalizeResult.packet) {
      if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
        const renderAttempt = await tryRender();
        if (renderAttempt.success) {
          const renderNormalize = await normalizeContent(renderAttempt.result, url, {
            extraction,
            format,
          });
          if (renderNormalize.success && renderNormalize.packet) {
            normalizeResult = renderNormalize;
            rawResult = renderAttempt.result;
            screenshot = renderAttempt.screenshot;
            usedRender = true;
          }
        }
      }

      if (!normalizeResult.success || !normalizeResult.packet) {
        return {
          success: false,
          error: {
            code: 'EXTRACTION_FAILED',
            message: normalizeResult.error || 'Failed to extract content',
          },
        };
      }
    }

    if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
      if (shouldAttemptRenderFallback(rawResult, normalizeResult.packet)) {
        const renderAttempt = await tryRender();
        if (renderAttempt.success) {
          const renderNormalize = await normalizeContent(renderAttempt.result, url, {
            extraction,
            format,
          });
          if (renderNormalize.success && renderNormalize.packet) {
            normalizeResult = renderNormalize;
            rawResult = renderAttempt.result;
            screenshot = renderAttempt.screenshot;
            usedRender = true;
          }
        }
      }
    }

    // Add screenshot if taken
    if (screenshot && normalizeResult.packet) {
      normalizeResult.packet.screenshot_base64 = screenshot.toString('base64');
    }

    let aiSearchResult: AiSearchIngestResult | undefined;
    const aiSearchEnabled = options.ai_search?.enabled ?? config.aiSearchEnabled;
    if (aiSearchEnabled && normalizeResult.packet) {
      aiSearchResult = await ingestPacketToAiSearch(
        normalizeResult.packet,
        options.ai_search ?? {},
        config
      );

      const aiSearchError = aiSearchResult.error ?? aiSearchResult.query?.error;
      if (aiSearchError && options.ai_search?.require_success) {
        return {
          success: false,
          error: {
            code: aiSearchError.code,
            message: aiSearchError.message,
            details: aiSearchError.details,
          },
        };
      }
    }

    if (format?.output === 'normalized' && normalizeResult.packet) {
      normalizedOutput = toNormalizedContent(normalizeResult.packet);
    }

    if (normalizeResult.packet) {
      storePacketResource(normalizeResult.packet);
    }

    return {
      success: true,
      packet: format?.output === 'normalized' ? undefined : normalizeResult.packet,
      normalized: normalizedOutput,
      screenshot_base64: screenshot ? screenshot.toString('base64') : normalizeResult.packet?.screenshot_base64,
      ai_search: aiSearchResult,
    };

  } catch (err) {
    return {
      success: false,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error occurred',
      },
    };
  }
}

/**
 * Get JSON schema for fetch tool input
 */
export function getFetchInputSchema(): object {
  return {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      options: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['auto', 'http', 'render'],
            description: 'Fetch mode: auto (detect), http (simple fetch), render (browser)',
            default: 'auto',
          },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Custom HTTP headers',
          },
          timeout_ms: {
            type: 'number',
            description: 'Request timeout in milliseconds',
          },
          max_bytes: {
            type: 'number',
            description: 'Maximum response size in bytes',
          },
          max_redirects: {
            type: 'number',
            description: 'Maximum redirects to follow',
          },
          user_agent: {
            type: 'string',
            description: 'Custom User-Agent header',
          },
          respect_robots: {
            type: 'boolean',
            description: 'Whether to respect robots.txt',
          },
          cache_ttl_s: {
            type: 'number',
            description: 'Cache TTL in seconds for this request (0 to disable)',
          },
          render: {
            type: 'object',
            properties: {
              wait_until: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle'],
              },
              wait_ms: {
                type: 'number',
                description: 'Additional wait time after page load',
              },
              block_third_party: {
                type: 'boolean',
                description: 'Block third-party requests',
              },
              screenshot: {
                type: 'boolean',
                description: 'Take a screenshot',
              },
              selector: {
                type: 'string',
                description: 'Wait for specific CSS selector',
              },
            },
          },
          extraction: {
            type: 'object',
            properties: {
              prefer_readability: {
                type: 'boolean',
                default: true,
              },
              keep_tables: {
                type: 'boolean',
                default: true,
              },
              keep_code_blocks: {
                type: 'boolean',
                default: true,
              },
              remove_selectors: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          format: {
            type: 'object',
            properties: {
              output: {
                type: 'string',
                enum: ['llm_packet', 'raw', 'normalized'],
              },
              include_raw_excerpt: {
                type: 'boolean',
              },
            },
          },
          ai_search: {
            type: 'object',
            properties: {
              enabled: {
                type: 'boolean',
                description: 'Upload extracted content to Cloudflare R2 for AI Search indexing',
              },
              thread_key: {
                type: 'string',
                description: 'Stable conversation/thread identifier used to scope the knowledge base (overrides WEB_FETCH_THREAD_KEY)',
              },
              prefix: {
                type: 'string',
                description: 'Optional prefix for R2 object keys',
              },
              max_file_bytes: {
                type: 'number',
                description: 'Maximum bytes per uploaded file (default: 4MB)',
              },
              wait_ms: {
                type: 'number',
                description: 'Optional delay before running AI Search query (ms)',
              },
              skip_if_exists: {
                type: 'boolean',
                description: 'Skip upload if the first part already exists',
              },
              require_success: {
                type: 'boolean',
                description: 'Fail the fetch tool if AI Search upload or query fails',
              },
              query: {
                type: 'object',
                description: 'Optional AI Search query after upload',
                properties: {
                  query: { type: 'string' },
                  mode: { type: 'string', enum: ['search', 'ai_search'] },
                  rewrite_query: { type: 'boolean' },
                  max_num_results: { type: 'number' },
                  ranking_options: {
                    type: 'object',
                    properties: {
                      score_threshold: { type: 'number' },
                    },
                  },
                  reranking: {
                    type: 'object',
                    properties: {
                      enabled: { type: 'boolean' },
                      model: { type: 'string' },
                    },
                  },
                  filters: { type: 'object' },
                  model: { type: 'string' },
                  system_prompt: { type: 'string' },
                },
                required: ['query'],
              },
            },
          },
        },
      },
    },
    required: ['url'],
  };
}
```

---

## 6) `src/tools/ai-search-query.ts` (NEW tool)

```ts
/**
 * AI Search Query Tool
 *
 * Enables querying the accumulated, conversation-scoped knowledge base without
 * requiring a new fetch.
 */

import type { AiSearchQueryOptions, AiSearchQueryResult, Config } from '../types.js';
import { getConfig } from '../config.js';
import { queryAiSearchScoped } from '../ai-search/index.js';

export interface AiSearchQueryToolInput {
  /**
   * The AI Search query options.
   *
   * Note: results are automatically scoped to the configured conversation/workspace.
   */
  query: AiSearchQueryOptions;

  /**
   * Optional stable conversation/thread identifier.
   * If provided, overrides WEB_FETCH_THREAD_KEY for this request.
   */
  thread_key?: string;

  /** Optional config override. */
  config?: Partial<Config>;
}

export interface AiSearchQueryToolOutput {
  success: boolean;
  result?: AiSearchQueryResult;
  error?: {
    code: string;
    message: string;
  };
}

export async function executeAiSearchQuery(input: AiSearchQueryToolInput): Promise<AiSearchQueryToolOutput> {
  try {
    const config = input.config ? { ...getConfig(), ...input.config } : getConfig();
    const result = await queryAiSearchScoped(input.query, config, { thread_key: input.thread_key });

    if (result.error) {
      return {
        success: false,
        result,
        error: result.error,
      };
    }

    return {
      success: true,
      result,
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'AI_SEARCH_QUERY_FAILED',
        message: err instanceof Error ? err.message : 'AI Search query failed',
      },
    };
  }
}

export function getAiSearchQueryInputSchema() {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'object',
        description: 'AI Search query options (auto-scoped to the current conversation/workspace)',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string', enum: ['search', 'ai_search'] },
          rewrite_query: { type: 'boolean' },
          max_num_results: { type: 'number' },
          ranking_options: {
            type: 'object',
            properties: {
              score_threshold: { type: 'number' },
            },
          },
          reranking: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              model: { type: 'string' },
            },
          },
          filters: { type: 'object' },
          model: { type: 'string' },
          system_prompt: { type: 'string' },
        },
        required: ['query'],
      },
      thread_key: {
        type: 'string',
        description: 'Stable conversation/thread identifier used for scoping (overrides WEB_FETCH_THREAD_KEY)',
      },
      config: {
        type: 'object',
        description: 'Optional per-call config overrides',
      },
    },
    required: ['query'],
  };
}
```

---

# Required wiring in your MCP server (tool registration)

To make this _fully functional_, you must register the new tool **`ai_search_query`** alongside `fetch`.

Wherever you define tools (often a `tools` array or `server.registerTool()` calls), add something like:

```ts
import { executeAiSearchQuery, getAiSearchQueryInputSchema } from './tools/ai-search-query.js';

// ...
tools.push({
  name: 'ai_search_query',
  description: 'Query the conversation-scoped knowledge base built by fetch()',
  inputSchema: getAiSearchQueryInputSchema(),
  handler: executeAiSearchQuery,
});
```

(Adjust to your server framework’s exact registration shape.)

---

# How to use it

### Environment (recommended defaults)

```bash
AI_SEARCH_ENABLED=true
AI_SEARCH_SCOPE=conversation
AI_SEARCH_REQUIRE_THREAD_KEY=false
```

### Provide a thread key (best)

- Set once per conversation:


```bash
WEB_FETCH_THREAD_KEY="chat-thread-123"
```

Or pass per call:

- `fetch({ options: { ai_search: { thread_key: "chat-thread-123" }}})`

- `ai_search_query({ thread_key: "chat-thread-123", query: { query: "..." }})`


### Query what the agent read earlier

Call `ai_search_query` with:

```json
{
  "thread_key": "chat-thread-123",
  "query": { "query": "summarize what we learned about X", "mode": "search" }
}
```

---

If you paste your MCP server tool-registration file (the one that currently registers `fetch`, `extract`, etc.), I can drop in the **exact** final patch for that file too.

---

Absolutely — here are the **inline, copy-pasteable files/patches** to make the feature **fully functional end-to-end**, including **tool registration** in your server `index.ts`.

Quick note: some of the earlier uploads in this chat are no longer accessible via the file browser (they “expired”), but you’ve re-uploaded `index.ts`, so I can generate an exact patch for that. If you want me to tailor patches against your _exact_ current versions of other files (e.g. your current `ai-search/index.ts`), re-upload them too.

---

# 1) Patch: `src/index.ts` (register `ai_search_query` tool + prompt)

Apply this unified diff to your `src/index.ts` (the file you uploaded).

```diff
diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,6 +1,7 @@
 #!/usr/bin/env node

 /**
  * web-fetch-mcp
  *
  * MCP server for safe, high-signal web browsing and content fetching for LLM agents.
  */

 import 'dotenv/config';
 import { Server } from '@modelcontextprotocol/sdk/server/index.js';
 import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 import {
   CallToolRequestSchema,
   ListToolsRequestSchema,
   CompleteRequestSchema,
   ListPromptsRequestSchema,
   GetPromptRequestSchema,
   ListResourcesRequestSchema,
   ListResourceTemplatesRequestSchema,
   ReadResourceRequestSchema,
   McpError,
   ErrorCode,
 } from '@modelcontextprotocol/sdk/types.js';

 import { loadConfig, validateConfig, getConfig } from './config.js';
 import { executeFetch, getFetchInputSchema } from './tools/fetch.js';
 import { executeExtract, getExtractInputSchema } from './tools/extract.js';
 import { executeChunk, getChunkInputSchema } from './tools/chunk.js';
 import { executeCompact, getCompactInputSchema } from './tools/compact.js';
+import { executeAiSearchQuery, getAiSearchQueryInputSchema } from './tools/ai-search-query.js';
 import { closeBrowser } from './fetcher/browser-renderer.js';
 import { listResources, listResourceTemplates, readResource } from './resources/handlers.js';
 import { getResourceStore, setResourceListChangedNotifier } from './resources/store.js';
 import { buildCompletionResult } from './completions.js';
 import { paginateResults } from './pagination.js';

 const PROMPTS = [
   {
     name: 'fetch_url',
     title: 'Fetch URL',
     description: 'Fetch a URL and return the LLMPacket',
     arguments: [
       { name: 'url', description: 'The URL to fetch', required: true },
       { name: 'mode', description: 'Fetch mode: auto, http, or render', required: false },
       { name: 'extraction', description: 'Optional JSON for options.extraction', required: false },
     ],
   },
@@ -71,6 +72,18 @@ const PROMPTS = [
       { name: 'mode', description: 'AI Search mode: search or ai_search', required: false },
     ],
   },
+  {
+    name: 'ai_search_query',
+    title: 'AI Search Query',
+    description: 'Query the conversation-scoped knowledge base built by fetch()',
+    arguments: [
+      { name: 'query', description: 'Query string to search in the KB', required: true },
+      { name: 'mode', description: 'AI Search mode: search or ai_search', required: false },
+      { name: 'thread_key', description: 'Optional stable thread key override', required: false },
+    ],
+  },
   {
     name: 'resources_tips',
     title: 'Resources Tips',
     description: 'How to reuse fetched content via MCP resources',
     arguments: [],
   },
 ];

 const PROMPT_MAP = new Map(PROMPTS.map(prompt => [prompt.name, prompt]));
@@ -189,6 +202,36 @@ function buildFetchAiSearchPrompt(args: Record<string, string>): string {
   ].join('\n');
 }

+function buildAiSearchQueryPrompt(args: Record<string, string>): string {
+  const query = args['query'] ?? '';
+  const mode = args['mode'];
+  const threadKey = args['thread_key'];
+
+  const payload: Record<string, unknown> = {
+    query: {
+      query,
+      ...(mode ? { mode } : {}),
+    },
+    ...(threadKey ? { thread_key: threadKey } : {}),
+  };
+
+  return [
+    'Call the `ai_search_query` tool with the following input:',
+    '```json',
+    JSON.stringify(payload, null, 2),
+    '```',
+  ].join('\n');
+}
+
 function buildResourcesTipsPrompt(): string {
   return [
     'Tips for reusing fetched content via MCP resources:',
     '',
@@ -271,6 +314,17 @@ const TOOLS = [
 Always preserves numbers, dates, names, definitions, and procedures.`,
     inputSchema: getCompactInputSchema(),
   },
+  {
+    name: 'ai_search_query',
+    description: `Query Cloudflare AI Search over the scoped knowledge base built by fetch().
+
+By default, results are scoped to the current conversation/thread (or workspace fallback) based on:
+- options.ai_search.thread_key (if provided), otherwise WEB_FETCH_THREAD_KEY / AI_SEARCH_THREAD_KEY
+- persisted mapping to a stable conversation_id (survives restarts)
+
+Use this for: "What did I read about X?" without fetching again.`,
+    inputSchema: getAiSearchQueryInputSchema(),
+  },
 ];

 const SERVER_INSTRUCTIONS = [
   'Resources: After fetch/extract, content is cached and accessible via MCP resources.',
+  '',
+  'AI Search: Use `fetch` (auto-indexed when AI_SEARCH_ENABLED=true) to build a scoped KB, then query it with `ai_search_query`.',
   '',
   'To list resources: mcp__web-fetch.list_mcp_resources({})',
   '',
@@ -435,6 +489,22 @@ async function main(): Promise<void> {
       case 'fetch_ai_search': {
         const resolved = getArgs(args, ['url', 'query']);
         return {
           description: 'Fetch a URL, upload to AI Search, and optionally run a query',
           messages: [
             {
               role: 'user',
               content: {
                 type: 'text',
                 text: buildFetchAiSearchPrompt(resolved),
               },
             },
           ],
         };
       }
+      case 'ai_search_query': {
+        const resolved = getArgs(args, ['query']);
+        return {
+          description: 'Query the conversation-scoped knowledge base built by fetch()',
+          messages: [
+            {
+              role: 'user',
+              content: {
+                type: 'text',
+                text: buildAiSearchQueryPrompt(resolved),
+              },
+            },
+          ],
+        };
+      }
       case 'resources_tips': {
         return {
           description: 'How to reuse fetched content via MCP resources',
           messages: [
             {
               role: 'user',
               content: {
                 type: 'text',
                 text: buildResourcesTipsPrompt(),
               },
             },
           ],
         };
       }
       default:
         throw new McpError(ErrorCode.InvalidParams, `Prompt ${name} not found`);
     }
   });
@@ -623,6 +693,36 @@ async function main(): Promise<void> {
           };
         }

+        case 'ai_search_query': {
+          const argsObject = requireRecord(args, 'arguments');
+          const queryObj = requireRecord(argsObject['query'], 'query');
+
+          const threadKeyRaw = argsObject['thread_key'];
+          let threadKey: string | undefined = undefined;
+          if (threadKeyRaw !== undefined) {
+            if (typeof threadKeyRaw !== 'string') {
+              throw new McpError(ErrorCode.InvalidParams, 'thread_key must be a string');
+            }
+            threadKey = threadKeyRaw.trim() || undefined;
+          }
+
+          const result = await executeAiSearchQuery({
+            query: queryObj as never,
+            thread_key: threadKey,
+          });
+
+          return {
+            content: [
+              {
+                type: 'text',
+                text: JSON.stringify(result, null, 2),
+              },
+            ],
+            isError: !result.success,
+          };
+        }
+
         default:
           throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
       }
     } catch (err) {
       if (err instanceof McpError) {
         throw err;
       }
       return {
         content: [
           {
             type: 'text',
             text: JSON.stringify({
               success: false,
               error: {
                 code: 'TOOL_ERROR',
                 message: err instanceof Error ? err.message : 'Unknown error',
               },
             }),
           },
         ],
         isError: true,
       };
     }
   });
```

That patch:

- Adds `ai_search_query` prompt

- Registers `ai_search_query` in `TOOLS`

- Handles tool calls for `ai_search_query`


---

# 2) New file: `src/tools/ai-search-query.ts`

Create this file at `src/tools/ai-search-query.ts`:

```ts
/**
 * AI Search Query Tool
 *
 * Query the accumulated, scoped knowledge base built by fetch() without fetching a new URL.
 */

import type { AiSearchQueryOptions, Config } from '../types.js';
import { getConfig } from '../config.js';
import { queryAiSearchScoped } from '../ai-search/index.js';

export interface AiSearchQueryToolInput {
  /**
   * The AI Search query options.
   * Results will be auto-scoped to the current conversation/workspace based on scope resolution.
   */
  query: AiSearchQueryOptions;

  /**
   * Optional stable conversation/thread identifier.
   * If provided, overrides WEB_FETCH_THREAD_KEY for this request.
   */
  thread_key?: string;

  /**
   * Optional per-call config overrides (rare).
   */
  config?: Partial<Config>;
}

export interface AiSearchQueryToolOutput {
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export async function executeAiSearchQuery(input: AiSearchQueryToolInput): Promise<AiSearchQueryToolOutput> {
  try {
    const config = input.config ? { ...getConfig(), ...input.config } : getConfig();
    const result = await queryAiSearchScoped(input.query, config, { thread_key: input.thread_key });

    if ((result as any)?.error) {
      return {
        success: false,
        result,
        error: (result as any).error,
      };
    }

    return { success: true, result };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'AI_SEARCH_QUERY_FAILED',
        message: err instanceof Error ? err.message : 'AI Search query failed',
      },
    };
  }
}

export function getAiSearchQueryInputSchema() {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'object',
        description: 'AI Search query options (auto-scoped to the current conversation/workspace)',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string', enum: ['search', 'ai_search'] },
          rewrite_query: { type: 'boolean' },
          max_num_results: { type: 'number' },
          ranking_options: {
            type: 'object',
            properties: {
              score_threshold: { type: 'number' },
            },
          },
          reranking: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              model: { type: 'string' },
            },
          },
          filters: { type: 'object' },
          model: { type: 'string' },
          system_prompt: { type: 'string' },
        },
        required: ['query'],
      },
      thread_key: {
        type: 'string',
        description: 'Stable conversation/thread identifier used for scoping (overrides WEB_FETCH_THREAD_KEY)',
      },
      config: {
        type: 'object',
        description: 'Optional per-call config overrides',
      },
    },
    required: ['query'],
  };
}
```

---

## Wiring dependency reminder

This tool expects your `src/ai-search/index.ts` to export:

```ts
export async function queryAiSearchScoped(...)
```

If you haven’t already applied the earlier `ai-search/index.ts` changes that add `queryAiSearchScoped`, you’ll need to. If you paste your current `src/ai-search/index.ts`, I’ll produce an exact inline patch for it.

---

# Usage

### Build KB (auto indexing)

```json
{
  "url": "https://example.com/something",
  "options": {
    "ai_search": {
      "enabled": true,
      "thread_key": "thread-123"
    }
  }
}
```

### Query later

```json
{
  "thread_key": "thread-123",
  "query": {
    "query": "what did I read about caching?",
    "mode": "search"
  }
}
```

---

If you upload your current `src/ai-search/index.ts` (and optionally `src/config.ts`, `src/types.ts`, `src/tools/fetch.ts`), I’ll generate **exact** inline diffs against your versions so you can `git apply` them cleanly.

---

Below are **full file contents** (copy/paste replace) for a **complete, functional per-conversation / per-thread KB** in `web-fetch-mcp`, including:

- **Session-resilient mapping**: `(workspace_id, thread_key) -> conversation_id` persisted to disk

- **Automatic scoping** of **uploads** (R2 keys) + **queries** (AI Search metadata filters)

- **Auto-index-on-fetch** when `AI_SEARCH_ENABLED=true` (no need to set `ai_search.enabled` per call)

- A standalone **`ai_search_query` tool** so the agent can ask “what did I read earlier about X?” without fetching a new URL


Folder scoping uses Cloudflare’s recommended “starts with” filter pattern for `folder` metadata. ([Cloudflare Docs](https://developers.cloudflare.com/ai-search/configuration/metadata/ "Metadata · Cloudflare AI Search docs"))

---

## `src/types.ts`

```ts
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

/**
 * AI Search scoping strategy:
 * - conversation: isolate per (workspace_id, thread_key) -> conversation_id
 * - workspace: isolate per workspace_id (no thread key required)
 * - global: no query scoping (uploads still respect CF_R2_PREFIX base prefix)
 */
export type AiSearchScope = 'conversation' | 'workspace' | 'global';

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
  /**
   * If undefined, defaults to config.aiSearchEnabled.
   * If config.aiSearchEnabled=true and enabled is omitted, indexing happens automatically.
   */
  enabled?: boolean;

  /**
   * Optional sub-prefix *within* the resolved conversation/workspace scope.
   * This does NOT override scoping; it’s appended under the scoped base prefix.
   */
  prefix?: string;

  /**
   * Stable conversation/thread identifier for conversation scope.
   * If omitted, uses env WEB_FETCH_THREAD_KEY / AI_SEARCH_THREAD_KEY (config.aiSearchThreadKey).
   */
  thread_key?: string;

  /**
   * Optional per-call scope override (defaults to config.aiSearchScope).
   */
  scope?: AiSearchScope;

  max_file_bytes?: number;
  wait_ms?: number;
  skip_if_exists?: boolean;
  require_success?: boolean;

  /**
   * Optional AI Search query to run after upload (auto-scoped by folder).
   */
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
  original_url?: string;
  key_blocks?: KeyBlock[];
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

  // --- AI Search core ---
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

  // --- AI Search scoping / persistence ---
  aiSearchScope?: AiSearchScope;              // default: conversation
  aiSearchThreadKey?: string;                 // WEB_FETCH_THREAD_KEY / AI_SEARCH_THREAD_KEY
  aiSearchStateDir?: string;                  // AI_SEARCH_STATE_DIR
  aiSearchRequireThreadKey?: boolean;         // AI_SEARCH_REQUIRE_THREAD_KEY
  aiSearchWorkspaceRoot?: string;             // AI_SEARCH_WORKSPACE_ROOT
}
```

---

## `src/config.ts`

```ts
/**
 * Configuration management for web-fetch-mcp
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type { AiSearchScope, Config } from './types.js';

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseFloat_(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseStringArray(value: string | undefined): string[] {
  if (!value || value.trim() === '') return [];
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function parseAiSearchScope(value: string | undefined, defaultValue: AiSearchScope): AiSearchScope {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'conversation' || v === 'workspace' || v === 'global') return v;
  return defaultValue;
}

export function loadConfig(): Config {
  const defaultStateDir = path.join(os.homedir(), '.config', 'web-fetch-mcp');

  return {
    maxBytes: parseNumber(process.env['MAX_BYTES'], 10 * 1024 * 1024), // 10MB
    timeoutMs: parseNumber(process.env['TIMEOUT_MS'], 30000),
    maxRedirects: parseNumber(process.env['MAX_REDIRECTS'], 5),
    blockPrivateIp: parseBoolean(process.env['BLOCK_PRIVATE_IP'], true),
    allowlistDomains: parseStringArray(process.env['ALLOWLIST_DOMAINS']),
    rateLimitPerHost: parseNumber(process.env['RATE_LIMIT_PER_HOST'], 60),
    defaultMaxTokens: parseNumber(process.env['DEFAULT_MAX_TOKENS'], 4000),
    chunkMarginRatio: parseFloat_(process.env['CHUNK_MARGIN_RATIO'], 0.10),
    respectRobots: parseBoolean(process.env['RESPECT_ROBOTS'], true),
    playwrightEnabled: parseBoolean(process.env['PLAYWRIGHT_ENABLED'], false),
    pdfEnabled: parseBoolean(process.env['PDF_ENABLED'], true),
    cacheTtlS: parseNumber(process.env['CACHE_TTL_S'], 300),
    renderBlockThirdParty: parseBoolean(process.env['RENDER_BLOCK_THIRD_PARTY'], true),
    renderTimeoutMs: parseNumber(process.env['RENDER_TIMEOUT_MS'], 60000),
    userAgent: process.env['USER_AGENT'] || 'web-fetch-mcp/1.0 (+https://github.com/example/web-fetch-mcp)',

    // --- AI Search core ---
    aiSearchEnabled: parseBoolean(process.env['AI_SEARCH_ENABLED'], false),
    aiSearchAccountId: process.env['CF_ACCOUNT_ID'],
    aiSearchName: process.env['CF_AI_SEARCH_NAME'],
    aiSearchApiToken: process.env['CF_AI_SEARCH_API_TOKEN'],
    aiSearchR2AccessKeyId: process.env['CF_R2_ACCESS_KEY_ID'],
    aiSearchR2SecretAccessKey: process.env['CF_R2_SECRET_ACCESS_KEY'],
    aiSearchR2Bucket: process.env['CF_R2_BUCKET'],
    aiSearchR2Endpoint: process.env['CF_R2_ENDPOINT'],
    aiSearchR2Prefix: process.env['CF_R2_PREFIX'],
    aiSearchMaxFileBytes: parseNumber(process.env['AI_SEARCH_MAX_FILE_BYTES'], 4 * 1024 * 1024),
    aiSearchQueryTimeoutMs: parseNumber(process.env['AI_SEARCH_QUERY_TIMEOUT_MS'], 15000),
    aiSearchQueryWaitMs: parseNumber(process.env['AI_SEARCH_QUERY_WAIT_MS'], 0),
    aiSearchMaxQueryWaitMs: parseNumber(process.env['AI_SEARCH_MAX_QUERY_WAIT_MS'], 15000),

    // --- AI Search scoping / persistence ---
    aiSearchScope: parseAiSearchScope(
      process.env['AI_SEARCH_SCOPE'] ?? process.env['WEB_FETCH_SESSION_SCOPE'],
      'conversation'
    ),
    aiSearchThreadKey: process.env['WEB_FETCH_THREAD_KEY'] ?? process.env['AI_SEARCH_THREAD_KEY'],
    aiSearchStateDir: process.env['AI_SEARCH_STATE_DIR'] ?? process.env['WEB_FETCH_SESSION_DIR'] ?? defaultStateDir,
    aiSearchRequireThreadKey: parseBoolean(process.env['AI_SEARCH_REQUIRE_THREAD_KEY'], false),
    aiSearchWorkspaceRoot: process.env['AI_SEARCH_WORKSPACE_ROOT'],
  };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}

// Validate configuration
export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (config.maxBytes < 1024) {
    errors.push('MAX_BYTES must be at least 1024 bytes');
  }
  if (config.maxBytes > 100 * 1024 * 1024) {
    errors.push('MAX_BYTES must be at most 100MB');
  }
  if (config.timeoutMs < 1000) {
    errors.push('TIMEOUT_MS must be at least 1000ms');
  }
  if (config.timeoutMs > 300000) {
    errors.push('TIMEOUT_MS must be at most 300000ms (5 minutes)');
  }
  if (config.maxRedirects < 0 || config.maxRedirects > 20) {
    errors.push('MAX_REDIRECTS must be between 0 and 20');
  }
  if (config.rateLimitPerHost < 1 || config.rateLimitPerHost > 1000) {
    errors.push('RATE_LIMIT_PER_HOST must be between 1 and 1000');
  }
  if (config.chunkMarginRatio < 0 || config.chunkMarginRatio > 0.5) {
    errors.push('CHUNK_MARGIN_RATIO must be between 0 and 0.5');
  }
  if (config.defaultMaxTokens < 100) {
    errors.push('DEFAULT_MAX_TOKENS must be at least 100');
  }
  if (config.aiSearchMaxFileBytes < 1024) {
    errors.push('AI_SEARCH_MAX_FILE_BYTES must be at least 1024 bytes');
  }
  if (config.aiSearchQueryTimeoutMs < 1000) {
    errors.push('AI_SEARCH_QUERY_TIMEOUT_MS must be at least 1000ms');
  }
  if (config.aiSearchMaxQueryWaitMs < 0) {
    errors.push('AI_SEARCH_MAX_QUERY_WAIT_MS must be at least 0ms');
  }

  // Validate AI Search credentials when enabled
  if (config.aiSearchEnabled) {
    if (!config.aiSearchAccountId) {
      errors.push('CF_ACCOUNT_ID is required when AI_SEARCH_ENABLED=true');
    }
    if (!config.aiSearchR2Bucket) {
      errors.push('CF_R2_BUCKET is required when AI_SEARCH_ENABLED=true');
    }
    if (!config.aiSearchR2AccessKeyId) {
      errors.push('CF_R2_ACCESS_KEY_ID is required when AI_SEARCH_ENABLED=true');
    }
    if (!config.aiSearchR2SecretAccessKey) {
      errors.push('CF_R2_SECRET_ACCESS_KEY is required when AI_SEARCH_ENABLED=true');
    }

    const scope = config.aiSearchScope ?? 'conversation';
    if (scope === 'conversation' && config.aiSearchRequireThreadKey && !config.aiSearchThreadKey) {
      errors.push('WEB_FETCH_THREAD_KEY (or AI_SEARCH_THREAD_KEY) is required when AI_SEARCH_SCOPE=conversation and AI_SEARCH_REQUIRE_THREAD_KEY=true');
    }
  }

  return errors;
}
```

---

## `src/ai-search/state.ts` (NEW)

```ts
/**
 * AI Search scope state
 *
 * Provides a stable, session-resilient mapping from a (workspace_id, thread_key)
 * to a conversation_id, persisted on disk.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AiSearchScope, Config } from '../types.js';

export type ScopeMode = 'conversation' | 'workspace' | 'global';

export interface ScopeResolution {
  /** The effective scope mode used for this request. */
  scope: ScopeMode;
  /** Stable id derived from workspace root, present for workspace/conversation scopes. */
  workspace_id?: string;
  /** Stable id mapped from (workspace_id, thread_key), present for conversation scope. */
  conversation_id?: string;
  /** The R2 prefix used for uploads (includes base prefix + scope prefix), always normalized with trailing '/'. */
  upload_prefix: string;
  /** The folder prefix used for query scoping. Empty string means "do not scope queries". */
  folder_scope_prefix: string;
}

interface StateFile {
  version: 1;
  threads: Record<string, ThreadEntry>;
}

interface ThreadEntry {
  conversation_id: string;
  created_at: string;
  last_used_at: string;
}

export class AiSearchScopeError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AiSearchScopeError';
    this.code = code;
    this.details = details;
  }
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const noLeading = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  return noLeading.endsWith('/') ? noLeading : `${noLeading}/`;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(startDir: string): Promise<string | null> {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.git');
    if (await exists(candidate)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function resolveWorkspaceRoot(config: Config, cwdOverride?: string): Promise<string> {
  const override = config.aiSearchWorkspaceRoot?.trim();
  if (override) {
    return path.resolve(override);
  }

  const cwd = cwdOverride ? path.resolve(cwdOverride) : process.cwd();
  const gitRoot = await findGitRoot(cwd);
  return gitRoot ?? cwd;
}

export function computeWorkspaceId(workspaceRoot: string): string {
  // Stable but opaque id.
  return sha256Hex(path.resolve(workspaceRoot)).slice(0, 12);
}

function computeThreadKeyId(threadKey: string): string {
  return sha256Hex(threadKey).slice(0, 16);
}

function getStateFilePath(config: Config): string {
  const dir = config.aiSearchStateDir?.trim() || path.join(process.env.HOME || '', '.config', 'web-fetch-mcp');
  return path.join(dir, 'ai-search-state.json');
}

async function loadState(config: Config): Promise<StateFile> {
  const filePath = getStateFilePath(config);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    if (!parsed || parsed.version !== 1 || typeof parsed.threads !== 'object' || !parsed.threads) {
      return { version: 1, threads: {} };
    }
    return { version: 1, threads: parsed.threads as Record<string, ThreadEntry> };
  } catch {
    return { version: 1, threads: {} };
  }
}

async function saveState(config: Config, state: StateFile): Promise<void> {
  const filePath = getStateFilePath(config);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

async function getOrCreateConversationId(config: Config, workspaceId: string, threadKey: string): Promise<string> {
  const state = await loadState(config);

  const threadKeyId = computeThreadKeyId(threadKey);
  const stateKey = `${workspaceId}::${threadKeyId}`;

  const now = new Date().toISOString();
  const existing = state.threads[stateKey];
  if (existing) {
    existing.last_used_at = now;
    await saveState(config, state);
    return existing.conversation_id;
  }

  const conversationId = crypto.randomUUID();
  state.threads[stateKey] = {
    conversation_id: conversationId,
    created_at: now,
    last_used_at: now,
  };
  await saveState(config, state);
  return conversationId;
}

function scopePrefixFor(scope: ScopeMode, workspaceId?: string, conversationId?: string): string {
  if (scope === 'global') {
    return '';
  }
  if (scope === 'workspace') {
    return `workspaces/${workspaceId}/`;
  }
  return `workspaces/${workspaceId}/conversations/${conversationId}/`;
}

export async function resolveAiSearchScope(
  config: Config,
  threadKeyOverride?: string,
  cwdOverride?: string
): Promise<ScopeResolution> {
  const basePrefix = normalizePrefix(config.aiSearchR2Prefix ?? '');

  const requestedScope: AiSearchScope = config.aiSearchScope ?? 'conversation';

  if (requestedScope === 'global') {
    return {
      scope: 'global',
      upload_prefix: basePrefix,
      folder_scope_prefix: '',
    };
  }

  const workspaceRoot = await resolveWorkspaceRoot(config, cwdOverride);
  const workspaceId = computeWorkspaceId(workspaceRoot);

  if (requestedScope === 'workspace') {
    const scoped = `${basePrefix}${scopePrefixFor('workspace', workspaceId)}`;
    return {
      scope: 'workspace',
      workspace_id: workspaceId,
      upload_prefix: scoped,
      folder_scope_prefix: scoped,
    };
  }

  const threadKey = (threadKeyOverride ?? config.aiSearchThreadKey)?.trim();
  if (!threadKey) {
    if (config.aiSearchRequireThreadKey) {
      throw new AiSearchScopeError(
        'AI_SEARCH_MISSING_THREAD_KEY',
        'Missing thread_key. Provide WEB_FETCH_THREAD_KEY/AI_SEARCH_THREAD_KEY or options.ai_search.thread_key.',
        { requested_scope: 'conversation' }
      );
    }

    // Graceful fallback: keep isolation at workspace granularity.
    const scoped = `${basePrefix}${scopePrefixFor('workspace', workspaceId)}`;
    return {
      scope: 'workspace',
      workspace_id: workspaceId,
      upload_prefix: scoped,
      folder_scope_prefix: scoped,
    };
  }

  const conversationId = await getOrCreateConversationId(config, workspaceId, threadKey);
  const scoped = `${basePrefix}${scopePrefixFor('conversation', workspaceId, conversationId)}`;
  return {
    scope: 'conversation',
    workspace_id: workspaceId,
    conversation_id: conversationId,
    upload_prefix: scoped,
    folder_scope_prefix: scoped,
  };
}
```

---

## `src/ai-search/index.ts`

```ts
/**
 * Cloudflare AI Search (AutoRAG) R2 ingestion + query
 *
 * Updated: conversation/workspace scoped prefixes + query scoping filters.
 */

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

import type { AiSearchOptions, AiSearchQueryOptions, Config, LLMPacket } from '../types.js';
import { getConfig } from '../config.js';
import { resolveAiSearchScope, AiSearchScopeError, type ScopeResolution } from './state.js';

// ============================================
// TYPES
// ============================================

export interface AiSearchError {
  code: string;
  message: string;
  details?: unknown;
}

export interface AiSearchQueryResult {
  mode: 'search' | 'ai_search';
  request: Record<string, unknown>;
  status?: number;
  response?: unknown;
  error?: AiSearchError;
}

export interface AiSearchIngestResult {
  enabled: boolean;
  uploaded: boolean;
  skipped_existing?: boolean;
  bucket?: string;
  prefix?: string;
  keys?: string[];
  bytes?: number;
  parts?: number;
  query?: AiSearchQueryResult;
  error?: AiSearchError;

  /**
   * Debug/telemetry: what scope was used and what prefixes were applied.
   */
  scope_resolution?: ScopeResolution;
}

// ============================================
// CONSTANTS
// ============================================

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB
const DEFAULT_UPLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// ============================================
// HELPERS
// ============================================

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const noLeading = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  return noLeading.endsWith('/') ? noLeading : `${noLeading}/`;
}

function joinPrefixes(...parts: Array<string | undefined | null>): string {
  const normalized = parts
    .map(p => (p ?? '').trim())
    .filter(Boolean)
    .map(p => normalizePrefix(p));

  // join then collapse accidental double slashes
  return normalized.join('').replace(/\/{2,}/g, '/');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function buildFrontmatter(packet: LLMPacket, partIndex: number, totalParts: number): string {
  const safeTitle = (packet.metadata.title || '').replace(/\n/g, ' ').trim();
  const safeSite = (packet.metadata.site_name || '').replace(/\n/g, ' ').trim();
  const safeLang = (packet.metadata.language || '').replace(/\n/g, ' ').trim();
  const safePublished = (packet.metadata.published_at ?? '').toString().replace(/\n/g, ' ').trim();

  return [
    '---',
    `source_id: "${packet.source_id}"`,
    `original_url: "${packet.original_url}"`,
    `canonical_url: "${packet.canonical_url}"`,
    `retrieved_at: "${packet.retrieved_at}"`,
    `status: ${packet.status}`,
    `content_type: "${packet.content_type}"`,
    safeTitle ? `title: "${safeTitle.replace(/"/g, '\\"')}"` : undefined,
    safeSite ? `site_name: "${safeSite.replace(/"/g, '\\"')}"` : undefined,
    safeLang ? `language: "${safeLang.replace(/"/g, '\\"')}"` : undefined,
    safePublished ? `published_at: "${safePublished.replace(/"/g, '\\"')}"` : undefined,
    `part_index: ${partIndex}`,
    `total_parts: ${totalParts}`,
    `content_hash: "${packet.hashes.content_hash}"`,
    '---',
  ].filter(Boolean).join('\n');
}

function buildKeyBase(packet: LLMPacket, prefix: string): string {
  const url = new URL(packet.canonical_url || packet.original_url);
  const hostname = url.hostname.replace(/[^a-zA-Z0-9.-]/g, '_');

  // Keep some path context, but bounded.
  const pathParts = url.pathname.split('/').filter(Boolean).slice(0, 6).map(p => p.replace(/[^a-zA-Z0-9._-]/g, '_'));
  const pathKey = pathParts.length ? pathParts.join('/') : 'root';

  // (prefix)/hostname/pathKey
  const normalizedPrefix = normalizePrefix(prefix);
  return `${normalizedPrefix}${hostname}/${pathKey}`.replace(/\/{2,}/g, '/');
}

function splitByChars(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let current = '';

  for (const ch of text) {
    const candidate = current + ch;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    current = ch;
  }

  if (current) parts.push(current);
  return parts;
}

function splitByLines(text: string, maxBytes: number): string[] {
  const lines = text.split('\n');
  const parts: string[] = [];
  let current = '';

  const flush = () => {
    if (current) {
      parts.push(current);
      current = '';
    }
  };

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    flush();

    if (byteLength(line) <= maxBytes) {
      current = line;
      continue;
    }

    const charParts = splitByChars(line, maxBytes);
    for (const part of charParts) {
      parts.push(part);
    }
  }

  flush();
  return parts;
}

export function splitMarkdownByBytes(markdown: string, maxBytes: number): string[] {
  if (maxBytes <= 0) {
    return [markdown];
  }

  if (byteLength(markdown) <= maxBytes) {
    return [markdown];
  }

  const paragraphs = markdown.split(/\n{2,}/);
  const parts: string[] = [];
  let current = '';

  const flush = () => {
    if (current) {
      parts.push(current);
      current = '';
    }
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    flush();

    if (byteLength(paragraph) <= maxBytes) {
      current = paragraph;
      continue;
    }

    const lineParts = splitByLines(paragraph, maxBytes);
    for (const linePart of lineParts) {
      if (!current) {
        current = linePart;
        continue;
      }

      const lineCandidate = `${current}\n${linePart}`;
      if (byteLength(lineCandidate) <= maxBytes) {
        current = lineCandidate;
      } else {
        flush();
        current = linePart;
      }
    }
  }

  flush();
  return parts;
}

function getR2Client(config: Config): S3Client {
  if (!config.aiSearchR2Endpoint || !config.aiSearchR2AccessKeyId || !config.aiSearchR2SecretAccessKey) {
    throw new Error('Missing CF_R2_ENDPOINT, CF_R2_ACCESS_KEY_ID, or CF_R2_SECRET_ACCESS_KEY');
  }

  return new S3Client({
    region: 'auto',
    endpoint: config.aiSearchR2Endpoint,
    credentials: {
      accessKeyId: config.aiSearchR2AccessKeyId,
      secretAccessKey: config.aiSearchR2SecretAccessKey,
    },
  });
}

async function objectExists(client: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (err as { name?: string })?.name;
    if (statusCode === 404 || name === 'NotFound') {
      return false;
    }
    throw err;
  }
}

async function uploadObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  retries: number = DEFAULT_UPLOAD_RETRIES
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'text/markdown; charset=utf-8',
      }));
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

// ============================================
// QUERY (SCOPED)
// ============================================

type FilterNode = {
  type: string;
  key?: string;
  value?: unknown;
  filters?: FilterNode[];
};

function buildFolderStartsWithFilter(folderPrefix: string): FilterNode {
  // Cloudflare “starts with” filter trick for folder:
  //   and( gt(folder, "<prefix>//"), lte(folder, "<prefix>z") )
  // See docs for details. :contentReference[oaicite:1]{index=1} (citation provided in chat, not in code)
  const p = normalizePrefix(folderPrefix); // must end with "/"
  return {
    type: 'and',
    filters: [
      { type: 'gt', key: 'folder', value: `${p}/` }, // yields double slash, per docs
      { type: 'lte', key: 'folder', value: `${p}z` }, // yields "/z"
    ],
  };
}

function mergeFilters(existing: unknown, required: FilterNode): unknown {
  if (!existing) return required;

  if (typeof existing !== 'object' || existing === null) {
    return required;
  }

  const ex = existing as FilterNode;

  // If existing is an AND compound, append required comparisons (flatten)
  if (ex.type === 'and' && Array.isArray(ex.filters)) {
    const requiredParts = required.type === 'and' && Array.isArray(required.filters)
      ? required.filters
      : [required];
    return {
      ...ex,
      filters: [...ex.filters, ...requiredParts],
    };
  }

  // If existing is OR compound, we cannot legally nest compound filters (Cloudflare limitation).
  if (ex.type === 'or') {
    throw new AiSearchScopeError(
      'AI_SEARCH_FILTER_INCOMPATIBLE',
      'Cannot combine conversation/workspace folder scoping with an OR compound filter. Use AND-only filters or run separate queries.',
      { existing_filter: existing }
    );
  }

  // Otherwise: create a top-level AND and inline required comparisons
  const requiredParts = required.type === 'and' && Array.isArray(required.filters)
    ? required.filters
    : [required];

  return {
    type: 'and',
    filters: [ex, ...requiredParts],
  } satisfies FilterNode;
}

function buildQueryRequest(options: AiSearchQueryOptions): Record<string, unknown> {
  const request: Record<string, unknown> = {
    query: options.query,
  };

  if (options.rewrite_query !== undefined) {
    request['rewrite_query'] = options.rewrite_query;
  }
  if (options.max_num_results !== undefined) {
    request['max_num_results'] = options.max_num_results;
  }
  if (options.ranking_options) {
    request['ranking_options'] = options.ranking_options;
  }
  if (options.reranking) {
    request['reranking'] = options.reranking;
  }
  if (options.filters) {
    request['filters'] = options.filters;
  }
  if (options.model) {
    request['model'] = options.model;
  }
  if (options.system_prompt) {
    request['system_prompt'] = options.system_prompt;
  }

  return request;
}

async function queryAiSearch(
  options: AiSearchQueryOptions,
  config: Config
): Promise<AiSearchQueryResult> {
  if (!config.aiSearchAccountId || !config.aiSearchName || !config.aiSearchApiToken) {
    return {
      mode: options.mode ?? 'search',
      request: buildQueryRequest(options),
      error: {
        code: 'AI_SEARCH_NOT_CONFIGURED',
        message: 'Missing CF_ACCOUNT_ID, CF_AI_SEARCH_NAME, or CF_AI_SEARCH_API_TOKEN',
      },
    };
  }

  const mode = options.mode ?? 'search';
  const endpoint = mode === 'ai_search' ? 'ai-search' : 'search';
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.aiSearchAccountId}/autorag/rags/${encodeURIComponent(config.aiSearchName)}/${endpoint}`;
  const requestBody = buildQueryRequest(options);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiSearchQueryTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.aiSearchApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const status = response.status;
    const text = await response.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      return {
        mode,
        request: requestBody,
        status,
        response: parsed,
        error: {
          code: 'AI_SEARCH_QUERY_FAILED',
          message: `AI Search query failed with status ${status}`,
          details: parsed,
        },
      };
    }

    return {
      mode,
      request: requestBody,
      status,
      response: parsed,
    };
  } catch (err) {
    return {
      mode,
      request: requestBody,
      error: {
        code: 'AI_SEARCH_QUERY_FAILED',
        message: err instanceof Error ? err.message : 'AI Search query failed',
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function clampWaitMs(waitMs: number, config: Config): number {
  if (waitMs <= 0) return 0;
  return Math.min(waitMs, config.aiSearchMaxQueryWaitMs);
}

/**
 * Query AI Search with automatic folder scoping based on (workspace, conversation/thread).
 */
export async function queryAiSearchScoped(
  options: AiSearchQueryOptions,
  config: Config = getConfig(),
  scope?: { thread_key?: string; cwd?: string; prefix?: string }
): Promise<AiSearchQueryResult> {
  let resolution: ScopeResolution;
  try {
    resolution = await resolveAiSearchScope(config, scope?.thread_key, scope?.cwd);
  } catch (err) {
    if (err instanceof AiSearchScopeError) {
      return {
        mode: options.mode ?? 'search',
        request: buildQueryRequest(options),
        error: { code: err.code, message: err.message, details: err.details },
      };
    }
    return {
      mode: options.mode ?? 'search',
      request: buildQueryRequest(options),
      error: { code: 'AI_SEARCH_SCOPE_RESOLUTION_FAILED', message: err instanceof Error ? err.message : 'Scope resolution failed' },
    };
  }

  // Optional additional sub-prefix for query scoping (rare; usually omit)
  const extra = scope?.prefix ? normalizePrefix(scope.prefix) : '';
  const folderScope = joinPrefixes(resolution.folder_scope_prefix, extra);

  let scoped = { ...options };

  if (folderScope && resolution.scope !== 'global') {
    const required = buildFolderStartsWithFilter(folderScope);
    scoped = {
      ...scoped,
      filters: mergeFilters(scoped.filters, required) as Record<string, unknown>,
    };
  }

  return queryAiSearch(scoped, config);
}

// ============================================
// INGEST (SCOPED)
// ============================================

export async function ingestPacketToAiSearch(
  packet: LLMPacket,
  options: AiSearchOptions,
  config: Config = getConfig()
): Promise<AiSearchIngestResult> {
  const enabled = options.enabled ?? config.aiSearchEnabled;
  if (!enabled) {
    return {
      enabled: false,
      uploaded: false,
    };
  }

  if (!config.aiSearchR2Bucket) {
    return {
      enabled: true,
      uploaded: false,
      error: {
        code: 'AI_SEARCH_NOT_CONFIGURED',
        message: 'Missing CF_R2_BUCKET configuration',
      },
    };
  }

  let resolution: ScopeResolution;
  try {
    // Allow per-call scope override (defaults to config.aiSearchScope)
    const mergedConfig = options.scope ? { ...config, aiSearchScope: options.scope } : config;
    resolution = await resolveAiSearchScope(mergedConfig, options.thread_key);
  } catch (err) {
    if (err instanceof AiSearchScopeError) {
      return {
        enabled: true,
        uploaded: false,
        error: { code: err.code, message: err.message, details: err.details },
      };
    }
    return {
      enabled: true,
      uploaded: false,
      error: {
        code: 'AI_SEARCH_SCOPE_RESOLUTION_FAILED',
        message: err instanceof Error ? err.message : 'Scope resolution failed',
      },
    };
  }

  let client: S3Client;
  try {
    client = getR2Client(config);
  } catch (err) {
    return {
      enabled: true,
      uploaded: false,
      scope_resolution: resolution,
      error: {
        code: 'AI_SEARCH_NOT_CONFIGURED',
        message: err instanceof Error ? err.message : 'Missing R2 configuration',
      },
    };
  }

  const maxFileBytes = options.max_file_bytes ?? config.aiSearchMaxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  // Final upload prefix = resolved scope prefix + optional per-call subprefix
  const effectiveUploadPrefix = joinPrefixes(resolution.upload_prefix, options.prefix);
  const keyBase = buildKeyBase(packet, effectiveUploadPrefix);
  const keyPrefix = `${keyBase}/${packet.hashes.content_hash}`;

  let parts: string[] = [];
  let totalParts = 1;
  let overheadBytes = byteLength(buildFrontmatter(packet, 1, 1)) + 2;

  for (let attempt = 0; attempt < 3; attempt++) {
    const maxContentBytes = Math.max(1, maxFileBytes - overheadBytes);
    parts = splitMarkdownByBytes(packet.content, maxContentBytes);
    const nextTotal = parts.length;
    const nextOverhead = byteLength(buildFrontmatter(packet, nextTotal, nextTotal)) + 2;
    if (nextTotal === totalParts && nextOverhead === overheadBytes) {
      totalParts = nextTotal;
      break;
    }
    totalParts = nextTotal;
    overheadBytes = nextOverhead;
  }

  if (overheadBytes >= maxFileBytes) {
    return {
      enabled: true,
      uploaded: false,
      scope_resolution: resolution,
      error: {
        code: 'AI_SEARCH_CONTENT_TOO_LARGE',
        message: 'Frontmatter exceeds AI Search file size limit',
      },
    };
  }

  const keys = parts.map((_, index) => {
    const suffix = String(index + 1).padStart(4, '0');
    return `${keyPrefix}/part-${suffix}.md`;
  });

  const totalBytes = parts.reduce((sum, part, index) => {
    const frontmatter = buildFrontmatter(packet, index + 1, totalParts);
    return sum + byteLength(frontmatter) + 2 + byteLength(part);
  }, 0);
  const skipIfExists = options.skip_if_exists ?? true;

  try {
    // Check if ALL parts exist (not just first) to handle partial upload recovery
    let allPartsExist = false;
    if (skipIfExists && keys.length > 0) {
      const lastKey = keys[keys.length - 1]!;
      const firstExists = await objectExists(client, config.aiSearchR2Bucket, keys[0]!);
      const lastExists = keys.length === 1 || await objectExists(client, config.aiSearchR2Bucket, lastKey);
      allPartsExist = firstExists && lastExists;
    }

    // Folder scope for queries = resolved scope prefix (plus optional subprefix)
    const effectiveFolderScope = joinPrefixes(resolution.folder_scope_prefix, options.prefix);

    if (allPartsExist) {
      const query = options.query
        ? await queryAiSearchScoped(options.query, config, { thread_key: options.thread_key, prefix: effectiveFolderScope })
        : undefined;

      return {
        enabled: true,
        uploaded: false,
        skipped_existing: true,
        bucket: config.aiSearchR2Bucket,
        prefix: keyPrefix,
        keys,
        bytes: totalBytes,
        parts: parts.length,
        query,
        scope_resolution: resolution,
      };
    }

    for (let i = 0; i < parts.length; i++) {
      const content = parts[i] ?? '';
      const frontmatter = buildFrontmatter(packet, i + 1, totalParts);
      const body = Buffer.from(`${frontmatter}\n\n${content}`, 'utf8');
      await uploadObject(client, config.aiSearchR2Bucket, keys[i]!, body);
    }

    const waitMs = clampWaitMs(options.wait_ms ?? config.aiSearchQueryWaitMs, config);
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const query = options.query
      ? await queryAiSearchScoped(options.query, config, { thread_key: options.thread_key, prefix: effectiveFolderScope })
      : undefined;

    return {
      enabled: true,
      uploaded: true,
      bucket: config.aiSearchR2Bucket,
      prefix: keyPrefix,
      keys,
      bytes: totalBytes,
      parts: parts.length,
      query,
      scope_resolution: resolution,
    };
  } catch (err) {
    return {
      enabled: true,
      uploaded: false,
      scope_resolution: resolution,
      error: {
        code: 'AI_SEARCH_UPLOAD_FAILED',
        message: err instanceof Error ? err.message : 'Failed to upload content to R2',
      },
    };
  }
}
```

---

## `src/tools/fetch.ts`

```ts
/**
 * Fetch Tool
 *
 * Main tool for fetching and extracting content from URLs.
 */

import type {
  FetchOptions,
  FetchResult,
  LLMPacket,
  NormalizedContent,
  RawFetchResult,
} from '../types.js';
import type { AiSearchIngestResult } from '../ai-search/index.js';
import { httpFetchWithRetry } from '../fetcher/http-fetcher.js';
import { browserRender, isBrowserAvailable } from '../fetcher/browser-renderer.js';
import { applyCrawlDelay, checkRobots } from '../fetcher/robots.js';
import { normalizeContent, toNormalizedContent } from '../processing/normalizer.js';
import { getRateLimiter, waitForRateLimit } from '../security/rate-limiter.js';
import { checkSSRF } from '../security/ssrf-guard.js';
import { getHostname } from '../utils/url.js';
import { getConfig } from '../config.js';
import { ingestPacketToAiSearch } from '../ai-search/index.js';
import { storePacketResource } from '../resources/store.js';

export interface FetchToolInput {
  url: string;
  options?: FetchOptions;
}

export interface FetchToolOutput {
  success: boolean;
  packet?: LLMPacket;
  normalized?: NormalizedContent;
  raw?: {
    bytes_length: number;
    content_type: string;
    headers: Record<string, string>;
  };
  screenshot_base64?: string;
  ai_search?: AiSearchIngestResult;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type FetchToolError = NonNullable<FetchToolOutput['error']>;

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function shouldAttemptRenderFallback(
  rawResult: RawFetchResult,
  packet: LLMPacket
): boolean {
  if (!rawResult.contentType.includes('html')) {
    return false;
  }

  const bodyBytes = rawResult.body.length;
  const wordCount = countWords(packet.content);
  const outlineCount = packet.outline.length;

  if (bodyBytes < 5000) {
    return false;
  }

  if (/enable\s+javascript|enable\s+js|requires\s+javascript|turn\s+on\s+javascript/i.test(packet.content)) {
    return true;
  }

  if (wordCount < 40 && bodyBytes >= 5000) {
    return true;
  }

  if (wordCount < 80 && bodyBytes >= 20000) {
    return true;
  }

  if (outlineCount === 0 && wordCount < 200 && bodyBytes >= 10000) {
    return true;
  }

  return false;
}

async function fetchWithRender(
  url: string,
  config: ReturnType<typeof getConfig>,
  options: FetchOptions
): Promise<{ success: true; result: RawFetchResult; screenshot?: Buffer } | { success: false; error: FetchToolError }> {
  const browserAvailable = await isBrowserAvailable();
  if (!browserAvailable) {
    return {
      success: false,
      error: {
        code: 'RENDER_UNAVAILABLE',
        message: 'Browser rendering is not available. Enable PLAYWRIGHT_ENABLED and install Playwright.',
      },
    };
  }

  const effectiveUserAgent = options.user_agent ?? config.userAgent;
  const respectRobots = options.respect_robots ?? config.respectRobots;

  const ssrfCheck = await checkSSRF(url, {
    blockPrivateIp: config.blockPrivateIp,
    allowlistDomains: config.allowlistDomains,
  });

  if (!ssrfCheck.safe) {
    return {
      success: false,
      error: {
        code: 'SSRF_BLOCKED',
        message: ssrfCheck.error || 'Request blocked by SSRF protection',
      },
    };
  }

  if (respectRobots) {
    const robotsResult = await checkRobots(url, {
      timeoutMs: 10000,
      userAgent: effectiveUserAgent,
    });

    if (!robotsResult.allowed) {
      return {
        success: false,
        error: {
          code: 'ROBOTS_BLOCKED',
          message: 'URL is blocked by robots.txt',
        },
      };
    }

    await applyCrawlDelay(new URL(url).origin, robotsResult.crawlDelay, effectiveUserAgent);
  }

  const hostname = getHostname(url);
  if (hostname) {
    const rateLimiter = getRateLimiter(config.rateLimitPerHost);
    const canProceed = await waitForRateLimit(hostname, rateLimiter, 30000);

    if (!canProceed) {
      return {
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Rate limit exceeded for this host',
        },
      };
    }

    rateLimiter.recordRequest(hostname);
  }

  const renderResult = await browserRender(url, {
    wait_until: options.render?.wait_until,
    wait_ms: options.render?.wait_ms,
    block_third_party: options.render?.block_third_party,
    screenshot: options.render?.screenshot,
    selector: options.render?.selector,
    timeout_ms: options.timeout_ms,
    max_bytes: options.max_bytes,
    user_agent: effectiveUserAgent,
  });

  if (!renderResult.success) {
    return {
      success: false,
      error: {
        code: renderResult.error.code,
        message: renderResult.error.message,
      },
    };
  }

  if (respectRobots) {
    const robotsResult = await checkRobots(renderResult.result.finalUrl, {
      timeoutMs: 10000,
      userAgent: effectiveUserAgent,
    });

    if (!robotsResult.allowed) {
      return {
        success: false,
        error: {
          code: 'ROBOTS_BLOCKED',
          message: 'URL is blocked by robots.txt',
        },
      };
    }

    await applyCrawlDelay(new URL(renderResult.result.finalUrl).origin, robotsResult.crawlDelay, effectiveUserAgent);
  }

  return {
    success: true,
    result: renderResult.result,
    screenshot: renderResult.screenshot,
  };
}

/**
 * Execute the fetch tool
 */
export async function executeFetch(input: FetchToolInput): Promise<FetchToolOutput> {
  const { url, options = {} } = input;
  const config = getConfig();

  const {
    mode = 'auto',
    headers,
    timeout_ms,
    max_bytes,
    max_redirects,
    user_agent,
    respect_robots,
    cache_ttl_s,
    extraction,
    format,
  } = options;

  try {
    let rawResult: RawFetchResult | null = null;
    let screenshot: Buffer | undefined;
    let usedRender = false;
    let lastRenderError: FetchToolError | undefined;

    // Determine fetch mode
    let useRender = mode === 'render';

    if (mode === 'auto') {
      // Use render mode for certain domains/patterns that typically need JS
      const jsHeavySites = [
        'twitter.com',
        'x.com',
        'facebook.com',
        'instagram.com',
        'linkedin.com',
        'reddit.com',
        'medium.com',
        'substack.com',
      ];

      const hostname = new URL(url).hostname.toLowerCase();
      useRender = jsHeavySites.some(site =>
        hostname === site || hostname.endsWith('.' + site)
      );

      // Only use render if available
      if (useRender && !config.playwrightEnabled) {
        useRender = false;
      }
    }

    const tryRender = async (): Promise<{ success: true; result: RawFetchResult; screenshot?: Buffer } | { success: false }> => {
      const renderResult = await fetchWithRender(url, config, options);
      if (!renderResult.success) {
        lastRenderError = renderResult.error;
        return { success: false };
      }

      return {
        success: true,
        result: renderResult.result,
        screenshot: renderResult.screenshot,
      };
    };

    if (useRender) {
      const renderAttempt = await tryRender();
      if (!renderAttempt.success) {
        if (mode !== 'auto') {
          return {
            success: false,
            error: lastRenderError,
          };
        }
      } else {
        rawResult = renderAttempt.result;
        screenshot = renderAttempt.screenshot;
        usedRender = true;
      }
    }

    if (!rawResult) {
      const httpResult = await httpFetchWithRetry(url, {
        headers,
        timeout_ms,
        max_bytes,
        max_redirects,
        user_agent,
        respect_robots,
        cache_ttl_s,
      });

      if (!httpResult.success) {
        return {
          success: false,
          error: {
            code: httpResult.error.code,
            message: httpResult.error.message,
            details: httpResult.error.statusCode,
          },
        };
      }

      rawResult = httpResult.result;
    }

    // Check output format
    if (format?.output === 'raw') {
      return {
        success: true,
        raw: {
          bytes_length: rawResult.body.length,
          content_type: rawResult.contentType,
          headers: rawResult.headers,
        },
      };
    }

    let normalizedOutput: NormalizedContent | undefined;

    // Normalize content into LLMPacket
    let normalizeResult = await normalizeContent(rawResult, url, {
      extraction,
      format,
    });

    if (!normalizeResult.success || !normalizeResult.packet) {
      if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
        const renderAttempt = await tryRender();
        if (renderAttempt.success) {
          const renderNormalize = await normalizeContent(renderAttempt.result, url, {
            extraction,
            format,
          });
          if (renderNormalize.success && renderNormalize.packet) {
            normalizeResult = renderNormalize;
            rawResult = renderAttempt.result;
            screenshot = renderAttempt.screenshot;
            usedRender = true;
          }
        }
      }

      if (!normalizeResult.success || !normalizeResult.packet) {
        return {
          success: false,
          error: {
            code: 'EXTRACTION_FAILED',
            message: normalizeResult.error || 'Failed to extract content',
          },
        };
      }
    }

    if (mode === 'auto' && !usedRender && config.playwrightEnabled) {
      if (shouldAttemptRenderFallback(rawResult, normalizeResult.packet)) {
        const renderAttempt = await tryRender();
        if (renderAttempt.success) {
          const renderNormalize = await normalizeContent(renderAttempt.result, url, {
            extraction,
            format,
          });
          if (renderNormalize.success && renderNormalize.packet) {
            normalizeResult = renderNormalize;
            rawResult = renderAttempt.result;
            screenshot = renderAttempt.screenshot;
            usedRender = true;
          }
        }
      }
    }

    // Add screenshot if taken
    if (screenshot && normalizeResult.packet) {
      normalizeResult.packet.screenshot_base64 = screenshot.toString('base64');
    }

    let aiSearchResult: AiSearchIngestResult | undefined;

    // If AI_SEARCH_ENABLED=true, indexing happens automatically unless explicitly disabled per call.
    const aiSearchEnabled = options.ai_search?.enabled ?? config.aiSearchEnabled;

    if (aiSearchEnabled && normalizeResult.packet) {
      aiSearchResult = await ingestPacketToAiSearch(
        normalizeResult.packet,
        options.ai_search ?? {},
        config
      );

      const aiSearchError = aiSearchResult.error ?? aiSearchResult.query?.error;
      if (aiSearchError && options.ai_search?.require_success) {
        return {
          success: false,
          error: {
            code: aiSearchError.code,
            message: aiSearchError.message,
            details: aiSearchError.details,
          },
        };
      }
    }

    if (format?.output === 'normalized' && normalizeResult.packet) {
      normalizedOutput = toNormalizedContent(normalizeResult.packet);
    }

    if (normalizeResult.packet) {
      storePacketResource(normalizeResult.packet);
    }

    return {
      success: true,
      packet: format?.output === 'normalized' ? undefined : normalizeResult.packet,
      normalized: normalizedOutput,
      screenshot_base64: screenshot ? screenshot.toString('base64') : normalizeResult.packet?.screenshot_base64,
      ai_search: aiSearchResult,
    };

  } catch (err) {
    return {
      success: false,
      error: {
        code: 'UNEXPECTED_ERROR',
        message: err instanceof Error ? err.message : 'Unknown error occurred',
      },
    };
  }
}

/**
 * Get JSON schema for fetch tool input
 */
export function getFetchInputSchema(): object {
  return {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      options: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['auto', 'http', 'render'],
            description: 'Fetch mode: auto (detect), http (simple fetch), render (browser)',
            default: 'auto',
          },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Custom HTTP headers',
          },
          timeout_ms: {
            type: 'number',
            description: 'Request timeout in milliseconds',
          },
          max_bytes: {
            type: 'number',
            description: 'Maximum response size in bytes',
          },
          max_redirects: {
            type: 'number',
            description: 'Maximum redirects to follow',
          },
          user_agent: {
            type: 'string',
            description: 'Custom User-Agent header',
          },
          respect_robots: {
            type: 'boolean',
            description: 'Whether to respect robots.txt',
          },
          cache_ttl_s: {
            type: 'number',
            description: 'Cache TTL in seconds for this request (0 to disable)',
          },
          render: {
            type: 'object',
            properties: {
              wait_until: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle'],
              },
              wait_ms: {
                type: 'number',
                description: 'Additional wait time after page load',
              },
              block_third_party: {
                type: 'boolean',
                description: 'Block third-party requests',
              },
              screenshot: {
                type: 'boolean',
                description: 'Take a screenshot',
              },
              selector: {
                type: 'string',
                description: 'Wait for specific CSS selector',
              },
            },
          },
          extraction: {
            type: 'object',
            properties: {
              prefer_readability: {
                type: 'boolean',
                default: true,
              },
              keep_tables: {
                type: 'boolean',
                default: true,
              },
              keep_code_blocks: {
                type: 'boolean',
                default: true,
              },
              remove_selectors: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          format: {
            type: 'object',
            properties: {
              output: {
                type: 'string',
                enum: ['llm_packet', 'raw', 'normalized'],
              },
              include_raw_excerpt: {
                type: 'boolean',
              },
            },
          },
          ai_search: {
            type: 'object',
            properties: {
              enabled: {
                type: 'boolean',
                description: 'Upload extracted content to Cloudflare R2 for AI Search indexing (defaults to AI_SEARCH_ENABLED)',
              },
              scope: {
                type: 'string',
                enum: ['conversation', 'workspace', 'global'],
                description: 'Override AI Search scoping for this call',
              },
              thread_key: {
                type: 'string',
                description: 'Stable conversation/thread identifier for conversation-scoped KB (overrides WEB_FETCH_THREAD_KEY)',
              },
              prefix: {
                type: 'string',
                description: 'Optional sub-prefix within the resolved scope for R2 object keys',
              },
              max_file_bytes: {
                type: 'number',
                description: 'Maximum bytes per uploaded file (default: 4MB)',
              },
              wait_ms: {
                type: 'number',
                description: 'Optional delay before running AI Search query (ms)',
              },
              skip_if_exists: {
                type: 'boolean',
                description: 'Skip upload if the first part already exists',
              },
              require_success: {
                type: 'boolean',
                description: 'Fail the fetch tool if AI Search upload or query fails',
              },
              query: {
                type: 'object',
                description: 'Optional AI Search query after upload (auto-scoped)',
                properties: {
                  query: { type: 'string' },
                  mode: { type: 'string', enum: ['search', 'ai_search'] },
                  rewrite_query: { type: 'boolean' },
                  max_num_results: { type: 'number' },
                  ranking_options: {
                    type: 'object',
                    properties: {
                      score_threshold: { type: 'number' },
                    },
                  },
                  reranking: {
                    type: 'object',
                    properties: {
                      enabled: { type: 'boolean' },
                      model: { type: 'string' },
                    },
                  },
                  filters: { type: 'object' },
                  model: { type: 'string' },
                  system_prompt: { type: 'string' },
                },
                required: ['query'],
              },
            },
          },
        },
      },
    },
    required: ['url'],
  };
}
```

---

## `src/tools/ai-search-query.ts` (NEW)

```ts
/**
 * AI Search Query Tool
 *
 * Enables querying the accumulated, conversation-scoped knowledge base without
 * requiring a new fetch.
 */

import type { AiSearchQueryOptions, AiSearchQueryResult, Config } from '../types.js';
import { getConfig } from '../config.js';
import { queryAiSearchScoped } from '../ai-search/index.js';

export interface AiSearchQueryToolInput {
  /**
   * The AI Search query options.
   *
   * Note: results are automatically scoped to the configured conversation/workspace.
   */
  query: AiSearchQueryOptions;

  /**
   * Optional stable conversation/thread identifier.
   * If provided, overrides WEB_FETCH_THREAD_KEY for this request.
   */
  thread_key?: string;

  /** Optional config override. */
  config?: Partial<Config>;
}

export interface AiSearchQueryToolOutput {
  success: boolean;
  result?: AiSearchQueryResult;
  error?: {
    code: string;
    message: string;
  };
}

export async function executeAiSearchQuery(input: AiSearchQueryToolInput): Promise<AiSearchQueryToolOutput> {
  try {
    const config = input.config ? { ...getConfig(), ...input.config } : getConfig();
    const result = await queryAiSearchScoped(input.query, config, { thread_key: input.thread_key });

    if (result.error) {
      return {
        success: false,
        result,
        error: result.error,
      };
    }

    return {
      success: true,
      result,
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'AI_SEARCH_QUERY_FAILED',
        message: err instanceof Error ? err.message : 'AI Search query failed',
      },
    };
  }
}

export function getAiSearchQueryInputSchema() {
  return {
    type: 'object',
    properties: {
      query: {
        type: 'object',
        description: 'AI Search query options (auto-scoped to the current conversation/workspace)',
        properties: {
          query: { type: 'string' },
          mode: { type: 'string', enum: ['search', 'ai_search'] },
          rewrite_query: { type: 'boolean' },
          max_num_results: { type: 'number' },
          ranking_options: {
            type: 'object',
            properties: {
              score_threshold: { type: 'number' },
            },
          },
          reranking: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              model: { type: 'string' },
            },
          },
          filters: { type: 'object' },
          model: { type: 'string' },
          system_prompt: { type: 'string' },
        },
        required: ['query'],
      },
      thread_key: {
        type: 'string',
        description: 'Stable conversation/thread identifier used for scoping (overrides WEB_FETCH_THREAD_KEY)',
      },
      config: {
        type: 'object',
        description: 'Optional per-call config overrides',
      },
    },
    required: ['query'],
  };
}
```

---

## One required wiring step (tool registration)

Wherever you register MCP tools (often something like `src/server.ts`, `src/index.ts`, or `src/mcp.ts`), add the new tool:

- **Name**: `ai_search_query`

- **Handler**: `executeAiSearchQuery`

- **Schema**: `getAiSearchQueryInputSchema()`


Example (adapt to your registry style):

```ts
import { executeAiSearchQuery, getAiSearchQueryInputSchema } from './tools/ai-search-query.js';

tools.register({
  name: 'ai_search_query',
  description: 'Query the conversation-scoped AI Search knowledge base',
  inputSchema: getAiSearchQueryInputSchema(),
  handler: executeAiSearchQuery,
});
```

---

## Minimal runtime config to get per-conversation KB

```bash
AI_SEARCH_ENABLED=true
AI_SEARCH_SCOPE=conversation
WEB_FETCH_THREAD_KEY="<stable-thread-id-from-your-host>"
AI_SEARCH_STATE_DIR="$HOME/.config/web-fetch-mcp"
```

That’s it: every `fetch(url)` now uploads under a **conversation-scoped prefix** and every query is **auto-filtered** to that prefix.
