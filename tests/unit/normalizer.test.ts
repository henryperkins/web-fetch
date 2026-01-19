import { describe, it, expect } from 'vitest';
import { normalizeContent, detectContentType } from '../../src/processing/normalizer.js';

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

describe('detectContentType sniffing', () => {
  it('sniffs HTML when content-type is text/plain', () => {
    const html = '<!doctype html><html><head><title>Test</title></head><body><p>Hi</p></body></html>';
    const info = detectContentType('text/plain; charset=utf-8', Buffer.from(html));

    expect(info.type).toBe('html');
    expect(info.mimeType).toBe('text/html');
  });
});

describe('normalizeContent code fences', () => {
  it('treats tilde fences as code blocks', async () => {
    const text = [
      'Intro line.',
      '~~~',
      'code-ish line',
      '~~~',
      'After code.',
    ].join('\n');

    const result = await normalizeContent(
      {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
        body: Buffer.from(text, 'utf-8'),
        finalUrl: 'https://example.com/tilde',
        contentType: 'text/plain; charset=utf-8',
      },
      'https://example.com/tilde'
    );

    expect(result.success).toBe(true);
    const codeBlock = result.packet?.key_blocks.find(block => block.kind === 'code');
    expect(codeBlock?.text).toContain('code-ish line');
  });
});
