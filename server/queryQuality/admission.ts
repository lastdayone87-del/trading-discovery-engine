import type { QueryRecord } from '../../src/types';
import {
  QUERY_COMPOSITION_VERSION,
  admitQueryCandidate,
  buildQueryCandidate,
  compositionFamilyFor,
  evaluateQueryComposition,
  revalidateAdmission,
  type BuildCandidateInput,
  type CompositionContext,
} from './composition';
import { getCountryMarketProfile } from './profiles';
import { TERMINOLOGY_SEARCHABILITY_VERSION } from '../terminologySearchability';
import type {
  QueryAdmission,
  QueryAtom,
  QueryCandidate,
  QuerySource,
  TermSense,
} from './types';

export const QUERY_ADMISSION_METADATA_KEY = 'queryAdmission';
export const QUERY_COUNTRY_REGISTRY_VERSION = 'production-configured-countries-2026-10-29';

/**
 * Source registry for the single admission chokepoint. Every producer that can
 * persist a query is listed here; the static contract test fails when a
 * direct-write producer is added without admission. `directWriteAllowed` is
 * deliberately false for every production source.
 */
export const QUERY_SOURCE_REGISTRY: Record<QuerySource, { producer: string; directWriteAllowed: false }> = {
  CURATED: { producer: 'queryPlanner country atoms', directWriteAllowed: false },
  COUNTRY_VOCABULARY: { producer: 'queryPlanner country vocabulary / native proposal', directWriteAllowed: false },
  LEARNED_TERMINOLOGY: { producer: 'queryPlanner canonical/legacy learned terminology', directWriteAllowed: false },
  ORGANIC: { producer: 'queryPlanner organic query expansion', directWriteAllowed: false },
  MANUAL: { producer: 'manual operator query', directWriteAllowed: false },
  PERSISTENT_RESEARCH: { producer: 'persistent research allocation', directWriteAllowed: false },
  PR557: { producer: 'PR #557 continuation surface', directWriteAllowed: false },
  COLD_START: { producer: 'queryPlanner cold-start generation', directWriteAllowed: false },
};

const TEMPLATE_RELATION: Record<string, string> = {
  COMPACT_PAIR: 'ANCHOR_MODIFIER',
  INSTRUMENT_MARKET: 'MARKET_INSTRUMENT',
  MARKET_INSTRUMENT: 'MARKET_INSTRUMENT',
  METHOD_INSTRUMENT: 'METHOD_INSTRUMENT',
  ANCHOR_LEARNED: 'ANCHOR_LEARNED',
  ANCHOR_ORGANIC: 'ANCHOR_ORGANIC',
};

const TEMPLATE_SOURCE: Record<string, QuerySource> = {
  ANCHOR_LEARNED: 'LEARNED_TERMINOLOGY',
  ANCHOR_ORGANIC: 'ORGANIC',
  ORGANIC_STANDALONE: 'ORGANIC',
};

const ATOM_TYPE: Record<string, TermSense['type']> = {
  INSTRUMENT: 'INSTRUMENT',
  METHOD: 'TERMINOLOGY',
  MARKET: 'CONCEPT',
  FORMAT: 'FORMAT',
  LEARNED: 'TERMINOLOGY',
  CONCEPT: 'CONCEPT',
  ENTITY: 'ENTITY',
  TOPIC: 'CONCEPT',
  NEIGHBORHOOD: 'CONCEPT',
  COVERAGE: 'CONCEPT',
};

export interface QueryRecordAdmissionInput
  extends Pick<QueryRecord, 'query' | 'country' | 'primary_term'> {
  generation_metadata?: Record<string, unknown> | string | null;
}

export interface QueryRecordAdmission {
  candidate: QueryCandidate;
  admission: QueryAdmission;
  eligible: boolean;
  reasonCodes: string[];
  storedAdmission: QueryAdmission | null;
  revalidated: boolean;
}

export function parseGenerationMetadata(value: Record<string, unknown> | string | null | undefined): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value as Record<string, any> : {};
}

function asSource(metadata: Record<string, any>): QuerySource {
  const template = String(metadata.queryTemplate || '');
  if (TEMPLATE_SOURCE[template]) return TEMPLATE_SOURCE[template];
  if (metadata.organicProvenance) return 'ORGANIC';
  if (metadata.learnedTerm) return 'LEARNED_TERMINOLOGY';
  if (metadata.countryNativeAllocation) return 'COUNTRY_VOCABULARY';
  if (metadata.scopePromoted === true) return 'COUNTRY_VOCABULARY';
  if (String(metadata.generationMode || '') === 'COLD_START') return 'COLD_START';
  if (String(metadata.source || '') === 'PERSISTENT_RESEARCH') return 'PERSISTENT_RESEARCH';
  if (String(metadata.source || '') === 'PR557') return 'PR557';
  return 'CURATED';
}

function preferredLanguage(metadata: Record<string, any>, country: string): string {
  const direct = metadata.preferredLanguage || metadata.language;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const lineage = metadata.languageLineage;
  if (lineage && typeof lineage.selectedLanguage === 'string' && lineage.selectedLanguage.trim()) {
    return lineage.selectedLanguage.trim();
  }
  return getCountryMarketProfile(country).languages[0] || 'en';
}

function typedAtoms(metadata: Record<string, any>, record: QueryRecordAdmissionInput, source: QuerySource, language: string): Array<BuildCandidateInput['atoms'][number]> {
  const market = String(metadata.market || metadata.targetMarket || '') || undefined;
  const raw = Array.isArray(metadata.atoms) ? metadata.atoms as Array<Record<string, any>> : [];
  // A governed country-native allocation is an explicit, lineage-bearing
  // override. Its local term is still shape/script/CTA checked, but it does
  // not need to repeat the governed semantic lexicon: the allocation and its
  // concrete trading anchor supply that context. Arbitrary learned rows do
  // not get this path.
  const countryNativeOverride = Boolean(metadata.countryNativeAllocation?.decisionId || metadata.countryNativeAllocation?.proposalId);
  const atoms = raw
    .map((atom, index) => ({
      term: String(atom.term || '').normalize('NFKC').trim(),
      role: String(atom.role || (index === 0 ? 'ANCHOR' : 'MODIFIER')).toUpperCase() === 'ANCHOR' ? 'ANCHOR' as const : 'MODIFIER' as const,
      type: ATOM_TYPE[String(atom.type || '').toUpperCase()] || 'TERMINOLOGY',
      provenance: countryNativeOverride ? 'COUNTRY_VOCABULARY' : String(atom.origin || source),
      // Preserve explicit atom scoping when a producer supplies it. Planner
      // atoms normally omit these fields and inherit the candidate country.
      country: typeof atom.country === 'string' && atom.country.trim() ? atom.country.trim() : undefined,
      language: typeof atom.language === 'string' && atom.language.trim() ? atom.language.trim() : language,
      market,
    }))
    .filter(atom => atom.term.length > 0);
  if (atoms.length > 0) {
    // The planner's first atom is always the anchor. Preserve that invariant
    // even when a legacy row lost role metadata.
    atoms[0].role = 'ANCHOR';
    return atoms;
  }
  // Compatibility path for pre-admission rows: the stored query itself is the
  // atom. It still has to pass the same Q0/Q1/Q2 gates; this is a migration
  // bridge, not an exemption.
  const term = String(metadata.localTier1Term || record.primary_term || record.query || '').normalize('NFKC').trim();
  return term ? [{
    term,
    role: 'ANCHOR',
    type: ATOM_TYPE[String(metadata.primaryType || metadata.queryAtomType || 'TERMINOLOGY').toUpperCase()] || 'TERMINOLOGY',
    provenance: 'LEGACY_COMPATIBILITY',
    language,
    market,
  }] : [];
}

export function candidateFromQueryRecord(
  record: QueryRecordAdmissionInput,
  context: CompositionContext = {},
): QueryCandidate {
  const metadata = parseGenerationMetadata(record.generation_metadata);
  const country = record.country;
  const language = preferredLanguage(metadata, country);
  const source = asSource(metadata);
  const atoms = typedAtoms(metadata, record, source, language);
  const relation = TEMPLATE_RELATION[String(metadata.queryTemplate || '').toUpperCase()];
  const candidate = buildQueryCandidate({
    query: record.query,
    country,
    language,
    market: typeof metadata.market === 'string' ? metadata.market : undefined,
    atoms,
    source,
    relation,
    compositionFamily: typeof metadata.compositionFamily === 'string' ? metadata.compositionFamily : undefined,
  });
  // Fall back to the record's own primary term when the metadata did not
  // provide the anchor (keeps attribution stable across legacy rows).
  if (!candidate.primaryTerm && record.primary_term) candidate.primaryTerm = record.primary_term;
  if (!candidate.compositionFamily) candidate.compositionFamily = compositionFamilyFor(candidate.atoms);
  void context;
  return candidate;
}

function policyVersions(metadata: Record<string, any>): Record<string, string> {
  const specificity = metadata.retrievalSpecificity?.policyVersion;
  return {
    composition: QUERY_COMPOSITION_VERSION,
    admission: 'query-admission-v1',
    terminology: TERMINOLOGY_SEARCHABILITY_VERSION,
    countryRegistry: QUERY_COUNTRY_REGISTRY_VERSION,
    ...(typeof specificity === 'string' ? { retrievalSpecificity: specificity } : {}),
  };
}

export function admitQueryRecord(
  record: QueryRecordAdmissionInput,
  context: CompositionContext = {},
): QueryRecordAdmission {
  const metadata = parseGenerationMetadata(record.generation_metadata);
  const candidate = candidateFromQueryRecord(record, context);
  const contextWithPolicies: CompositionContext = {
    ...context,
    policyVersions: { ...policyVersions(metadata), ...(context.policyVersions || {}) },
  };
  const admission = admitQueryCandidate(candidate, contextWithPolicies);
  const legacy = metadata.atoms || metadata.retrievalSpecificity ? [] : ['LEGACY_UNSCOPED_ADMISSION_COMPATIBILITY'];
  const reasonCodes = [...new Set([...admission.reasonCodes, ...legacy])];
  return {
    candidate,
    admission: { ...admission, reasonCodes },
    eligible: admission.eligible,
    reasonCodes,
    storedAdmission: null,
    revalidated: false,
  };
}

/**
 * Last-responsible-moment revalidation. A stored admission is never trusted
 * merely because it exists: the candidate hash, policy/registry versions and
 * current gates are recomputed. A still-valid candidate receives a fresh
 * admission; a drifted one is rejected (or re-admitted with an explicit
 * `STALE_ADMISSION_REVALIDATED` reason code).
 */
export function revalidateQueryRecordAdmission(
  record: QueryRecordAdmissionInput,
  context: CompositionContext = {},
): QueryRecordAdmission {
  const metadata = parseGenerationMetadata(record.generation_metadata);
  const stored = metadata[QUERY_ADMISSION_METADATA_KEY] as QueryAdmission | undefined;
  const fresh = admitQueryRecord(record, context);
  if (!stored || typeof stored !== 'object' || !stored.candidateHash) {
    return {
      ...fresh,
      reasonCodes: [...new Set([...fresh.reasonCodes, 'ADMISSION_BACKFILLED'])],
      revalidated: true,
    };
  }
  const contextWithPolicies: CompositionContext = {
    ...context,
    policyVersions: { ...policyVersions(metadata), ...(context.policyVersions || {}) },
  };
  const revalidated = revalidateAdmission(stored, fresh.candidate, contextWithPolicies);
  return {
    candidate: fresh.candidate,
    admission: revalidated,
    eligible: revalidated.eligible,
    reasonCodes: revalidated.reasonCodes,
    storedAdmission: stored,
    revalidated: true,
  };
}

/** Merge the admission into the metadata before persistence. */
export function withQueryAdmission(
  metadata: Record<string, unknown> | undefined,
  admission: QueryAdmission,
): Record<string, unknown> {
  return { ...(metadata || {}), [QUERY_ADMISSION_METADATA_KEY]: admission };
}

/** Pure helper used by tests and the operator surface. */
export function admissionReasonCodes(metadata: Record<string, unknown> | string | null | undefined): string[] {
  const parsed = parseGenerationMetadata(metadata as Record<string, unknown>);
  const admission = parsed[QUERY_ADMISSION_METADATA_KEY] as QueryAdmission | undefined;
  return Array.isArray(admission?.reasonCodes) ? [...admission.reasonCodes] : [];
}

export function evaluateQueryRecordComposition(record: QueryRecordAdmissionInput, context: CompositionContext = {}): {
  candidate: QueryCandidate;
  eligible: boolean;
  tier: QueryAdmission['tier'];
  reasonCodes: string[];
} {
  const candidate = candidateFromQueryRecord(record, context);
  const decision = evaluateQueryComposition(candidate, { policyVersions: policyVersions(parseGenerationMetadata(record.generation_metadata)), ...context });
  return { candidate, eligible: decision.eligible, tier: decision.tier, reasonCodes: decision.reasonCodes };
}
