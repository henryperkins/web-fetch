/**
 * Configuration management for web-fetch-mcp
 */

import type { Config } from './types.js';

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
  }

  return errors;
}
