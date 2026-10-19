/**
 * Evidence-first discovery Phase 1 — deterministic screening.
 *
 * Pure and fully unit-testable: no DB, no network, no clocks. Consumes
 * extracted evidence candidates plus a pre-loaded screening baseline (catalog
 * terms, canonical staging keys, curated country vocabulary) and produces
 * PROBE_ELIGIBLE / REJECT with machine-readable reasons.
 *
 * Approved D4 change: a missing curated vocabulary row for the candidate's
 * country is NOT a rejection cause. Deterministic checks (spam, generic,
 * catalog/staging duplication, lookup health, language fit when a curated
 * profile exists) still apply and can admit the candidate to PROBE_ELIGIBLE.
 *
 * Authority boundary: PROBE_ELIGIBLE is inert staging metadata. This module
 * never reads or writes `search_eligible`, never mutates the canonical
 * catalog, and never advances the 3-creator / 2-community / 5-evidence gate.
 */

import { normalizeLanguageCode } from '../countrySearchHints';
import {
  KNOWN_INSTRUMENT_TERMS,
  detectSpamSignals,
  evaluateTermQualityFlags,
  normalizeTerm,
} from '../terminologyIntelligence';
import type { EvidenceCandidate } from './evidenceExtraction';

export const EVIDENCE_SCREENING_POLICY_VERSION = 'evidence-screening-v1';

export type ScreeningDecision = 'PROBE_ELIGIBLE' | 'REJECT';

/**
 * Baseline assembled by the pipeline runner from DB lookups. Lookup success
 * and row presence are deliberately distinct:
 * - `catalogOk`/`stagedOk`/`vocabOk` false means the lookup itself FAILED and
 *   screening fails closed (a transient read error must never make a known
 *   term look novel).
 * - `vocabLanguages === null` means the lookup SUCCEEDED and the country has
 *   no curated vocabulary row — approved D4 non-rejection (see module doc).
 */
export interface EvidenceScreeningBaseline {
  country: string;
  catalogOk: boolean;
  /** normalizeTerm forms already present in the canonical catalog for the country. */
  catalogTerms: string[];
  stagedOk: boolean;
  /** canonical_candidate_key values already staged (any provider). */
  stagedCanonicalKeys: string[];
  vocabOk: boolean;
  /** Curated vocabulary languages, or null when the country has no row. */
  vocabLanguages: string[] | null;
  /** All curated terms from the country's vocabulary row (empty when no row). */
  curatedTerms: string[];
  /** Explicit observation language from deterministic context selection, when known. */
  language?: string;
}

export interface ScreenedEvidenceCandidate {
  candidate: EvidenceCandidate;
  decision: ScreeningDecision;
  reasons: string[];
  policyVersion: string;
}

/**
 * Generic trading/market terms that are structurally non-novel: they are the
 * served vocabulary of the domain itself and must never consume probe budget.
 * Curated per-country vocabulary + KNOWN_INSTRUMENT_TERMS are merged in at
 * screening time rather than duplicated here.
 */
export const GENERIC_DISCOVERY_TERMS: readonly string[] = [
  'trading', 'trader', 'traders', 'signals', 'signal', 'forex', 'fx',
  'crypto', 'cryptocurrency', 'bitcoin', 'ethereum', 'altcoin',
  'stocks', 'stock market', 'investing', 'investment', 'investor',
  'finance', 'financial', 'money', 'market', 'markets', 'chart', 'charts',
  'price action', 'technical analysis', 'fundamental analysis',
  'day trading', 'swing trading', 'scalping', 'trading strategy',
  'trading course', 'profit', 'trading community',
];

export const SCREENING_REASONS = {
  PASS: 'DETERMINISTIC_CHECKS_PASSED',
  NO_CURATED_VOCABULARY: 'COUNTRY_WITHOUT_CURATED_VOCABULARY',
  LANGUAGE_FIT_CHECKED: 'COUNTRY_LANGUAGE_FIT_CHECKED',
  LANGUAGE_FIT_UNKNOWN: 'LANGUAGE_FIT_UNKNOWN',
  BASELINE_LOOKUP_FAILED: 'BASELINE_LOOKUP_FAILED',
  TOO_SHORT: 'TOO_SHORT',
  GENERIC_TERM: 'GENERIC_TERM',
  DUPLICATE_CATALOG: 'DUPLICATE_CATALOG',
  DUPLICATE_STAGED: 'DUPLICATE_STAGED',
  DUPLICATE_BATCH: 'DUPLICATE_BATCH',
  LANGUAGE_MISMATCH: 'LANGUAGE_MISMATCH',
} as const;

function primaryLanguage(value: string): string {
  const normalized = normalizeLanguageCode(value);
  return normalized ? normalized.split('-')[0] : '';
}

function genericForms(baseline: EvidenceScreeningBaseline): Set<string> {
  const forms = new Set<string>();
  for (const term of GENERIC_DISCOVERY_TERMS) forms.add(normalizeTerm(term));
  for (const term of KNOWN_INSTRUMENT_TERMS) forms.add(normalizeTerm(term));
  for (const term of baseline.curatedTerms) forms.add(normalizeTerm(term));
  return forms;
}

function evaluateOne(
  candidate: EvidenceCandidate,
  baseline: EvidenceScreeningBaseline,
  genericSet: Set<string>,
  batchKeys: Set<string>
): ScreenedEvidenceCandidate {
  const reject = (reasons: string[]): ScreenedEvidenceCandidate => ({
    candidate,
    decision: 'REJECT',
    reasons,
    policyVersion: EVIDENCE_SCREENING_POLICY_VERSION,
  });
  const pass = (reasons: string[]): ScreenedEvidenceCandidate => ({
    candidate,
    decision: 'PROBE_ELIGIBLE',
    reasons,
    policyVersion: EVIDENCE_SCREENING_POLICY_VERSION,
  });

  // Fail closed before any positive classification: a failed baseline lookup
  // is unknown novelty, never assumed-novel evidence.
  if (!baseline.catalogOk || !baseline.stagedOk || !baseline.vocabOk) {
    return reject([SCREENING_REASONS.BASELINE_LOOKUP_FAILED]);
  }

  const normalized = normalizeTerm(candidate.normalizedTerm);
  if (!normalized || Array.from(normalized).length < 2) {
    return reject([SCREENING_REASONS.TOO_SHORT]);
  }

  const spamSignals = detectSpamSignals(normalized);
  if (spamSignals.length > 0) return reject(spamSignals.map(code => `SPAM:${code}`));

  if (batchKeys.has(candidate.canonicalCandidateKey)) {
    return reject([SCREENING_REASONS.DUPLICATE_BATCH]);
  }

  if (baseline.catalogTerms.some(term => normalizeTerm(term) === normalized)) {
    return reject([SCREENING_REASONS.DUPLICATE_CATALOG]);
  }
  if (baseline.stagedCanonicalKeys.includes(candidate.canonicalCandidateKey)) {
    return reject([SCREENING_REASONS.DUPLICATE_STAGED]);
  }

  const quality = evaluateTermQualityFlags(normalized, {
    language: baseline.language,
    curatedTerms: baseline.curatedTerms,
  });
  if (quality.generic || genericSet.has(normalized)) {
    return reject([SCREENING_REASONS.GENERIC_TERM]);
  }

  const reasons: string[] = [SCREENING_REASONS.PASS];
  const expectedLanguages = (baseline.vocabLanguages || []).map(primaryLanguage).filter(Boolean);
  const observationLanguage = baseline.language ? primaryLanguage(baseline.language) : '';
  if (expectedLanguages.length === 0) {
    // No curated vocabulary row (approved D4) or no curated language profile:
    // deterministic checks above decide, absence is never a rejection.
    if (baseline.vocabLanguages === null) reasons.push(SCREENING_REASONS.NO_CURATED_VOCABULARY);
  } else if (!observationLanguage) {
    reasons.push(SCREENING_REASONS.LANGUAGE_FIT_UNKNOWN);
  } else if (!expectedLanguages.includes(observationLanguage)) {
    return reject([SCREENING_REASONS.LANGUAGE_MISMATCH]);
  } else {
    reasons.push(SCREENING_REASONS.LANGUAGE_FIT_CHECKED);
  }
  return pass(reasons);
}

/** Screen one candidate. Pure; deterministic for identical inputs. */
export function screenEvidenceCandidate(
  candidate: EvidenceCandidate,
  baseline: EvidenceScreeningBaseline
): ScreenedEvidenceCandidate {
  return evaluateOne(candidate, baseline, genericForms(baseline), new Set());
}

/**
 * Screen a batch extracted from one channel pass. Duplicate canonical keys
 * inside the batch are rejected after the first occurrence, so the staged
 * batch is itself duplicate-free.
 */
export function screenEvidenceCandidates(
  candidates: EvidenceCandidate[],
  baseline: EvidenceScreeningBaseline
): ScreenedEvidenceCandidate[] {
  const genericSet = genericForms(baseline);
  const batchKeys = new Set<string>();
  return candidates.map(candidate => {
    const result = evaluateOne(candidate, baseline, genericSet, batchKeys);
    if (result.decision === 'PROBE_ELIGIBLE') batchKeys.add(candidate.canonicalCandidateKey);
    return result;
  });
}
