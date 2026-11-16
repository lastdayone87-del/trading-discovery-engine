import { semanticQueryKey } from './queryQuality/composition';

/** A generated/rejected query, not an executable query-library row. */
export interface CandidateHistoryItem {
  query: string;
  country?: string;
  intent?: string | null;
  aliasOf?: string | null;
}

export type DuplicateClass = 'EXACT' | 'SEMANTIC' | 'NEAR_DUPLICATE' | null;

export interface DuplicateDecision {
  duplicate: boolean;
  nearDuplicate: boolean;
  class: DuplicateClass;
  similarity: number;
  matchedQuery: string | null;
}

export function normalizeCandidateText(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
}

function candidateTokens(query: string): string[] {
  return normalizeCandidateText(query).split(/\s+/u).filter(Boolean);
}

function jaccard(left: string, right: string): number {
  const a = new Set(candidateTokens(left));
  const b = new Set(candidateTokens(right));
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Exact/reordered duplicates are hard rejects. A high-overlap candidate with a
 * different declared intent is a soft near-duplicate: it may represent a
 * genuinely different search intention (for example live vs beginner), so the
 * caller can keep it for later ranking instead of discarding it outright.
 */
export function classifyCandidateDuplicate(
  candidate: CandidateHistoryItem,
  history: CandidateHistoryItem[],
): DuplicateDecision {
  const normalized = normalizeCandidateText(candidate.query);
  if (!normalized) return { duplicate: true, nearDuplicate: false, class: 'EXACT', similarity: 1, matchedQuery: null };
  const key = semanticQueryKey(normalized);
  let best: DuplicateDecision = { duplicate: false, nearDuplicate: false, class: null, similarity: 0, matchedQuery: null };

  for (const item of history) {
    const other = normalizeCandidateText(item.aliasOf || item.query);
    if (!other) continue;
    if (item.country && candidate.country && item.country !== candidate.country) continue;
    if (normalized === other) {
      return { duplicate: true, nearDuplicate: false, class: 'EXACT', similarity: 1, matchedQuery: item.query };
    }
    const otherKey = semanticQueryKey(other);
    if (key && key === otherKey) {
      return { duplicate: true, nearDuplicate: false, class: 'SEMANTIC', similarity: 1, matchedQuery: item.query };
    }
    const similarity = jaccard(normalized, other);
    const sameIntent = !candidate.intent || !item.intent || candidate.intent === item.intent;
    if (similarity >= 0.8 && sameIntent) {
      return { duplicate: true, nearDuplicate: false, class: 'SEMANTIC', similarity, matchedQuery: item.query };
    }
    if (similarity > best.similarity) {
      best = {
        duplicate: false,
        nearDuplicate: similarity >= 0.6,
        class: similarity >= 0.6 ? 'NEAR_DUPLICATE' : null,
        similarity,
        matchedQuery: item.query,
      };
    }
  }
  return best;
}

export function isHardDuplicate(candidate: CandidateHistoryItem, history: CandidateHistoryItem[]): boolean {
  return classifyCandidateDuplicate(candidate, history).duplicate;
}

/** Deduplicate within one provider batch while preserving input order. */
export function dedupeCandidateBatch<T extends CandidateHistoryItem>(
  candidates: T[],
  history: CandidateHistoryItem[] = [],
): { accepted: T[]; rejected: Array<{ candidate: T; decision: DuplicateDecision }> } {
  const accepted: T[] = [];
  const rejected: Array<{ candidate: T; decision: DuplicateDecision }> = [];
  const seen = [...history];
  for (const candidate of candidates) {
    const decision = classifyCandidateDuplicate(candidate, seen);
    if (decision.duplicate) {
      rejected.push({ candidate, decision });
      continue;
    }
    accepted.push(candidate);
    seen.push({ query: candidate.query, country: candidate.country, intent: candidate.intent, aliasOf: candidate.aliasOf });
  }
  return { accepted, rejected };
}
