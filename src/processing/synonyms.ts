/**
 * Synonym expansion for question-focused compaction.
 *
 * Small curated map of common query concepts to likely content terms.
 * Not a full thesaurus — just enough to bridge the gap between how
 * users phrase questions and how content is written.
 */

const SYNONYM_MAP: Record<string, string[]> = {
  health: [
    'medical', 'hospital', 'disease', 'illness', 'death', 'died', 'dying',
    'vaccine', 'symptom', 'outbreak', 'infection', 'patient', 'patients',
    'doctor', 'treatment', 'diagnosis', 'antibiotics', 'meningitis',
    'cancer', 'surgery', 'pandemic', 'epidemic', 'virus', 'clinical',
    'medicine', 'healthcare', 'nhs', 'prescription', 'drug', 'therapy',
  ],
  war: [
    'conflict', 'military', 'troops', 'attack', 'invasion', 'combat',
    'strikes', 'bombing', 'forces', 'weapons', 'battlefield', 'army',
    'navy', 'airstrike', 'missile', 'ceasefire', 'siege', 'occupation',
    'casualties', 'defense', 'defence', 'offensive', 'soldier',
  ],
  economy: [
    'economic', 'jobs', 'unemployment', 'inflation', 'gdp', 'market',
    'trade', 'recession', 'growth', 'budget', 'tax', 'debt', 'fiscal',
    'revenue', 'spending', 'finance', 'financial', 'banking', 'stock',
    'interest', 'wage', 'income', 'poverty', 'cost', 'price',
  ],
  technology: [
    'tech', 'software', 'algorithm', 'data', 'digital', 'app',
    'platform', 'internet', 'cyber', 'computing', 'cloud', 'startup',
    'innovation', 'device', 'hardware', 'smartphone', 'browser',
  ],
  politics: [
    'political', 'government', 'election', 'vote', 'parliament',
    'president', 'minister', 'policy', 'legislation', 'party', 'senator',
    'congress', 'democrat', 'republican', 'conservative', 'labour',
    'liberal', 'referendum', 'campaign', 'ballot', 'coalition',
  ],
  climate: [
    'weather', 'warming', 'emissions', 'carbon', 'temperature', 'flood',
    'drought', 'renewable', 'fossil', 'environmental', 'pollution',
    'greenhouse', 'deforestation', 'sustainability', 'energy', 'solar',
  ],
  crime: [
    'criminal', 'police', 'arrest', 'murder', 'robbery', 'theft',
    'fraud', 'prison', 'sentence', 'trial', 'court', 'judge', 'guilty',
    'victim', 'suspect', 'investigation', 'detective', 'assault',
    'offender', 'attacker', 'stabbing', 'shooting',
  ],
  education: [
    'school', 'university', 'student', 'teacher', 'college', 'exam',
    'curriculum', 'degree', 'academic', 'pupil', 'classroom', 'tuition',
    'scholarship', 'graduate', 'professor', 'lecture', 'campus',
  ],
  sport: [
    'sports', 'game', 'match', 'team', 'player', 'championship',
    'tournament', 'league', 'coach', 'athlete', 'football', 'soccer',
    'cricket', 'tennis', 'rugby', 'olympic', 'medal', 'season', 'score',
  ],
  entertainment: [
    'film', 'movie', 'music', 'concert', 'album', 'actor', 'actress',
    'director', 'oscar', 'oscars', 'award', 'celebrity', 'television',
    'streaming', 'netflix', 'hollywood', 'theater', 'theatre', 'show',
  ],
};

/**
 * Expand a query term with synonyms and related terms.
 */
export function expandWithSynonyms(term: string): string[] {
  const lower = term.toLowerCase();
  const expanded = new Set<string>([lower]);

  // Direct lookup
  if (SYNONYM_MAP[lower]) {
    for (const s of SYNONYM_MAP[lower]) {
      expanded.add(s);
    }
  }

  // Reverse lookup: if term appears in any synonym list, add that key + siblings
  for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (synonyms.includes(lower)) {
      expanded.add(key);
      for (const s of synonyms) {
        expanded.add(s);
      }
    }
  }

  return [...expanded];
}
