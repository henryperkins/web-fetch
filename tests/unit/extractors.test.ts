/**
 * Extractors Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { extractHtml, extractHeadings } from '../../src/extractors/html-extractor.js';
import { extractMarkdown, extractFrontmatter, extractMarkdownHeadings } from '../../src/extractors/markdown-extractor.js';
import { extractJson } from '../../src/extractors/json-extractor.js';
import { extractXml } from '../../src/extractors/xml-extractor.js';
import { extractText } from '../../src/extractors/text-extractor.js';

describe('HTML Extractor', () => {
  describe('extractHtml', () => {
    it('should extract content from simple HTML', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head><title>Test Page</title></head>
        <body>
          <article>
            <h1>Hello World</h1>
            <p>This is a test paragraph.</p>
          </article>
        </body>
        </html>
      `;

      const result = extractHtml(html, 'https://example.com');

      expect(result.success).toBe(true);
      expect(result.markdown).toContain('Hello World');
      expect(result.markdown).toContain('test paragraph');
    });

    it('should preserve code blocks', () => {
      const html = `
        <article>
          <h1>Code Example</h1>
          <pre><code class="language-javascript">function hello() {
  return 'world';
}</code></pre>
        </article>
      `;

      const result = extractHtml(html, 'https://example.com', { keep_code_blocks: true });

      expect(result.success).toBe(true);
      expect(result.markdown).toContain('```');
      expect(result.markdown).toContain('function hello');
    });

    it('should remove scripts and styles', () => {
      const html = `
        <html>
        <head>
          <style>body { color: red; }</style>
          <script>alert('xss');</script>
        </head>
        <body>
          <p>Safe content</p>
          <script>console.log('bad');</script>
        </body>
        </html>
      `;

      const result = extractHtml(html, 'https://example.com');

      expect(result.success).toBe(true);
      expect(result.markdown).not.toContain('alert');
      expect(result.markdown).not.toContain('console.log');
      expect(result.markdown).not.toContain('color: red');
      expect(result.markdown).toContain('Safe content');
    });

    it('should detect paywalled content', () => {
      const html = `
        <html>
        <body>
          <div class="paywall">
            <h2>Subscribe to continue reading</h2>
          </div>
          <p>Preview content...</p>
        </body>
        </html>
      `;

      const result = extractHtml(html, 'https://example.com');

      expect(result.isPaywalled).toBe(true);
      expect(result.warnings).toContain('Content appears to be paywalled');
    });

    it('should remove custom selectors', () => {
      const html = `
        <article>
          <h1>Article Title</h1>
          <div class="advertisement">Buy stuff!</div>
          <p>Article content here.</p>
        </article>
      `;

      const result = extractHtml(html, 'https://example.com', {
        remove_selectors: ['.advertisement'],
      });

      expect(result.success).toBe(true);
      expect(result.markdown).not.toContain('Buy stuff');
      expect(result.markdown).toContain('Article content');
    });
  });

  describe('extractHeadings', () => {
    it('should extract all heading levels', () => {
      const html = `
        <h1>Main Title</h1>
        <h2>Section 1</h2>
        <h3>Subsection 1.1</h3>
        <h2>Section 2</h2>
      `;

      const headings = extractHeadings(html);

      expect(headings.length).toBe(4);
      expect(headings[0]).toEqual({ level: 1, text: 'Main Title' });
      expect(headings[2]).toEqual({ level: 3, text: 'Subsection 1.1' });
    });
  });
});

describe('Markdown Extractor', () => {
  describe('extractFrontmatter', () => {
    it('should parse YAML frontmatter', () => {
      const content = `---
title: My Article
author: John Doe
date: 2024-01-15
---

# Introduction

Content here.`;

      const { frontmatter, body } = extractFrontmatter(content);

      expect(frontmatter).not.toBeNull();
      expect(frontmatter?.title).toBe('My Article');
      expect(frontmatter?.author).toBe('John Doe');
      expect(body).toContain('# Introduction');
    });

    it('should handle content without frontmatter', () => {
      const content = `# Just Content

No frontmatter here.`;

      const { frontmatter, body } = extractFrontmatter(content);

      expect(frontmatter).toBeNull();
      expect(body).toBe(content);
    });
  });

  describe('extractMarkdown', () => {
    it('should sanitize embedded HTML', () => {
      const content = `# Article

<script>alert('xss')</script>

Normal paragraph.

<iframe src="evil.com"></iframe>`;

      const result = extractMarkdown(content);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.markdown).not.toContain('<script>');
      expect(result.markdown).toContain('Normal paragraph');
    });

    it('should extract title from frontmatter or heading', () => {
      const content = `---
title: Frontmatter Title
---

# Heading Title

Content.`;

      const result = extractMarkdown(content);

      expect(result.content?.title).toBe('Frontmatter Title');
    });
  });

  describe('extractMarkdownHeadings', () => {
    it('should extract ATX-style headings', () => {
      const content = `# H1
## H2
### H3
Text
## Another H2`;

      const headings = extractMarkdownHeadings(content);

      expect(headings.length).toBe(4);
      expect(headings[0]).toEqual({ level: 1, text: 'H1' });
    });

    it('should ignore headings inside code fences', () => {
      const content = `# Title

\`\`\`bash
# not a heading
\`\`\`

## Real Heading`;

      const headings = extractMarkdownHeadings(content);

      expect(headings).toEqual([
        { level: 1, text: 'Title' },
        { level: 2, text: 'Real Heading' },
      ]);
    });
  });
});

describe('JSON Extractor', () => {
  describe('extractJson', () => {
    it('should summarize JSON structure', () => {
      const json = JSON.stringify({
        name: 'Test',
        count: 42,
        items: [1, 2, 3],
        nested: { a: 1, b: 2 },
      });

      const result = extractJson(json);

      expect(result.success).toBe(true);
      expect(result.schema).toBeDefined();
      expect(result.schema?.type).toBe('object');
      expect(result.schema?.properties).toHaveProperty('name');
      expect(result.schema?.properties).toHaveProperty('items');
    });

    it('should handle arrays', () => {
      const json = JSON.stringify([
        { id: 1, name: 'First' },
        { id: 2, name: 'Second' },
        { id: 3, name: 'Third' },
      ]);

      const result = extractJson(json);

      expect(result.success).toBe(true);
      expect(result.schema?.type).toBe('array');
      expect(result.schema?.count).toBe(3);
    });

    it('should fail on invalid JSON', () => {
      const result = extractJson('{ invalid json }');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});

describe('XML Extractor', () => {
  describe('extractXml', () => {
    it('should parse RSS feeds', () => {
      const rss = `<?xml version="1.0"?>
        <rss version="2.0">
          <channel>
            <title>Test Feed</title>
            <description>A test RSS feed</description>
            <item>
              <title>First Item</title>
              <link>https://example.com/1</link>
            </item>
            <item>
              <title>Second Item</title>
              <link>https://example.com/2</link>
            </item>
          </channel>
        </rss>`;

      const result = extractXml(rss);

      expect(result.success).toBe(true);
      expect(result.isFeed).toBe(true);
      expect(result.feedMetadata?.title).toBe('Test Feed');
      expect(result.items?.length).toBe(2);
    });

    it('should parse Atom feeds', () => {
      const atom = `<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Atom Feed</title>
          <entry>
            <title>Entry 1</title>
            <link href="https://example.com/entry1"/>
          </entry>
        </feed>`;

      const result = extractXml(atom);

      expect(result.success).toBe(true);
      expect(result.isFeed).toBe(true);
      expect(result.items?.length).toBe(1);
    });

    it('should handle generic XML', () => {
      const xml = `<?xml version="1.0"?>
        <data>
          <item id="1">Value 1</item>
          <item id="2">Value 2</item>
        </data>`;

      const result = extractXml(xml);

      expect(result.success).toBe(true);
      expect(result.isFeed).toBe(false);
      expect(result.markdown).toContain('XML Document');
    });
  });
});

describe('Text Extractor', () => {
  describe('extractText', () => {
    it('should detect headings in plain text', () => {
      const text = `INTRODUCTION
============

This is the first paragraph.

CHAPTER ONE
-----------

More content here.`;

      const result = extractText(text);

      expect(result.success).toBe(true);
      expect(result.detectedStructure.hasHeadings).toBe(true);
      expect(result.markdown).toContain('#');
    });

    it('should detect bullet lists', () => {
      const text = `Things to do:
- Item one
- Item two
- Item three`;

      const result = extractText(text);

      expect(result.success).toBe(true);
      expect(result.detectedStructure.hasBulletLists).toBe(true);
    });

    it('should detect numbered lists', () => {
      const text = `Steps:
1. First step
2. Second step
3. Third step`;

      const result = extractText(text);

      expect(result.success).toBe(true);
      expect(result.detectedStructure.hasNumberedLists).toBe(true);
    });

    it('should detect code-like content', () => {
      const text = `function hello() {
  const message = "Hello";
  console.log(message);
  return message;
}`;

      const result = extractText(text);

      expect(result.success).toBe(true);
      expect(result.detectedStructure.isLikelyCode).toBe(true);
      expect(result.markdown).toContain('```');
    });
  });
});
