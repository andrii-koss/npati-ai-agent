export interface FtsDocument {
  id: string;
  title: string;
  body: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface FtsSearchResultItem {
  id: string;
  title: string;
  snippet: string;
  score: number;
  matchedTerms: string[];
}

export interface FtsSearchResult {
  query: string;
  matches: FtsSearchResultItem[];
  totalHits: number;
}

export class FtsMemorySearchEngine {
  private readonly docs = new Map<string, FtsDocument>();

  indexDocument(doc: FtsDocument): void {
    this.docs.set(doc.id, doc);
  }

  indexDocuments(docs: FtsDocument[]): void {
    for (const d of docs) this.indexDocument(d);
  }

  /**
   * 3. FTS5 / BM25 Keyword Search Engine
   */
  search(
    query: string,
    options: { limit?: number; minScore?: number } = {}
  ): FtsSearchResult {
    const limit = options.limit ?? 10;
    const minScore = options.minScore ?? 0.1;

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9а-яіїє]/gi, ""))
      .filter((t) => t.length > 1);

    if (terms.length === 0) {
      return { query, matches: [], totalHits: 0 };
    }

    const scoredItems: FtsSearchResultItem[] = [];

    for (const doc of this.docs.values()) {
      const titleLower = doc.title.toLowerCase();
      const bodyLower = doc.body.toLowerCase();
      const combined = `${titleLower} ${bodyLower}`;

      let matchScore = 0;
      const matchedTerms: string[] = [];

      for (const term of terms) {
        let termMatches = 0;

        // Title match has 3x weight
        if (titleLower.includes(term)) {
          termMatches += 3;
        }

        // Body match
        const occurrences = combined.split(term).length - 1;
        if (occurrences > 0) {
          termMatches += Math.min(occurrences, 5);
          matchedTerms.push(term);
        }

        matchScore += termMatches;
      }

      if (matchScore > 0) {
        // BM25-like normalized score
        const normalizedScore = Number((matchScore / (matchScore + 2)).toFixed(4));

        if (normalizedScore >= minScore) {
          // Generate snippet
          const firstTerm = matchedTerms[0] || terms[0]!;
          const matchIdx = bodyLower.indexOf(firstTerm);
          let snippet = doc.body.slice(0, 120);
          if (matchIdx > 30) {
            snippet = `...${doc.body.slice(matchIdx - 20, matchIdx + 80)}...`;
          }

          scoredItems.push({
            id: doc.id,
            title: doc.title,
            snippet,
            score: normalizedScore,
            matchedTerms,
          });
        }
      }
    }

    // Sort descending by score
    scoredItems.sort((a, b) => b.score - a.score);

    const matches = scoredItems.slice(0, limit);

    return {
      query,
      matches,
      totalHits: scoredItems.length,
    };
  }
}
