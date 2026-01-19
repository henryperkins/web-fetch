/**
 * Completion unit tests
 */

import { describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { LLMPacket } from '../../src/types.js';
import { ResourceStore } from '../../src/resources/store.js';
import { buildCompletionResult } from '../../src/completions.js';

const PROMPTS = [
    { name: 'fetch_url' },
    { name: 'fetch_and_chunk' },
    { name: 'fetch_and_compact' },
    { name: 'fetch_ai_search' },
    { name: 'resources_tips' },
];

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
        metadata,
        outline: [],
        key_blocks: [],
        content: '# Example',
        source_summary: [],
        citations: [],
        unsafe_instructions_detected: [],
        warnings: [],
        hashes,
        ...overrides,
        metadata,
        hashes,
    };
}

describe('completion results', () => {
    it('suggests prompt argument values', () => {
        const store = createStore();

        try {
            const result = buildCompletionResult(
                {
                    ref: { type: 'ref/prompt', name: 'fetch_url' },
                    argument: { name: 'mode', value: 're' },
                },
                { prompts: PROMPTS, resourceStore: store }
            );

            expect(result.completion.values).toEqual(['render']);
        } finally {
            store.destroy();
        }
    });

    it('returns invalid params for unknown prompts', () => {
        const store = createStore();

        try {
            expect(() =>
                buildCompletionResult(
                    {
                        ref: { type: 'ref/prompt', name: 'missing_prompt' },
                        argument: { name: 'mode', value: '' },
                    },
                    { prompts: PROMPTS, resourceStore: store }
                )
            ).toThrowError(McpError);
        } finally {
            store.destroy();
        }
    });

    it('suggests resource source ids by kind', () => {
        const store = createStore();
        const packet = createPacket({ source_id: 'source-1' });
        const screenshotPacket = createPacket({
            source_id: 'screen-1',
            screenshot_base64: Buffer.from('png').toString('base64'),
        });

        try {
            store.set({ packet });
            store.set({ packet: screenshotPacket });

            const result = buildCompletionResult(
                {
                    ref: { type: 'ref/resource', uri: 'webfetch://screenshot/{source_id}' },
                    argument: { name: 'source_id', value: '' },
                },
                { prompts: PROMPTS, resourceStore: store }
            );

            expect(result.completion.values).toEqual(['screen-1']);
        } finally {
            store.destroy();
        }
    });
});
