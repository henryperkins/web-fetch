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
  const dir = config.aiSearchStateDir?.trim() || path.join(process.env['HOME'] || '', '.config', 'web-fetch-mcp');
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
