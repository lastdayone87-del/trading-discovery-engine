import type { QueryRecord } from '../../src/types';

/** Tiered composition contract. SPECULATIVE may never spend production quota. */
export type QueryCompositionTier = 'ATTESTED_EXACT' | 'LICENSED_UNSEEN' | 'SPECULATIVE';

export type QueryAtomRole = 'ANCHOR' | 'MODIFIER' | 'RELATION';

export interface TermSense {
  term: string;
  normalizedTerm: string;
  language: string;
  country: string;
  market: string;
  instrumentClass: string;
  type: 'TERMINOLOGY' | 'INSTRUMENT' | 'PHRASE' | 'FORMAT' | 'CONCEPT' | 'ENTITY';
  /** Attestation lineage; an empty list means the surface is unlicensed. */
  attestationIds: string[];
}

export interface TermAttestation {
  id: string;
  term: string;
  normalizedTerm: string;
  country: string;
  language: string;
  market: string;
  sourceFamilyId: string;
  observedAt: string;
  /** Exact means a literal, creator-owned local surface. */
  kind: 'EXACT' | 'LICENSED_TRANSLATION';
}

export interface CountryMarketProfile {
  country: string;
  languages: string[];
  scripts: string[];
  markets: string[];
  instruments: string[];
  primaryMarket: string;
  productionConfigured: boolean;
}

export interface QueryAtom {
  term: string;
  role: QueryAtomRole;
  sense: TermSense;
  /** Human-readable provenance; never a classification authority. */
  provenance: string;
}

export interface QueryCandidate {
  query: string;
  country: string;
  language: string;
  market: string;
  atoms: QueryAtom[];
  tier: QueryCompositionTier;
  compositionFamily: string;
  relation?: string;
  source: QuerySource;
  primaryTerm: string;
}

export type QuerySource =
  | 'CURATED'
  | 'COUNTRY_VOCABULARY'
  | 'LEARNED_TERMINOLOGY'
  | 'ORGANIC'
  | 'MANUAL'
  | 'PERSISTENT_RESEARCH'
  | 'PR557'
  | 'COLD_START';

export interface QueryAdmission {
  version: string;
  candidateHash: string;
  eligible: boolean;
  tier: QueryCompositionTier;
  reasonCodes: string[];
  compositionFamily: string;
  country: string;
  language: string;
  market: string;
  source: QuerySource;
  admittedAt: string;
  /** Policy/registry versions that must still be current at execution. */
  policyVersions: Record<string, string>;
}

export interface QueryQualityVector {
  version: string;
  rawResults: number;
  distinctResults: number;
  newChannels: number;
  newConfirmedCreators: number;
  newQualityCreators: number;
  quotaUsed: number;
  quotaUnits: number;
  confirmedNewCreatorsPer100Quota: number;
  qualityNewCreatorsPer100Quota: number;
  duplicateRatio: number;
  semanticOverlapRatio: number;
  invalidQueryRate: number;
  zeroResultRate: number;
  targetMarketPrecision: number;
  languageMatchRate: number;
  providerDegraded: boolean;
  failedRun: boolean;
}

export interface QueryQualityEvidence {
  queryId: number;
  query: string;
  country: string;
  language: string;
  market: string;
  compositionFamily: string;
  tier: QueryCompositionTier;
  decays: DecayedArmCounts;
}

export interface DecayedArmCounts {
  /** Decayed newly confirmed creators. */
  confirmed: number;
  /** Decayed quality-confirmed creators. */
  quality: number;
  /** Decayed quota units (100 = one unit). */
  quotaUnits: number;
  /** Raw completed runs for minimum-sample decisions. */
  runs: number;
}

/**
 * Decayed stratum totals for empirical-Bayes partial pooling. Built from every
 * query in the country's accounting window, including cooling-down, rotated,
 * share-capped and otherwise unselectable rows, so a new surface inherits its
 * family/country/market/language history instead of the general prior.
 */
export interface SelectionHierarchy {
  total: DecayedArmCounts;
  family: Record<string, DecayedArmCounts>;
  country: Record<string, DecayedArmCounts>;
  market: Record<string, DecayedArmCounts>;
  language: Record<string, DecayedArmCounts>;
}

export interface HierarchicalPrior {
  /** Weak global rate prior (creators per 100 quota). */
  mean: number;
  /** Prior strength in quota units. */
  strength: number;
}

export interface ArmPosterior {
  alpha: number;
  beta: number;
  mean: number;
  sd: number;
  lcb: number;
  ucb: number;
  sample: number;
}

export interface SelectorCandidate {
  queryId: number;
  query: string;
  collection: QueryRecord['collection'];
  country: string;
  language: string;
  market: string;
  compositionFamily: string;
  tier: QueryCompositionTier;
  primaryTerm: string;
  counts: DecayedArmCounts;
  admission?: QueryAdmission;
  nextEligibleAt?: string | null;
  reservedUntil?: string | null;
}

export interface SelectorContext {
  country: string;
  now: string;
  c: number;
  maxIndex: number;
  minSample: number;
  portfolioRatio: number;
  totalDailyQuotaUnits: number;
  portfolioUnitsUsed: number;
  familyShare: Record<string, number>;
  familyCap: number;
  queryCap: number;
  countryShare: Record<string, number>;
  countryCap: number;
  sourceShare: Record<string, number>;
  sourceCap: number;
  prior: HierarchicalPrior;
  halfLifeDays: number;
  /**
   * Stratum totals over every query in the accounting window. When absent the
   * selector falls back to the executable candidate set (unit-test callers).
   */
  hierarchy?: SelectionHierarchy;
  /** Country x language x market x term-class x family coverage matrix. */
  coverageCells?: string[];
  coveredCells?: string[];
}

export interface SelectorDecision {
  version: string;
  strategy: 'UCB_EXPLOITATION' | 'UCB_PORTFOLIO' | 'COLD_START' | 'NO_ELIGIBLE_QUERY';
  reason: string;
  queryId: number | null;
  query: string | null;
  country: string;
  c: number;
  index: number | null;
  posterior: ArmPosterior | null;
  candidateSetHash: string;
  tier: QueryCompositionTier | null;
  compositionFamily: string | null;
  policyVersions: Record<string, string>;
  reasonCodes: string[];
}
