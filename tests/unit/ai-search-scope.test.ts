import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../src/types.js';
import { queryAiSearchScoped } from '../../src/ai-search/index.js';
import { resolveAiSearchScope, computeWorkspaceId } from '../../src/ai-search/state.js';

let tempDir = '/tmp/web-fetch-mcp-test';

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 30000,
    maxRedirects: 5,
    blockPrivateIp: true,
    allowlistDomains: [],
    rateLimitPerHost: 60,
    defaultMaxTokens: 4000,
    chunkMarginRatio: 0.1,
    respectRobots: true,
    playwrightEnabled: false,
    pdfEnabled: true,
    cacheTtlS: 300,
    renderBlockThirdParty: true,
    renderTimeoutMs: 60000,
    userAgent: 'test-agent',
    aiSearchEnabled: true,
    aiSearchScope: 'conversation',
    aiSearchThreadKey: undefined,
    aiSearchStateDir: tempDir,
    aiSearchRequireThreadKey: false,
    aiSearchWorkspaceRoot: undefined,
    aiSearchAccountId: undefined,
    aiSearchName: undefined,
    aiSearchApiToken: undefined,
    aiSearchR2AccessKeyId: undefined,
    aiSearchR2SecretAccessKey: undefined,
    aiSearchR2Bucket: undefined,
    aiSearchR2Endpoint: undefined,
    aiSearchR2Prefix: undefined,
    aiSearchMaxFileBytes: 4 * 1024 * 1024,
    aiSearchQueryTimeoutMs: 15000,
    aiSearchQueryWaitMs: 0,
    aiSearchMaxQueryWaitMs: 15000,
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetch-mcp-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('resolveAiSearchScope', () => {
  it('returns global scope without folder prefix', async () => {
    const config = createConfig({
      aiSearchScope: 'global',
      aiSearchR2Prefix: 'kb',
    });

    const result = await resolveAiSearchScope(config);

    expect(result.scope).toBe('global');
    expect(result.upload_prefix).toBe('kb/');
    expect(result.folder_scope_prefix).toBe('');
  });

  it('falls back to workspace when thread key is missing', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const config = createConfig({
      aiSearchScope: 'conversation',
      aiSearchRequireThreadKey: false,
      aiSearchThreadKey: undefined,
      aiSearchWorkspaceRoot: workspaceRoot,
      aiSearchR2Prefix: 'kb',
    });

    const result = await resolveAiSearchScope(config);
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const expectedPrefix = `kb/workspaces/${workspaceId}/`;

    expect(result.scope).toBe('workspace');
    expect(result.workspace_id).toBe(workspaceId);
    expect(result.upload_prefix).toBe(expectedPrefix);
    expect(result.folder_scope_prefix).toBe(expectedPrefix);
  });

  it('throws when thread key is required but missing', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const config = createConfig({
      aiSearchScope: 'conversation',
      aiSearchRequireThreadKey: true,
      aiSearchThreadKey: undefined,
      aiSearchWorkspaceRoot: workspaceRoot,
    });

    await expect(resolveAiSearchScope(config)).rejects.toMatchObject({
      code: 'AI_SEARCH_MISSING_THREAD_KEY',
    });
  });

  it('persists conversation id for the same thread key', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const config = createConfig({
      aiSearchScope: 'conversation',
      aiSearchRequireThreadKey: true,
      aiSearchThreadKey: 'thread-123',
      aiSearchWorkspaceRoot: workspaceRoot,
      aiSearchR2Prefix: 'kb',
    });

    const first = await resolveAiSearchScope(config);
    const second = await resolveAiSearchScope(config);
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const expectedPrefix = `kb/workspaces/${workspaceId}/conversations/${first.conversation_id}/`;

    expect(first.scope).toBe('conversation');
    expect(first.conversation_id).toBeDefined();
    expect(first.conversation_id).toBe(second.conversation_id);
    expect(first.upload_prefix).toBe(expectedPrefix);
    expect(second.upload_prefix).toBe(expectedPrefix);
  });
});

describe('queryAiSearchScoped scoping', () => {
  it('applies folder scope when no filters are present', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const config = createConfig({
      aiSearchScope: 'workspace',
      aiSearchWorkspaceRoot: workspaceRoot,
      aiSearchR2Prefix: 'kb',
    });
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const scopePrefix = `kb/workspaces/${workspaceId}/`;

    const result = await queryAiSearchScoped({ query: 'test' }, config);

    expect(result.error?.code).toBe('AI_SEARCH_NOT_CONFIGURED');
    expect(result.request.filters).toEqual({
      type: 'and',
      filters: [
        { type: 'gt', key: 'folder', value: scopePrefix },
        { type: 'lte', key: 'folder', value: `${scopePrefix}z` },
      ],
    });
  });

  it('treats empty filter objects as no filters', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const config = createConfig({
      aiSearchScope: 'workspace',
      aiSearchWorkspaceRoot: workspaceRoot,
      aiSearchR2Prefix: 'kb',
    });
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const scopePrefix = `kb/workspaces/${workspaceId}/`;

    const result = await queryAiSearchScoped({ query: 'test', filters: {} }, config);

    expect(result.error?.code).toBe('AI_SEARCH_NOT_CONFIGURED');
    expect(result.request.filters).toEqual({
      type: 'and',
      filters: [
        { type: 'gt', key: 'folder', value: scopePrefix },
        { type: 'lte', key: 'folder', value: `${scopePrefix}z` },
      ],
    });
  });

  it('nests OR filters under scope constraints', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    const config = createConfig({
      aiSearchScope: 'workspace',
      aiSearchWorkspaceRoot: workspaceRoot,
      aiSearchR2Prefix: 'kb',
    });
    const workspaceId = computeWorkspaceId(workspaceRoot);
    const scopePrefix = `kb/workspaces/${workspaceId}/`;

    const result = await queryAiSearchScoped(
      {
        query: 'test',
        filters: {
          type: 'or',
          filters: [
            { type: 'eq', key: 'tag', value: 'a' },
            { type: 'eq', key: 'tag', value: 'b' },
          ],
        },
      },
      config
    );

    expect(result.error?.code).toBe('AI_SEARCH_NOT_CONFIGURED');
    expect(result.request.filters).toEqual({
      type: 'and',
      filters: [
        {
          type: 'or',
          filters: [
            { type: 'eq', key: 'tag', value: 'a' },
            { type: 'eq', key: 'tag', value: 'b' },
          ],
        },
        { type: 'gt', key: 'folder', value: scopePrefix },
        { type: 'lte', key: 'folder', value: `${scopePrefix}z` },
      ],
    });
  });
});
