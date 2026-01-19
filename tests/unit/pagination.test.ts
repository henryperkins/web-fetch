/**
 * Pagination unit tests
 */

import { describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { paginateResults } from '../../src/pagination.js';

describe('paginateResults', () => {
    it('paginates results with a cursor', () => {
        const items = ['a', 'b', 'c', 'd'];

        const first = paginateResults(items, undefined, 2);
        expect(first.items).toEqual(['a', 'b']);
        expect(first.nextCursor).toBeTruthy();

        const second = paginateResults(items, first.nextCursor, 2);
        expect(second.items).toEqual(['c', 'd']);
        expect(second.nextCursor).toBeUndefined();
    });

    it('returns empty for exact end cursor', () => {
        const items = ['a', 'b'];

        const first = paginateResults(items, undefined, 2);
        expect(first.items).toEqual(['a', 'b']);
        expect(first.nextCursor).toBeUndefined();
    });

    it('rejects invalid cursor', () => {
        try {
            paginateResults(['a'], 'not-base64', 1);
            throw new Error('expected invalid params');
        } catch (err) {
            expect(err).toBeInstanceOf(McpError);
            const mcpError = err as McpError;
            expect(mcpError.code).toBe(-32602);
        }
    });

    it('rejects cursor beyond range', () => {
        const cursor = Buffer.from(JSON.stringify({ offset: 10 }), 'utf8').toString('base64');
        try {
            paginateResults(['a', 'b'], cursor, 1);
            throw new Error('expected invalid params');
        } catch (err) {
            expect(err).toBeInstanceOf(McpError);
            const mcpError = err as McpError;
            expect(mcpError.code).toBe(-32602);
        }
    });
});
