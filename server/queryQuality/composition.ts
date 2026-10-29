import { createHash } from 'node:crypto';
import { isSearchableTradingTerm, type SearchabilityTermType } from '../terminologySearchability';
import { getCountryMarketProfile } from './profiles';
import type {
  CountryMarketProfile,
  QueryAdmission,
  QueryAtom,
  QueryCandidate,
  QueryCompositionTier,
  TermAttestation,
  TermSense,
} from './types';

export const QUERY_COMPOSITION_VERSION = 'query-composition-v1';
export const QUERY_ADMISSION_VERSION = 'query-admission-v1';

const BARE_SHORT_TICKER = /^[A-Z0-9]{2,4}$/i;
const LICENSED_RELATIONS = new Set([
  'ANCHOR_MODIFIER',
  'ANCHOR_LEARNED',
  'ANCHOR_ORGANIC',
  'MARKET_INSTRUMENT',
  'METHOD_INSTRUMENT',
  'INSTRUMENT_FUTURES',
  'INSTRUMENT_INDEX',
]);

export interface CompositionContext {
  profile?: CountryMarketProfile;
  attestations?: TermAttestation[];
  /** Existing queries used for duplicate suppression, with their country. */
  history?: Array<{ query: string; country: string; aliasOf?: string }>;
  policyVersions?: Record<string, string>;
  now?: string;
}

export function normalizeCompositionTerm(term: string): string {
  return term.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

export function queryCompositionTokens(query: string): string[] {
  return normalizeCompositionTerm(query).split(/\s+/u).filter(Boolean);
}

/** Reorder-insensitive key; aliases/handles/trailing punctuation collapse. */
export function semanticQueryKey(query: string): string {
  return [...new Set(queryCompositionTokens(query).map(token => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')))].filter(Boolean).sort().join(' ');
}

function jaccard(a: string, b: string): number {
  const left = new Set(queryCompositionTokens(a));
  const right = new Set(queryCompositionTokens(b));
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

export function isSemanticDuplicate(query: string, history: Array<{ query: string; country: string; aliasOf?: string }> = [], country?: string): boolean {
  const key = semanticQueryKey(query);
  return history.some(item => {
    if (country && item.country !== country) return false;
    const other = semanticQueryKey(item.aliasOf || item.query);
    return other === key || jaccard(key, other) >= 0.8;
  });
}

/**
 * Q0 applies to learned/extracted terminology. Curated, country-vocabulary and
 * organic surfaces are already admitted by their producer contract (Q1
 * retrieval specificity plus country registry); they still have to pass the
 * shape, script, CTA and term-type checks, but not the semantic lexicon match.
 */
const GOVERNED_LICENSED_PROVENANCE = /(?:CURATED|COUNTRY_VOCABULARY|ORGANIC|PERSISTENT_RESEARCH|PR557|MANUAL)/iu;

function gateTypeFor(type: TermSense['type']): SearchabilityTermType {
  if (type === 'INSTRUMENT') return 'INSTRUMENT';
  if (type === 'FORMAT') return 'FORMAT';
  return 'TERMINOLOGY';
}

function requiresTradingSemantics(provenance: string | undefined): boolean {
  return !GOVERNED_LICENSED_PROVENANCE.test(String(provenance || ''));
}

function gateAtom(atom: QueryAtom): ReturnType<typeof isSearchableTradingTerm> {
  return isSearchableTradingTerm({
    term: atom.term,
    termType: gateTypeFor(atom.sense.type),
    country: atom.sense.country,
    language: atom.sense.language,
    requireTradingSemantics: requiresTradingSemantics(atom.provenance),
  });
}

function attestationMatches(attestation: TermAttestation, sense: TermSense, profile: CountryMarketProfile): boolean {
  if (attestation.country !== profile.country) return false;
  if (normalizeCompositionTerm(attestation.term) !== sense.normalizedTerm) return false;
  if (!profile.languages.includes(attestation.language)) return false;
  if (attestation.market !== profile.primaryMarket && attestation.market !== sense.market) return false;
  return true;
}

/** Determine the highest composition tier the candidate evidence supports. */
export function resolveCompositionTier(candidate: QueryCandidate, context: CompositionContext): QueryCompositionTier {
  const profile = context.profile || getCountryMarketProfile(candidate.country);
  const attestations = context.attestations || [];
  const exact = candidate.atoms.every(atom => attestations.some(attestation => attestation.kind === 'EXACT' && attestationMatches(attestation, atom.sense, profile)));
  if (exact && candidate.atoms.length > 0) return 'ATTESTED_EXACT';
  const licensed = candidate.atoms.length > 0 && candidate.atoms.every(atom =>
    profile.languages.includes(atom.sense.language)
    && (atom.sense.country === candidate.country || atom.sense.country === 'GLOBAL')
    && gateAtom(atom).eligible
  );
  if (licensed) return 'LICENSED_UNSEEN';
  return 'SPECULATIVE';
}

export interface BuildCandidateInput {
  query: string;
  country: string;
  language?: string;
  market?: string;
  atoms: Array<{ term: string; role?: QueryAtom['role']; type?: TermSense['type']; provenance?: string; country?: string; language?: string; market?: string }>;
  source: QueryCandidate['source'];
  relation?: string;
  compositionFamily?: string;
}

/** Build a typed candidate from producer atoms, before any admission call. */
export function buildQueryCandidate(input: BuildCandidateInput): QueryCandidate {
  const profile = getCountryMarketProfile(input.country);
  const language = input.language || profile.languages[0] || 'en';
  const market = input.market || profile.primaryMarket;
  const atoms: QueryAtom[] = input.atoms.map((atom, index) => ({
    term: atom.term.normalize('NFKC').trim().replace(/\s+/gu, ' '),
    role: atom.role || (index === 0 ? 'ANCHOR' : 'MODIFIER'),
    sense: {
      term: atom.term.normalize('NFKC').trim().replace(/\s+/gu, ' '),
      normalizedTerm: normalizeCompositionTerm(atom.term),
      language: atom.language || language,
      // An atom may carry explicit licensing metadata. Without it the atom is
      // scoped to the candidate country, which is the planner's normal path.
      country: atom.country || input.country,
      market: atom.market || market,
      instrumentClass: atom.type === 'INSTRUMENT' ? 'INSTRUMENT' : 'METHOD',
      type: atom.type || 'TERMINOLOGY',
      attestationIds: [],
    },
    provenance: atom.provenance || input.source,
  }));
  const tier = resolveCompositionTier({
    query: input.query,
    country: input.country,
    language,
    market,
    atoms,
    tier: 'SPECULATIVE',
    compositionFamily: input.compositionFamily || '',
    relation: input.relation,
    source: input.source,
    primaryTerm: atoms[0]?.term || input.query,
  }, { profile });
  return {
    query: input.query.normalize('NFKC').trim().replace(/\s+/gu, ' '),
    country: input.country,
    language,
    market,
    atoms,
    tier,
    compositionFamily: input.compositionFamily || compositionFamilyFor(atoms),
    relation: input.relation,
    source: input.source,
    primaryTerm: atoms[0]?.term || input.query,
  };
}

export function compositionFamilyFor(atoms: QueryAtom[]): string {
  const types = [...new Set(atoms.map(atom => atom.sense.type))].sort();
  return `family:${types.join('+') || 'EMPTY'}`;
}

export function candidateHash(candidate: QueryCandidate): string {
  return createHash('sha256').update(JSON.stringify({
    query: normalizeCompositionTerm(candidate.query),
    country: candidate.country,
    language: candidate.language,
    market: candidate.market,
    atoms: candidate.atoms.map(atom => ({ term: atom.sense.normalizedTerm, role: atom.role, type: atom.sense.type })),
    tier: candidate.tier,
    family: candidate.compositionFamily,
  })).digest('hex').slice(0, 24);
}

export interface CompositionDecision {
  eligible: boolean;
  tier: QueryCompositionTier;
  reasonCodes: string[];
}

/**
 * Validate one composition against the country/market/language contract.
 * This is a pure gate; it never spends quota or writes data.
 */
export function evaluateQueryComposition(candidate: QueryCandidate, context: CompositionContext = {}): CompositionDecision {
  const profile = context.profile || getCountryMarketProfile(candidate.country);
  const reasons: string[] = [];
  const normalized = normalizeCompositionTerm(candidate.query);
  const tokens = queryCompositionTokens(normalized);

  if (!normalized || tokens.length === 0) reasons.push('EMPTY_QUERY');
  if (tokens.length > 3) reasons.push('TOO_MANY_TOKENS');
  if (normalized.length > 40) reasons.push('TOO_LONG');
  if (tokens.length === 1 && BARE_SHORT_TICKER.test(tokens[0])) reasons.push('BARE_SHORT_TICKER');
  if (candidate.atoms.length === 0) reasons.push('NO_TYPED_ATOMS');
  if (candidate.atoms.length > 3) reasons.push('TOO_MANY_ATOMS');
  if (candidate.atoms.some(atom => atom.role === 'ANCHOR') === false) reasons.push('NO_ANCHOR');
  if (new Set(candidate.atoms.map(atom => atom.role)).size === 0) reasons.push('NO_TYPED_ATOMS');

  // Market/language isolation: an atom may travel only inside its own
  // country/language profile unless it is explicitly global and script
  // compatible. No country-specific exceptions.
  for (const atom of candidate.atoms) {
    if (atom.sense.country !== candidate.country && atom.sense.country !== 'GLOBAL') reasons.push('CROSS_COUNTRY_ATOM');
    if (!profile.languages.includes(atom.sense.language)) reasons.push('LANGUAGE_MISMATCH');
    if (!profile.languages.includes(candidate.language)) reasons.push('LANGUAGE_MISMATCH');
    const gate = gateAtom(atom);
    if (!gate.eligible) reasons.push(...gate.reasons.map(reason => `TERM_${reason.toUpperCase().replace(/-/g, '_')}`));
  }

  // Ambiguous instrument pairs (`OBX ES`) need an explicit market/relation
  // qualifier; short polysemous surfaces never combine by adjacency alone.
  const instrumentAtoms = candidate.atoms.filter(atom => atom.sense.type === 'INSTRUMENT' || BARE_SHORT_TICKER.test(queryCompositionTokens(atom.term)[0] || ''));
  if (instrumentAtoms.length >= 2 && !LICENSED_RELATIONS.has(String(candidate.relation || '').toUpperCase())) {
    reasons.push('AMBIGUOUS_INSTRUMENT_PAIR');
  }
  if (candidate.relation && !LICENSED_RELATIONS.has(candidate.relation.toUpperCase())) reasons.push('UNLICENSED_RELATION');

  if (context.history && isSemanticDuplicate(candidate.query, context.history, candidate.country)) reasons.push('SEMANTIC_DUPLICATE');

  const resolvedTier = resolveCompositionTier(candidate, { ...context, profile });
  if (resolvedTier === 'SPECULATIVE') reasons.push('SPECULATIVE_EVIDENCE_ONLY');
  // Tier fields are derived, never trusted from a producer-supplied label.
  if (candidate.tier !== resolvedTier) candidate.tier = resolvedTier;

  return {
    eligible: reasons.length === 0,
    tier: resolvedTier,
    reasonCodes: [...new Set(reasons)],
  };
}

/** Admit a candidate and return the durable, execution-revalidatable record. */
export function admitQueryCandidate(candidate: QueryCandidate, context: CompositionContext = {}): QueryAdmission {
  const decision = evaluateQueryComposition(candidate, context);
  return {
    version: QUERY_ADMISSION_VERSION,
    candidateHash: candidateHash(candidate),
    eligible: decision.eligible,
    tier: decision.tier,
    reasonCodes: decision.reasonCodes,
    compositionFamily: candidate.compositionFamily,
    country: candidate.country,
    language: candidate.language,
    market: candidate.market,
    source: candidate.source,
    admittedAt: context.now || new Date().toISOString(),
    policyVersions: {
      composition: QUERY_COMPOSITION_VERSION,
      admission: QUERY_ADMISSION_VERSION,
      ...(context.policyVersions || {}),
    },
  };
}

/** Execution-time revalidation: policy/term/registry drift invalidates admission. */
export function revalidateAdmission(
  stored: QueryAdmission,
  currentCandidate: QueryCandidate,
  context: CompositionContext = {},
): QueryAdmission {
  const fresh = admitQueryCandidate(currentCandidate, context);
  const drift = fresh.candidateHash !== stored.candidateHash
    || stored.eligible !== fresh.eligible
    || Object.entries(fresh.policyVersions).some(([key, version]) => stored.policyVersions[key] !== version);
  return drift
    ? { ...fresh, reasonCodes: [...new Set([...fresh.reasonCodes, 'STALE_ADMISSION_REVALIDATED'])] }
    : { ...stored, admittedAt: fresh.admittedAt };
}
