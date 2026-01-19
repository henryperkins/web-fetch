/**
 * Resource handlers unit tests
 */

import { describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { LLMPacket } from '../../src/types.js';
import { ResourceStore } from '../../src/resources/store.js';
import { buildResourceUri } from '../../src/resources/uri.js';
import { listResources, listResourceTemplates, readResource } from '../../src/resources/handlers.js';
import { toNormalizedContent } from '../../src/processing/normalizer.js';

function createStore(): ResourceStore {
  return new ResourceStore({ defaultTtlMs: 1000, maxSize: 10 });
}

function createPacket(overrides: Partial<LLMPacket> = {}): LLMPacket {
  const metadata = { title: 'Example Title', ...(overrides.metadata ?? {}) };
  const hashes = { content_hash: 'content-hash', raw_hash: 'raw-hash', ...(overrides.hashes ?? {}) };

  return {
    source_id: 'source-1',
    original_url: 'https://example.com/article',
    canonical_url: 'https://example.com/article',
    retrieved_at: '2024-01-01T00:00:00Z',
    status: 200,
    content_type: 'text/html',
    outline: [],
    key_blocks: [],
    content: '# Example',
    source_summary: [],
    citations: [],
    unsafe_instructions_detected: [],
    warnings: [],
    ...overrides,
    metadata,
    hashes,
  };
}

describe('resources', () => {
  it('lists stored resources with metadata', () => {
    const store = createStore();
    const packet = createPacket();

    try {
      store.set({ packet });

      const result = listResources(store);

      expect(result.resources).toHaveLength(1);
      const resource = result.resources[0];

      expect(resource.uri).toBe(buildResourceUri('packet', packet.source_id));
      expect(resource.name).toBe(packet.source_id);
      expect(resource.title).toBe(packet.metadata.title);
      expect(resource.mimeType).toBe('application/json');
      expect(resource._meta?.size).toBe(Buffer.byteLength(packet.content, 'utf8'));
      expect(resource.description).toContain(packet.retrieved_at);
      expect(resource.annotations?.lastModified).toBe(packet.retrieved_at);
    } finally {
      store.destroy();
    }
  });

  it('reads packet, content, normalized, and screenshot resources', () => {
    const store = createStore();
    const screenshot = Buffer.from('png-bytes').toString('base64');
    const packet = createPacket({ screenshot_base64: screenshot });

    try {
      store.set({ packet });

      const packetUri = buildResourceUri('packet', packet.source_id);
      const packetResult = readResource(store, packetUri);
      const packetContent = packetResult.contents[0];
      if (!('text' in packetContent)) {
        throw new Error('expected text resource');
      }
      expect(JSON.parse(packetContent.text)).toEqual(packet);

      const contentUri = buildResourceUri('content', packet.source_id);
      const contentResult = readResource(store, contentUri);
      const contentBlock = contentResult.contents[0];
      if (!('text' in contentBlock)) {
        throw new Error('expected text resource');
      }
      expect(contentBlock.text).toBe(packet.content);

      const normalizedUri = buildResourceUri('normalized', packet.source_id);
      const normalizedResult = readResource(store, normalizedUri);
      const normalizedBlock = normalizedResult.contents[0];
      if (!('text' in normalizedBlock)) {
        throw new Error('expected text resource');
      }
      expect(JSON.parse(normalizedBlock.text)).toEqual(toNormalizedContent(packet));

      const screenshotUri = buildResourceUri('screenshot', packet.source_id);
      const screenshotResult = readResource(store, screenshotUri);
      const screenshotContent = screenshotResult.contents[0];
      if (!('blob' in screenshotContent)) {
        throw new Error('expected blob resource');
      }
      expect(screenshotContent.blob).toBe(screenshot);
    } finally {
      store.destroy();
    }
  });

  it('returns resource not found for invalid or missing resources', () => {
    const store = createStore();
    const missingUri = 'webfetch://packet/missing';

    try {
      readResource(store, missingUri);
      throw new Error('expected resource not found');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpError = err as McpError;
      expect(mcpError.code).toBe(-32002);
      expect((mcpError.data as { uri: string }).uri).toBe(missingUri);
    } finally {
      store.destroy();
    }

    const invalidStore = createStore();
    const invalidUri = 'https://example.com/resource';
    try {
      readResource(invalidStore, invalidUri);
      throw new Error('expected resource not found');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpError = err as McpError;
      expect(mcpError.code).toBe(-32002);
      expect((mcpError.data as { uri: string }).uri).toBe(invalidUri);
    } finally {
      invalidStore.destroy();
    }
  });

  it('lists resource templates', () => {
    const result = listResourceTemplates();
    const templates = result.resourceTemplates;

    expect(templates).toHaveLength(4);
    const uris = templates.map(template => template.uriTemplate);
    expect(uris).toContain('webfetch://packet/{source_id}');
    expect(uris).toContain('webfetch://content/{source_id}');
    expect(uris).toContain('webfetch://normalized/{source_id}');
    expect(uris).toContain('webfetch://screenshot/{source_id}');
  });
});
