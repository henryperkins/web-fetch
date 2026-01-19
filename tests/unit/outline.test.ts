/**
 * Outline Generator Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { generateOutline, findHeadingPath } from '../../src/processing/outline.js';

describe('Outline Generator', () => {
  it('should ignore headings inside code fences', () => {
    const markdown = `# Top

\`\`\`python
# not a heading
\`\`\`

## Section

Content here.`;

    const outline = generateOutline(markdown);

    expect(outline.map(entry => entry.text)).toEqual(['Top', 'Section']);
  });

  it('should not include code fence headings in heading paths', () => {
    const markdown = `# Top

\`\`\`md
# not a heading
\`\`\`

## Section

Content here.`;

    const codeIndex = markdown.indexOf('# not a heading');
    const path = findHeadingPath(markdown, codeIndex);

    expect(path).toBe('Top');
  });
});
