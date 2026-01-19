import { describe, it, expect } from 'vitest';
import { normalizeContent } from '../../src/processing/normalizer.js';

describe('normalizeContent charset handling', () => {
  it('decodes Windows-1252 content without throwing', async () => {
    const html = '<html><head><title>Test</title></head><body>café</body></html>';
    const body = Buffer.from(html, 'latin1');

    const result = await normalizeContent(
      {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=windows-1252',
        },
        body,
        finalUrl: 'https://example.com',
        contentType: 'text/html; charset=windows-1252',
      },
      'https://example.com'
    );

    expect(result.success).toBe(true);
    expect(result.packet?.content).toContain('café');
  });
});
