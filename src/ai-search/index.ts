/**
 * Cloudflare AI Search integration
 *
 * Uploads extracted markdown to R2 and optionally queries AI Search.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type {
  AiSearchMessage,
  AiSearchOptions,
  AiSearchQueryMode,
  AiSearchQueryOptions,
  Config,
  LLMPacket,
} from '../types.js';
export type {
  AiSearchMessage,
  AiSearchOptions,
  AiSearchQueryMode,
  AiSearchQueryOptions,
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
  skipped_quality?: boolean;
  warning?: string;
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

/**
 * Check if extracted markdown content is clean enough to be useful in a search index.
 * Rejects content with excessive raw JSON/HTML or low letter-to-symbol ratio.
 */
function isCleanContent(markdown: string): boolean {
  if (!markdown || markdown.trim().length === 0) return false;

  // Reject if content has too many serialized JSON patterns (raw page data leak)
  const jsonPatterns = (markdown.match(/"__typename"|"edges"|"node"|"pageInfo"/g) || []).length;
  if (jsonPatterns > 5) return false;

  // Reject if content has too many unprocessed HTML tags
  const htmlTags = (markdown.match(/<[a-z]+[^>]*>/gi) || []).length;
  if (htmlTags > 10) return false;

  // Reject if letter-to-symbol ratio is too low (noise content)
  const letters = (markdown.match(/[a-zA-Z]/g) || []).length;
  const total = markdown.length;
  if (total > 100 && letters / total < 0.4) return false;

  return true;
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

function truncateMetadataValue(value: string, maxLength: number = 500): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - 3).trimEnd() + '...';
}

function buildDefaultContext(packet: LLMPacket): string | undefined {
  const summary = packet.source_summary
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');

  const parts = [
    packet.metadata.title ? `Title: ${packet.metadata.title}` : undefined,
    `Source URL: ${packet.canonical_url}`,
    summary ? `Summary: ${summary}` : undefined,
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) {
    return undefined;
  }

  return truncateMetadataValue(parts.join('\n'));
}

const RESERVED_METADATA_NAMES = new Set(['timestamp', 'folder', 'filename']);

function buildUploadMetadata(packet: LLMPacket, options: AiSearchOptions): { metadata: Record<string, string> | undefined; warnings: string[] } {
  const metadata: Record<string, string> = {};
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(options.metadata ?? {})) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    if (RESERVED_METADATA_NAMES.has(normalizedKey)) {
      warnings.push(`Metadata key "${normalizedKey}" is reserved by AI Search and was skipped`);
      continue;
    }
    metadata[normalizedKey] = truncateMetadataValue(normalizedValue);
  }

  const context = options.context?.trim() || buildDefaultContext(packet);
  if (context) {
    metadata['context'] = truncateMetadataValue(context);
  }

  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    warnings,
  };
}

async function uploadObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  metadata?: Record<string, string>,
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
        Metadata: metadata,
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

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as { name?: string; message?: string };
  if (error.name === 'AbortError') return true;
  if (typeof error.message === 'string' && /aborted|abort/i.test(error.message)) {
    return true;
  }
  return false;
}

function clampWaitMs(waitMs: number, config: Config): number {
  if (waitMs <= 0) return 0;
  return Math.min(waitMs, config.aiSearchMaxQueryWaitMs);
}

type AiSearchFilterScalar = string | number | boolean | null;
type AiSearchRangeOperator = '$gt' | '$gte' | '$lt' | '$lte';
type AiSearchLowerBound = { op: '$gt' | '$gte'; value: string | number };
type AiSearchUpperBound = { op: '$lt' | '$lte'; value: string | number };
type AiSearchFieldFilterValue = AiSearchFilterScalar | Record<string, unknown>;
type AiSearchFilters = Record<string, AiSearchFieldFilterValue>;
type LegacyAiSearchFilter = {
  type: string;
  key?: string;
  value?: unknown;
  filters?: LegacyAiSearchFilter[];
};
type AiSearchFieldConstraints = {
  eq?: AiSearchFilterScalar;
  in?: AiSearchFilterScalar[];
  exclusions: AiSearchFilterScalar[];
  lower?: AiSearchLowerBound;
  upper?: AiSearchUpperBound;
};

const LEGACY_FILTER_OPERATOR_MAP = {
  eq: '$eq',
  ne: '$ne',
  in: '$in',
  nin: '$nin',
  lt: '$lt',
  lte: '$lte',
  gt: '$gt',
  gte: '$gte',
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAiSearchFilterScalar(value: unknown): value is AiSearchFilterScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function scalarEquals(left: AiSearchFilterScalar, right: AiSearchFilterScalar): boolean {
  return Object.is(left, right);
}

function dedupeScalars(values: AiSearchFilterScalar[]): AiSearchFilterScalar[] {
  const unique: AiSearchFilterScalar[] = [];
  for (const value of values) {
    if (!unique.some(entry => scalarEquals(entry, value))) {
      unique.push(value);
    }
  }
  return unique;
}

function compareRangeValues(left: string | number, right: string | number): number | null {
  if (typeof left !== typeof right) {
    return null;
  }
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stricterLowerBound(
  current: AiSearchLowerBound | undefined,
  next: AiSearchLowerBound | undefined
): AiSearchLowerBound | undefined {
  if (!current) return next;
  if (!next) return current;

  const comparison = compareRangeValues(current.value, next.value);
  if (comparison === null) {
    return current;
  }
  if (comparison > 0) return current;
  if (comparison < 0) return next;
  return current.op === '$gt' || next.op === '$gt'
    ? { op: '$gt', value: current.value }
    : current;
}

function stricterUpperBound(
  current: AiSearchUpperBound | undefined,
  next: AiSearchUpperBound | undefined
): AiSearchUpperBound | undefined {
  if (!current) return next;
  if (!next) return current;

  const comparison = compareRangeValues(current.value, next.value);
  if (comparison === null) {
    return current;
  }
  if (comparison < 0) return current;
  if (comparison > 0) return next;
  return current.op === '$lt' || next.op === '$lt'
    ? { op: '$lt', value: current.value }
    : current;
}

function boundsAreSatisfiable(
  lower: AiSearchLowerBound | undefined,
  upper: AiSearchUpperBound | undefined
): boolean {
  if (!lower || !upper) {
    return true;
  }

  const comparison = compareRangeValues(lower.value, upper.value);
  if (comparison === null) {
    return false;
  }
  if (comparison < 0) {
    return true;
  }
  if (comparison > 0) {
    return false;
  }
  return lower.op === '$gte' && upper.op === '$lte';
}

function valueMatchesBounds(
  value: AiSearchFilterScalar,
  lower: AiSearchLowerBound | undefined,
  upper: AiSearchUpperBound | undefined
): boolean {
  if (!lower && !upper) {
    return true;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return false;
  }

  if (lower) {
    const comparison = compareRangeValues(value, lower.value);
    if (comparison === null || comparison < 0 || (comparison === 0 && lower.op === '$gt')) {
      return false;
    }
  }

  if (upper) {
    const comparison = compareRangeValues(value, upper.value);
    if (comparison === null || comparison > 0 || (comparison === 0 && upper.op === '$lt')) {
      return false;
    }
  }

  return true;
}

function normalizeFieldConstraints(
  field: string,
  value: unknown
): { ok: true; constraints: AiSearchFieldConstraints } | { ok: false; error: { code: string; message: string } } {
  const constraints: AiSearchFieldConstraints = { exclusions: [] };

  if (isAiSearchFilterScalar(value)) {
    constraints.eq = value;
    return { ok: true, constraints };
  }

  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: `Invalid filter value for ${field}` },
    };
  }

  for (const [operator, rawValue] of Object.entries(value)) {
    switch (operator) {
      case '$eq':
      case '$ne':
        if (!isAiSearchFilterScalar(rawValue)) {
          return {
            ok: false,
            error: {
              code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
              message: `${operator} for ${field} must be a scalar value`,
            },
          };
        }
        if (operator === '$eq') {
          constraints.eq = rawValue;
        } else {
          constraints.exclusions.push(rawValue);
        }
        break;
      case '$in':
      case '$nin':
        if (!Array.isArray(rawValue) || !rawValue.every(isAiSearchFilterScalar)) {
          return {
            ok: false,
            error: {
              code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
              message: `${operator} for ${field} must be an array of scalar values`,
            },
          };
        }
        if (operator === '$in') {
          constraints.in = dedupeScalars(rawValue);
        } else {
          constraints.exclusions.push(...rawValue);
        }
        break;
      case '$gt':
      case '$gte':
        if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
          return {
            ok: false,
            error: {
              code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
              message: `${operator} for ${field} must be a string or number`,
            },
          };
        }
        if (constraints.lower && compareRangeValues(constraints.lower.value, rawValue) === null) {
          return {
            ok: false,
            error: {
              code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
              message: `Range filters for ${field} must use matching value types`,
            },
          };
        }
        constraints.lower = stricterLowerBound(constraints.lower, { op: operator, value: rawValue });
        break;
      case '$lt':
      case '$lte':
        if (typeof rawValue !== 'string' && typeof rawValue !== 'number') {
          return {
            ok: false,
            error: {
              code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
              message: `${operator} for ${field} must be a string or number`,
            },
          };
        }
        if (constraints.upper && compareRangeValues(constraints.upper.value, rawValue) === null) {
          return {
            ok: false,
            error: {
              code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
              message: `Range filters for ${field} must use matching value types`,
            },
          };
        }
        constraints.upper = stricterUpperBound(constraints.upper, { op: operator, value: rawValue });
        break;
      default:
        return {
          ok: false,
          error: {
            code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
            message: `Unsupported filter operator ${operator} for ${field}`,
          },
        };
    }
  }

  return { ok: true, constraints };
}

function serializeFieldConstraints(constraints: AiSearchFieldConstraints): AiSearchFieldFilterValue | undefined {
  if (constraints.eq !== undefined) {
    return constraints.eq;
  }

  if (constraints.in && constraints.in.length > 0) {
    return constraints.in.length === 1 ? constraints.in[0] : { $in: constraints.in };
  }

  const operators: Record<string, unknown> = {};
  if (constraints.lower) {
    operators[constraints.lower.op] = constraints.lower.value;
  }
  if (constraints.upper) {
    operators[constraints.upper.op] = constraints.upper.value;
  }

  const exclusions = dedupeScalars(constraints.exclusions);
  if (exclusions.length === 1) {
    operators['$ne'] = exclusions[0];
  } else if (exclusions.length > 1) {
    operators['$nin'] = exclusions;
  }

  return Object.keys(operators).length > 0 ? operators : undefined;
}

function mergeFieldConstraints(
  field: string,
  left: AiSearchFieldConstraints,
  right: AiSearchFieldConstraints
): { ok: true; constraints: AiSearchFieldConstraints } | { ok: false; error: { code: string; message: string } } {
  const lower = stricterLowerBound(left.lower, right.lower);
  const upper = stricterUpperBound(left.upper, right.upper);
  if (!boundsAreSatisfiable(lower, upper)) {
    return {
      ok: false,
      error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: `Conflicting range filters for ${field}` },
    };
  }

  let candidates: AiSearchFilterScalar[] | undefined;
  if (left.eq !== undefined) {
    candidates = [left.eq];
  }
  if (right.eq !== undefined) {
    const values = candidates ?? [right.eq];
    candidates = values.filter(value => scalarEquals(value, right.eq!));
  }
  if (left.in) {
    candidates = (candidates ?? left.in).filter(candidate => left.in!.some(value => scalarEquals(value, candidate)));
  }
  if (right.in) {
    candidates = (candidates ?? right.in).filter(candidate => right.in!.some(value => scalarEquals(value, candidate)));
  }

  const exclusions = dedupeScalars([...left.exclusions, ...right.exclusions]);

  if (candidates) {
    let filtered = dedupeScalars(candidates)
      .filter(candidate => valueMatchesBounds(candidate, lower, upper))
      .filter(candidate => !exclusions.some(excluded => scalarEquals(excluded, candidate)));

    filtered = dedupeScalars(filtered);
    if (filtered.length === 0) {
      return {
        ok: false,
        error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: `Conflicting filters for ${field}` },
      };
    }

    return filtered.length === 1
      ? { ok: true, constraints: { eq: filtered[0], exclusions: [] } }
      : { ok: true, constraints: { in: filtered, exclusions: [] } };
  }

  const exclusionsInsideRange = exclusions.filter(excluded => valueMatchesBounds(excluded, lower, upper));
  if (exclusionsInsideRange.length > 0 && (lower || upper)) {
    return {
      ok: false,
      error: {
        code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
        message: `Cannot combine exclusion filters with scoped range filters for ${field}`,
      },
    };
  }

  return {
    ok: true,
    constraints: {
      exclusions: exclusions.filter(excluded => !valueMatchesBounds(excluded, lower, upper)),
      lower,
      upper,
    },
  };
}

function normalizeFieldFilterValue(
  field: string,
  value: unknown
): { ok: true; value?: AiSearchFieldFilterValue } | { ok: false; error: { code: string; message: string } } {
  const normalized = normalizeFieldConstraints(field, value);
  if (!normalized.ok) {
    return normalized;
  }

  const merged = mergeFieldConstraints(field, { exclusions: [] }, normalized.constraints);
  if (!merged.ok) {
    return merged;
  }

  const serialized = serializeFieldConstraints(merged.constraints);
  return { ok: true, value: serialized };
}

function mergeFieldFilters(
  field: string,
  left: unknown,
  right: unknown
): { ok: true; value?: AiSearchFieldFilterValue } | { ok: false; error: { code: string; message: string } } {
  const leftConstraints = normalizeFieldConstraints(field, left);
  if (!leftConstraints.ok) {
    return leftConstraints;
  }

  const rightConstraints = normalizeFieldConstraints(field, right);
  if (!rightConstraints.ok) {
    return rightConstraints;
  }

  const merged = mergeFieldConstraints(field, leftConstraints.constraints, rightConstraints.constraints);
  if (!merged.ok) {
    return merged;
  }

  return { ok: true, value: serializeFieldConstraints(merged.constraints) };
}

function translateLegacyFilterTree(
  filter: LegacyAiSearchFilter
): { ok: true; filters: AiSearchFilters } | { ok: false; error: { code: string; message: string } } {
  if (filter.type === 'and') {
    if (!Array.isArray(filter.filters)) {
      return {
        ok: false,
        error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: 'Legacy AND filters must contain a filters array' },
      };
    }

    const merged: AiSearchFilters = {};
    for (const child of filter.filters) {
      const translated = translateLegacyFilterTree(child);
      if (!translated.ok) {
        return translated;
      }

      for (const [field, value] of Object.entries(translated.filters)) {
        if (merged[field] === undefined) {
          merged[field] = value;
          continue;
        }

        const next = mergeFieldFilters(field, merged[field], value);
        if (!next.ok) {
          return next;
        }

        if (next.value === undefined) {
          delete merged[field];
        } else {
          merged[field] = next.value;
        }
      }
    }

    return { ok: true, filters: merged };
  }

  if (filter.type === 'or') {
    return {
      ok: false,
      error: {
        code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
        message: 'OR filters are not supported by the AI Search REST API. Use $in for same-field alternatives (e.g., { folder: { $in: ["a/", "b/"] } }), or make separate queries and merge results.',
      },
    };
  }

  const operator = LEGACY_FILTER_OPERATOR_MAP[filter.type as keyof typeof LEGACY_FILTER_OPERATOR_MAP];
  if (!operator || typeof filter.key !== 'string' || !filter.key.trim()) {
    return {
      ok: false,
      error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: 'Unsupported legacy filter shape' },
    };
  }

  const field = filter.key.trim();
  let value: AiSearchFieldFilterValue;
  if (operator === '$eq') {
    if (!isAiSearchFilterScalar(filter.value)) {
      return {
        ok: false,
        error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: `Legacy filter for ${field} must use a scalar value` },
      };
    }
    value = filter.value;
  } else if (operator === '$in' || operator === '$nin') {
    if (!Array.isArray(filter.value) || !filter.value.every(isAiSearchFilterScalar)) {
      return {
        ok: false,
        error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: `Legacy ${filter.type} filter for ${field} must use a scalar array` },
      };
    }
    value = { [operator]: filter.value };
  } else {
    if (typeof filter.value !== 'string' && typeof filter.value !== 'number') {
      return {
        ok: false,
        error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: `Legacy ${filter.type} filter for ${field} must use a string or number` },
      };
    }
    value = { [operator]: filter.value };
  }

  return { ok: true, filters: { [field]: value } };
}

function normalizeFilters(
  filters: unknown
): { ok: true; filters: AiSearchFilters } | { ok: false; error: { code: string; message: string } } {
  if (filters === undefined || filters === null) {
    return { ok: true, filters: {} };
  }

  if (!isPlainObject(filters)) {
    return {
      ok: false,
      error: { code: 'AI_SEARCH_UNSUPPORTED_FILTERS', message: 'filters must be an object' },
    };
  }

  if (typeof filters['type'] === 'string') {
    return translateLegacyFilterTree(filters as LegacyAiSearchFilter);
  }

  const normalized: AiSearchFilters = {};
  for (const [field, value] of Object.entries(filters)) {
    if (!field || field.startsWith('$')) {
      return {
        ok: false,
        error: {
          code: 'AI_SEARCH_UNSUPPORTED_FILTERS',
          message: 'Top-level logical operators (e.g., $or) are not supported by the AI Search REST API. Use $in for same-field alternatives, or make separate queries and merge results.',
        },
      };
    }

    const normalizedField = normalizeFieldFilterValue(field, value);
    if (!normalizedField.ok) {
      return normalizedField;
    }
    if (normalizedField.value !== undefined) {
      normalized[field] = normalizedField.value;
    }
  }

  return { ok: true, filters: normalized };
}

function buildFolderStartsWithFilter(folderPrefix: string): AiSearchFilters {
  const prefix = normalizePrefix(folderPrefix);
  if (!prefix) {
    return {};
  }

  return {
    folder: {
      $gte: prefix,
      $lt: `${prefix}0`,
    },
  };
}

function mergeFiltersWithScope(
  existing: unknown,
  folderScopePrefix: string
): { ok: true; filters: AiSearchFilters } | { ok: false; error: { code: string; message: string } } {
  const normalized = normalizeFilters(existing);
  if (!normalized.ok) {
    return normalized;
  }

  const scopeFilters = buildFolderStartsWithFilter(folderScopePrefix);
  if (Object.keys(scopeFilters).length === 0) {
    return normalized;
  }

  const merged: AiSearchFilters = { ...normalized.filters };
  for (const [field, value] of Object.entries(scopeFilters)) {
    if (merged[field] === undefined) {
      merged[field] = value;
      continue;
    }

    const next = mergeFieldFilters(field, merged[field], value);
    if (!next.ok) {
      return next;
    }

    if (next.value === undefined) {
      delete merged[field];
    } else {
      merged[field] = next.value;
    }
  }

  return { ok: true, filters: merged };
}

function getQueryFilters(query: AiSearchQueryOptions): unknown {
  return query.ai_search_options?.retrieval?.filters ?? query.filters;
}

function setQueryFilters(query: AiSearchQueryOptions, filters: AiSearchFilters): AiSearchQueryOptions {
  const retrieval = { ...(query.ai_search_options?.retrieval ?? {}) };
  if (Object.keys(filters).length > 0) {
    retrieval.filters = filters;
  } else {
    delete retrieval.filters;
  }

  const aiSearchOptions = { ...(query.ai_search_options ?? {}) };
  if (Object.keys(retrieval).length > 0) {
    aiSearchOptions.retrieval = retrieval;
  } else {
    delete aiSearchOptions.retrieval;
  }

  return {
    ...query,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    ai_search_options: Object.keys(aiSearchOptions).length > 0 ? aiSearchOptions : undefined,
  };
}

function buildMessages(options: AiSearchQueryOptions): AiSearchMessage[] {
  const messages: AiSearchMessage[] = [];

  const systemPrompt = options.system_prompt?.trim();
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  for (const message of options.messages ?? []) {
    const content = message.content?.trim();
    if (!content) {
      continue;
    }
    messages.push({ role: message.role, content });
  }

  const query = options.query?.trim();
  if (query) {
    messages.push({ role: 'user', content: query });
  }

  return messages;
}

function buildAiSearchRequestOverrides(options: AiSearchQueryOptions): Record<string, unknown> | undefined {
  const retrieval: Record<string, unknown> = {};
  const filters = options.ai_search_options?.retrieval?.filters ?? options.filters;
  const maxNumResults = options.ai_search_options?.retrieval?.max_num_results ?? options.max_num_results;
  const retrievalType = options.ai_search_options?.retrieval?.retrieval_type ?? options.retrieval_type;
  const matchThreshold = options.ai_search_options?.retrieval?.match_threshold
    ?? options.match_threshold
    ?? options.ranking_options?.score_threshold;

  if (filters !== undefined) {
    retrieval['filters'] = filters;
  }
  if (maxNumResults !== undefined) {
    retrieval['max_num_results'] = maxNumResults;
  }
  if (retrievalType !== undefined) {
    retrieval['retrieval_type'] = retrievalType;
  }
  if (matchThreshold !== undefined) {
    retrieval['match_threshold'] = matchThreshold;
  }

  const aiSearchOptions: Record<string, unknown> = {};
  if (Object.keys(retrieval).length > 0) {
    aiSearchOptions['retrieval'] = retrieval;
  }

  const cacheEnabled = options.ai_search_options?.cache?.enabled ?? options.cache?.enabled;
  if (cacheEnabled !== undefined) {
    aiSearchOptions['cache'] = { enabled: cacheEnabled };
  }

  const rerankingEnabled = options.ai_search_options?.reranking?.enabled ?? options.reranking?.enabled;
  const rerankingModel = options.reranking?.model;
  if (rerankingEnabled !== undefined || rerankingModel) {
    const reranking: Record<string, unknown> = {};
    if (rerankingEnabled !== undefined) {
      reranking['enabled'] = rerankingEnabled;
    }
    if (rerankingModel) {
      reranking['model'] = rerankingModel;
    }
    aiSearchOptions['reranking'] = reranking;
  }

  return Object.keys(aiSearchOptions).length > 0 ? aiSearchOptions : undefined;
}

function buildQueryRequest(options: AiSearchQueryOptions): Record<string, unknown> {
  const mode = options.mode ?? 'search';
  const request: Record<string, unknown> = {
    messages: buildMessages(options),
  };

  if (mode === 'ai_search' && options.stream !== undefined) {
    request['stream'] = options.stream;
  }

  const aiSearchOptions = buildAiSearchRequestOverrides(options);
  if (aiSearchOptions) {
    request['ai_search_options'] = aiSearchOptions;
  }

  if (mode === 'ai_search' && options.model) {
    request['model'] = options.model;
  }

  return request;
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class SseParser {
  private buffer = '';
  private events: Array<{ event: string; data: unknown }> = [];
  private deltaParts: string[] = [];
  private chunks: unknown;
  private done = false;

  feed(chunk: string): void {
    this.buffer += chunk;

    // Process all complete blocks (separated by double newlines)
    const parts = this.buffer.split(/\n\n/);
    // Last element may be incomplete — keep it in the buffer
    this.buffer = parts.pop() ?? '';

    for (const block of parts) {
      this.processBlock(block);
    }
  }

  private processBlock(block: string): void {
    const trimmed = block.trim();
    if (!trimmed) {
      return;
    }

    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    const dataText = dataLines.join('\n');
    if (!dataText) {
      return;
    }

    if (dataText === '[DONE]') {
      this.done = true;
      this.events.push({ event: eventName, data: '[DONE]' });
      return;
    }

    const parsed = parseResponseBody(dataText);
    if (eventName === 'chunks') {
      this.chunks = parsed;
    }

    if (isPlainObject(parsed)) {
      const choices = parsed['choices'];
      if (Array.isArray(choices)) {
        for (const choice of choices) {
          if (!isPlainObject(choice)) {
            continue;
          }
          const delta = choice['delta'];
          if (!isPlainObject(delta)) {
            continue;
          }
          const content = delta['content'];
          if (typeof content === 'string') {
            this.deltaParts.push(content);
          }
        }
      }
    }

    this.events.push({ event: eventName, data: parsed });
  }

  /** Flush any remaining buffer content and return the assembled result. */
  getResult(): Record<string, unknown> {
    // Process any remaining content in the buffer
    if (this.buffer.trim()) {
      this.processBlock(this.buffer);
      this.buffer = '';
    }

    return {
      type: 'sse',
      chunks: this.chunks,
      events: this.events,
      text: this.deltaParts.join(''),
      done: this.done,
    };
  }
}

function parseSseResponse(text: string): Record<string, unknown> {
  const parser = new SseParser();
  parser.feed(text);
  return parser.getResult();
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
  const endpoint = mode === 'ai_search' ? 'chat/completions' : 'search';
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.aiSearchAccountId}/ai-search/instances/${encodeURIComponent(config.aiSearchName)}/${endpoint}`;
  const requestBody = buildQueryRequest(options);
  const messages = requestBody['messages'];

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      mode,
      request: requestBody,
      error: {
        code: 'AI_SEARCH_INVALID_REQUEST',
        message: 'Provide query or messages when calling AI Search',
      },
    };
  }

  const streamEnabled = mode === 'ai_search' && requestBody['stream'] === true;
  const timeouts = mode === 'ai_search' || streamEnabled
    ? [config.aiSearchQueryTimeoutMs, config.aiSearchQueryTimeoutMs * 2]
    : [config.aiSearchQueryTimeoutMs];
  let lastError: { code: string; message: string } | undefined;

  for (let attempt = 0; attempt < timeouts.length; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeouts[attempt]);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.aiSearchApiToken}`,
          'Content-Type': 'application/json',
          'Accept': streamEnabled ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const status = response.status;
      let parsed: unknown;
      if (streamEnabled && response.body) {
        const parser = new SseParser();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parsed = parser.getResult();
      } else {
        const text = await response.text();
        parsed = streamEnabled ? parseSseResponse(text) : parseResponseBody(text);
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
      const timeoutError = isAbortError(err);
      const message = timeoutError
        ? 'AI Search query timed out'
        : err instanceof Error
          ? err.message
          : 'AI Search query failed';
      lastError = { code: 'AI_SEARCH_QUERY_FAILED', message };

      if (timeoutError && attempt < timeouts.length - 1) {
        continue;
      }

      return {
        mode,
        request: requestBody,
        error: lastError,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    mode,
    request: requestBody,
    error: lastError ?? {
      code: 'AI_SEARCH_QUERY_FAILED',
      message: 'AI Search query failed',
    },
  };
}

function applyScopeToQueryOptions(
  query: AiSearchQueryOptions,
  folderScopePrefix: string
): { ok: true; query: AiSearchQueryOptions } | { ok: false; error: { code: string; message: string } } {
  const merged = mergeFiltersWithScope(getQueryFilters(query), folderScopePrefix);
  if (!merged.ok) {
    return merged;
  }

  return { ok: true, query: setQueryFilters(query, merged.filters) };
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

  // Quality gate: skip upload if content is too noisy for useful indexing
  if (!isCleanContent(packet.content)) {
    return {
      enabled: true,
      uploaded: false,
      skipped_quality: true,
      bucket: config.aiSearchR2Bucket,
      prefix: keyPrefix,
      keys: [],
      bytes: 0,
      parts: 0,
      warning: 'AI Search upload skipped: content quality too low for indexing',
    };
  }

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
  const { metadata: uploadMetadata, warnings: metadataWarnings } = buildUploadMetadata(packet, options);

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
            request: buildQueryRequest(options.query!),
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
      await uploadObject(client, config.aiSearchR2Bucket, keys[i]!, body, uploadMetadata);
    }

    const waitMs = clampWaitMs(options.wait_ms ?? config.aiSearchQueryWaitMs, config);
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const query = scopedQueryError
      ? {
          mode: options.query?.mode ?? 'search',
          request: buildQueryRequest(options.query!),
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
      warning: metadataWarnings.length > 0 ? metadataWarnings.join('; ') : undefined,
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
