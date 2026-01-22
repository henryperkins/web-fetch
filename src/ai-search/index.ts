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
  // folder > prefix AND folder <= prefix + 'z'
  // (Example: gt 'customer-a/' and lte 'customer-a/z' for prefix 'customer-a/')
  return [
    { type: 'gt', key: 'folder', value: p },
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
  if (Object.keys(ex).length === 0) {
    return {
      ok: true,
      filters: { type: 'and', filters: scopeComparisons } as unknown as Record<string, unknown>,
    };
  }

  if (ex.type === 'and' && Array.isArray(ex.filters)) {
    return {
      ok: true,
      filters: { ...ex, filters: [...ex.filters, ...scopeComparisons] } as unknown as Record<string, unknown>,
    };
  }

  if (ex.type === 'or' && Array.isArray(ex.filters)) {
    return {
      ok: true,
      filters: { type: 'and', filters: [ex, ...scopeComparisons] } as unknown as Record<string, unknown>,
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
