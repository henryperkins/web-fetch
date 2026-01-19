import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

type CursorPayload = {
    offset: number;
};

export type PaginationResult<T> = {
    items: T[];
    nextCursor?: string;
};

export const DEFAULT_PAGE_SIZE = 50;

export function paginateResults<T>(
    items: T[],
    cursor: string | undefined,
    pageSize = DEFAULT_PAGE_SIZE
): PaginationResult<T> {
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
        throw new McpError(ErrorCode.InvalidParams, 'Page size must be a positive integer');
    }

    const offset = cursor ? decodeCursor(cursor) : 0;

    if (offset > items.length) {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
    }

    const end = Math.min(items.length, offset + pageSize);
    const page = items.slice(offset, end);

    if (end >= items.length) {
        return { items: page };
    }

    return {
        items: page,
        nextCursor: encodeCursor({ offset: end }),
    };
}

function decodeCursor(cursor: string): number {
    try {
        const decoded = Buffer.from(cursor, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded) as Partial<CursorPayload>;
        if (!Number.isInteger(parsed.offset) || (parsed.offset ?? 0) < 0) {
            throw new Error('invalid');
        }
        return parsed.offset ?? 0;
    } catch {
        throw new McpError(ErrorCode.InvalidParams, 'Invalid cursor');
    }
}

function encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
