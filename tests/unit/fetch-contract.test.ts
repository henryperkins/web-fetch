import { describe, expect, it } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { parseFetchToolArguments } from '../../src/tools/fetch-contract.js';

describe('parseFetchToolArguments', () => {
  it('parses the canonical top-level source fields', () => {
    const result = parseFetchToolArguments({
      url: 'https://example.com',
      options: {
        mode: 'auto',
      },
    });

    expect(result.options?.url).toBe('https://example.com');
    expect(result.options?.mode).toBe('auto');
  });

  it('accepts the deprecated nested source fields for compatibility', () => {
    const rawBytes = Buffer.from('hello world').toString('base64');

    const result = parseFetchToolArguments({
      options: {
        raw_bytes: rawBytes,
        content_type: 'text/plain',
      },
    });

    expect(result.options?.raw_bytes?.toString('utf8')).toBe('hello world');
    expect(result.options?.content_type).toBe('text/plain');
  });

  it('rejects conflicting duplicated fields', () => {
    expect(() =>
      parseFetchToolArguments({
        url: 'https://example.com',
        options: {
          url: 'https://other.example.com',
        },
      })
    ).toThrowError(McpError);
  });

  it('requires exactly one source input', () => {
    expect(() => parseFetchToolArguments({ options: {} })).toThrowError(McpError);
    expect(() =>
      parseFetchToolArguments({
        url: 'https://example.com',
        raw_bytes: Buffer.from('x').toString('base64'),
      })
    ).toThrowError(McpError);
  });
});
