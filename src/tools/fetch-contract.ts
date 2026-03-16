import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FetchOptions } from '../types.js';
import type { FetchToolInput } from './fetch.js';

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpError(ErrorCode.InvalidParams, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, label);
}

function normalizeOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, `${label} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function resolveStringField(
  topLevel: unknown,
  legacy: unknown,
  label: string
): string | undefined {
  const top = normalizeOptionalString(topLevel, label);
  const nested = normalizeOptionalString(legacy, `options.${label}`);

  if (top !== undefined && nested !== undefined && top !== nested) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Conflicting values provided for ${label} and options.${label}`
    );
  }

  return top ?? nested;
}

function decodeBase64(value: unknown, label: string): { encoded: string; decoded: Buffer } | undefined {
  const encoded = normalizeOptionalString(value, label);
  if (encoded === undefined) {
    return undefined;
  }
  return {
    encoded,
    decoded: Buffer.from(encoded, 'base64'),
  };
}

function resolveRawBytes(
  topLevel: unknown,
  legacy: unknown
): Buffer | undefined {
  const top = decodeBase64(topLevel, 'raw_bytes');
  const nested = decodeBase64(legacy, 'options.raw_bytes');

  if (top && nested && top.encoded !== nested.encoded) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Conflicting values provided for raw_bytes and options.raw_bytes'
    );
  }

  return top?.decoded ?? nested?.decoded;
}

export function parseFetchToolArguments(args: unknown): FetchToolInput {
  const argsObject = requireRecord(args, 'arguments');
  const optionsRecord = optionalRecord(argsObject['options'], 'options') ?? {};
  const {
    url: legacyUrl,
    raw_bytes: legacyRawBytes,
    content_type: legacyContentType,
    canonical_url: legacyCanonicalUrl,
    ...behaviorOptions
  } = optionsRecord;

  const url = resolveStringField(argsObject['url'], legacyUrl, 'url');
  const rawBytes = resolveRawBytes(argsObject['raw_bytes'], legacyRawBytes);
  const contentType = resolveStringField(argsObject['content_type'], legacyContentType, 'content_type');
  const canonicalUrl = resolveStringField(argsObject['canonical_url'], legacyCanonicalUrl, 'canonical_url');

  if ((url && rawBytes) || (!url && !rawBytes)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Provide exactly one of url or raw_bytes'
    );
  }

  return {
    options: {
      ...(behaviorOptions as FetchOptions),
      url,
      raw_bytes: rawBytes,
      content_type: contentType,
      canonical_url: canonicalUrl,
    },
  };
}
