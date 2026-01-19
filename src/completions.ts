import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ResourceStore } from './resources/store.js';
import type { LLMPacket } from './types.js';

const MAX_COMPLETION_VALUES = 100;
const RESOURCE_KINDS = new Set(['packet', 'content', 'normalized', 'screenshot']);
const RESOURCE_TEMPLATE_PATTERN = /^webfetch:\/\/([^/]+)\/\{([^}]+)\}$/;
const RESOURCE_URI_PATTERN = /^webfetch:\/\/([^/]+)\/([^/?#]+)$/;

const PROMPT_COMPLETIONS: Record<string, Record<string, string[]>> = {
    fetch_url: {
        url: ['https://', 'http://'],
        mode: ['auto', 'http', 'render'],
        extraction: [
            '{"prefer_readability": true}',
            '{"keep_tables": true}',
            '{"keep_code_blocks": true}',
        ],
    },
    fetch_and_chunk: {
        url: ['https://', 'http://'],
        max_tokens: ['1000', '2000', '4000'],
        strategy: ['headings_first', 'balanced'],
    },
    fetch_and_compact: {
        url: ['https://', 'http://'],
        max_tokens: ['500', '1000', '2000'],
        mode: ['structural', 'salience', 'map_reduce', 'question_focused'],
    },
    fetch_ai_search: {
        url: ['https://', 'http://'],
        mode: ['search', 'ai_search'],
        wait_ms: ['0', '500', '1000', '2000'],
    },
};

export type CompletionParams = {
    ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string };
    argument: { name: string; value: string };
    context?: { arguments?: Record<string, string> };
};

export type CompletionResult = {
    completion: {
        values: string[];
        total?: number;
        hasMore?: boolean;
    };
};

export type CompletionOptions = {
    prompts: Array<{ name: string }>;
    resourceStore: ResourceStore;
};

export function buildCompletionResult(
    params: CompletionParams,
    options: CompletionOptions
): CompletionResult {
    if (!params.ref || !params.argument) {
        throw new McpError(ErrorCode.InvalidParams, 'Missing completion parameters');
    }

    const argumentName = requireString(params.argument.name, 'argument.name');
    const argumentValue = requireString(params.argument.value, 'argument.value');

    if (params.ref.type === 'ref/prompt') {
        const promptName = requireString(params.ref.name, 'ref.name');
        const promptNames = new Set(options.prompts.map(prompt => prompt.name));
        if (!promptNames.has(promptName)) {
            throw new McpError(ErrorCode.InvalidParams, `Prompt ${promptName} not found`);
        }

        const candidates = PROMPT_COMPLETIONS[promptName]?.[argumentName] ?? [];
        return buildCompletion(candidates, argumentValue);
    }

    if (params.ref.type === 'ref/resource') {
        const uri = requireString(params.ref.uri, 'ref.uri');
        const parsed = parseResourceTemplate(uri);
        if (!parsed) {
            return buildCompletion([], argumentValue);
        }

        if (parsed.paramName !== argumentName) {
            return buildCompletion([], argumentValue);
        }

        const candidates = buildResourceCandidates(options.resourceStore, parsed.kind);
        return buildCompletion(candidates, argumentValue);
    }

    throw new McpError(ErrorCode.InvalidParams, 'Unsupported completion ref type');
}

function buildCompletion(values: string[], input: string): CompletionResult {
    const matches = rankAndFilter(values, input);
    const limited = matches.slice(0, MAX_COMPLETION_VALUES);
    const hasMore = matches.length > limited.length;
    return {
        completion: {
            values: limited,
            total: matches.length || undefined,
            hasMore: hasMore || undefined,
        },
    };
}

function rankAndFilter(values: string[], input: string): string[] {
    const needle = input.trim().toLowerCase();
    const unique = dedupe(values);

    if (!needle) {
        return unique;
    }

    return unique
        .map(value => {
            const lower = value.toLowerCase();
            const index = lower.indexOf(needle);
            if (index === -1) return null;
            return { value, index };
        })
        .filter((entry): entry is { value: string; index: number } => entry !== null)
        .sort((a, b) => {
            if (a.index !== b.index) return a.index - b.index;
            if (a.value.length !== b.value.length) return a.value.length - b.value.length;
            return a.value.localeCompare(b.value);
        })
        .map(entry => entry.value);
}

function dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function parseResourceTemplate(uri: string): { kind: string; paramName: string } | null {
    const templateMatch = uri.match(RESOURCE_TEMPLATE_PATTERN);
    if (templateMatch) {
        const kind = templateMatch[1];
        const paramName = templateMatch[2];
        if (!kind || !paramName) {
            return null;
        }
        if (RESOURCE_KINDS.has(kind)) {
            return { kind, paramName };
        }
        return null;
    }

    const uriMatch = uri.match(RESOURCE_URI_PATTERN);
    if (uriMatch) {
        const kind = uriMatch[1];
        if (!kind) {
            return null;
        }
        if (RESOURCE_KINDS.has(kind)) {
            return { kind, paramName: 'source_id' };
        }
    }

    return null;
}

function buildResourceCandidates(store: ResourceStore, kind: string): string[] {
    const entries = store.list();
    const candidates: string[] = [];
    for (const entry of entries) {
        if (kind === 'screenshot' && !hasScreenshot(entry.packet)) {
            continue;
        }
        candidates.push(entry.packet.source_id);
    }
    return candidates;
}

function hasScreenshot(packet: LLMPacket): boolean {
    return Boolean(packet.screenshot_base64 && packet.screenshot_base64.trim().length > 0);
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, `${label} must be a string`);
    }
    return value;
}
