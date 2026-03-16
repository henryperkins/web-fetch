/**
 * Synonym Expansion Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { expandWithSynonyms } from '../../src/processing/synonyms.js';

describe('Synonym expansion', () => {
  it('should expand "health" to include medical terms', () => {
    const expanded = expandWithSynonyms('health');
    expect(expanded).toContain('health');
    expect(expanded).toContain('medical');
    expect(expanded).toContain('hospital');
    expect(expanded).toContain('disease');
    expect(expanded).toContain('meningitis');
    expect(expanded).toContain('vaccine');
  });

  it('should expand "war" to include military terms', () => {
    const expanded = expandWithSynonyms('war');
    expect(expanded).toContain('war');
    expect(expanded).toContain('military');
    expect(expanded).toContain('conflict');
    expect(expanded).toContain('attack');
  });

  it('should do reverse lookup — "hospital" should expand to health domain', () => {
    const expanded = expandWithSynonyms('hospital');
    expect(expanded).toContain('hospital');
    expect(expanded).toContain('health');
    expect(expanded).toContain('medical');
    expect(expanded).toContain('vaccine');
  });

  it('should return only the term itself for unknown words', () => {
    const expanded = expandWithSynonyms('xyzzy');
    expect(expanded).toEqual(['xyzzy']);
  });

  it('should be case-insensitive', () => {
    const expanded = expandWithSynonyms('Health');
    expect(expanded).toContain('health');
    expect(expanded).toContain('medical');
  });
});
