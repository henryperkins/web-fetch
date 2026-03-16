import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecuteFetch = vi.fn();

vi.mock('../../src/tools/fetch.js', () => ({
  executeFetch: (...args: unknown[]) => mockExecuteFetch(...args),
}));

const { executeExtract } = await import('../../src/tools/extract.js');

describe('executeExtract', () => {
  beforeEach(() => {
    mockExecuteFetch.mockReset();
  });

  it('preserves normalized output when delegating URL extraction', async () => {
    mockExecuteFetch.mockResolvedValue({
      success: true,
      request_id: 'req-1',
      duration_ms: 5,
      retry_count: 0,
      normalized: {
        source_id: 'source-1',
      },
    });

    const result = await executeExtract({
      input: {
        url: 'https://example.com',
      },
      options: {
        format: {
          output: 'normalized',
        },
      },
    });

    expect(mockExecuteFetch).toHaveBeenCalledWith({
      options: expect.objectContaining({
        url: 'https://example.com',
        mode: 'http',
        format: {
          output: 'normalized',
        },
      }),
    });
    expect(result.success).toBe(true);
    expect(result.normalized).toEqual({
      source_id: 'source-1',
    });
  });

  it('preserves raw output when delegating raw byte extraction', async () => {
    mockExecuteFetch.mockResolvedValue({
      success: true,
      request_id: 'req-2',
      duration_ms: 1,
      retry_count: 0,
      raw: {
        bytes_length: 4,
        content_type: 'text/plain',
        headers: {
          'content-type': 'text/plain',
        },
      },
    });

    const result = await executeExtract({
      input: {
        raw_bytes: Buffer.from('test'),
        content_type: 'text/plain',
      },
      options: {
        format: {
          output: 'raw',
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.raw?.bytes_length).toBe(4);
    expect(result.packet).toBeUndefined();
  });
});
