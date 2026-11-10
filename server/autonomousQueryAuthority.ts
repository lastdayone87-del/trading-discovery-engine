import type { QueryRecord } from '../src/types';
import { isBareShortTicker, isRetrievalOrientedQuery } from './queryPlanner';
import { isExtractedStandaloneQuery } from './terminologySearchability';
import { RETRIEVAL_SPECIFICITY_POLICY_VERSION } from './retrievalSpecificity';
import { revalidateQueryRecordAdmission } from './queryQuality/admission';

export const AUTONOMOUS_QUERY_AUTHORITY_POLICY_VERSION = 'autonomous-query-authority-v3';

export interface AutonomousQueryAuthorityDecision {
  eligible: boolean;
  reasonCodes: string[];
  retrievalPolicyVersion?: string;
  admissionHash?: string;
  admissionTier?: string;
  compositionFamily?: string;
  admissionReasonCodes?: string[];
}

const EXPLICIT_STANDALONE_METHOD_CONTEXT = /\b(trading|trader|day\s*trading|swing\s*trading|forex|futures?|options?|spread\s*betting|prop\s*firm|funded\s*trader|analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|chartanalyse|charttechnik|chart\s*analysis|technical\s*analysis|b[oö]rsen?analyse\s+schweiz|futures\s*handel|trading\s*psychology)\b/iu;

/** Pair templates in which a scope-promoted vocabulary anchor may lead.
 * This is exactly the set the planner can emit for anchor-less promoted
 * countries (COMPACT_PAIR plus INSTRUMENT_MARKET; MARKET-led and
 * learned/organic shapes structurally require an authorized anchor, and bare
 * SINGLE_ATOM surfaces are never promotable). Keep the two in sync: the
 * planner stamps promotion only on COMPACT_PAIR [INSTRUMENT, METHOD] and
 * INSTRUMENT_MARKET [INSTRUMENT, MARKET] pairs led by a COUNTRY_VOCABULARY
 * instrument, and the gate below enforces that exact shape. */
const SCOPE_PROMOTED_PAIR_TEMPLATES = new Set(['COMPACT_PAIR', 'INSTRUMENT_MARKET']);

/**
 * Persistent-scope promotion check. A scope-promoted vocabulary INSTRUMENT or
 * METHOD atom may anchor a paired template when it carries current policy
 * provenance and is accompanied by at least one companion atom. This is the
 * counterpart of the planner-side promotion: without it, the dormant
 * classification (no authorized anchor) would keep overriding the explicit
 * operator selection at execution time too. Standalone retrieval, stale
 * provenance, unsupported countries, and all other gates are unaffected.
 *
 * Promotion validity additionally depends on a live scope decision passed by
 * the caller (see scopePromotionActive): a DIRECT_TARGET promotion authorizes
 * the explicitly ordered one-shot work for its lifetime, while a persistent
 * (or legacy unmarked-basis) promotion requires the country to still be
 * selected. Deselection therefore restores dormant behavior even for already
 * stored queries, and reselection restores sweeping without burning them.
 */
function isScopePromotedAnchor(
  metadata: Record<string, any>,
  atoms: Array<Record<string, any>>,
  scopePromotionActive?: boolean,
): boolean {
  if (metadata.scopePromoted !== true) return false;
  const template = String(metadata.queryTemplate || '');
  if (!SCOPE_PROMOTED_PAIR_TEMPLATES.has(template)) return false;
  if (!Array.isArray(atoms) || atoms.length < 2) return false;
  // Exact promoted pair shape (mirrors the planner, the sole promotion
  // writer): a COUNTRY_VOCABULARY INSTRUMENT primary followed by a METHOD
  // companion for COMPACT_PAIR or a MARKET companion for INSTRUMENT_MARKET.
  // A marker on any other shape is malformed and must never spend quota.
  const primary = atoms[0];
  const companion = atoms[1];
  if (!primary || !companion) return false;
  if (String(primary.type || '').toUpperCase() !== 'INSTRUMENT') return false;
  if (String(primary.origin || '') !== 'COUNTRY_VOCABULARY') return false;
  const companionType = String(companion.type || '').toUpperCase();
  if (template === 'COMPACT_PAIR' && companionType !== 'METHOD') return false;
  if (template === 'INSTRUMENT_MARKET' && companionType !== 'MARKET') return false;
  if (primary.retrievalPolicy?.policyVersion !== RETRIEVAL_SPECIFICITY_POLICY_VERSION) return false;
  if (String(metadata.promotionBasis || 'PERSISTENT_SCOPE_SELECTION') !== 'DIRECT_TARGET' && scopePromotionActive === false) {
    return false;
  }
  return true;
}

/**
 * Narrow execution-time authority for free-signal bootstrap queries.
 *
 * Free Wikipedia/Wikidata surfaces are candidate vocabulary, never governed
 * evidence, so their own specificity is MODIFIER_ONLY. The planner emits a
 * standalone free surface only for a country with no authorized anchor and
 * only when the assembled query passes the same retrieval-shape gate as every
 * other candidate. This check re-verifies that exact shape at execution time:
 * one free-signal atom, concrete instrument or method class, current policy
 * provenance, and no bare short ticker. It cannot authorize anchored templates,
 * mixed/learned queries, or any surface the planner would reject.
 */
function isFreeSignalStandaloneAuthorized(
  query: QueryRecord,
  metadata: Record<string, any>,
  atoms: Array<Record<string, any>>,
): boolean {
  if (String(metadata.queryTemplate || '') !== 'FREE_SIGNAL_STANDALONE') return false;
  if (metadata.source !== 'FREE_SIGNAL') return false;
  if (!Array.isArray(metadata.sourceTypes) || metadata.sourceTypes.length !== 1 || metadata.sourceTypes[0] !== 'FREE_SIGNAL') return false;
  if (atoms.length !== 1) return false;
  const atom = atoms[0];
  if (!atom || String(atom.origin || '') !== 'FREE_SIGNAL') return false;
  if (Number(atom.tier) !== 3) return false;
  if (!['INSTRUMENT', 'METHOD'].includes(String(atom.type || '').toUpperCase())) return false;
  // Generic METHOD surfaces are rejected by the shared standalone-method
  // guard below, so they receive the same reason as SINGLE_ATOM methods.
  if (atom.retrievalPolicy?.policyVersion !== RETRIEVAL_SPECIFICITY_POLICY_VERSION) return false;
  if (isBareShortTicker(query.query)) return false;
  return true;
}

/**
 * Narrow execution-time authority for paid demand-only bootstrap queries.
 *
 * The planner may emit a standalone demand surface only for a country with no
 * authorized anchor. Demand surfaces are `ENTITY` modifier-only vocabulary, so
 * without this exact-shape exception the execution-time gate would withhold
 * every planned standalone demand query. It authorizes only the one-atom
 * template the planner writes; anchored, mixed, or copied markers stay
 * rejected.
 */
function isDemandSignalStandaloneAuthorized(
  query: QueryRecord,
  metadata: Record<string, any>,
  atoms: Array<Record<string, any>>,
  demandSignalsEnabled?: boolean,
): boolean {
  // The paid-demand switch is authoritative even for rows already stored and
  // queued: disabling demand must stop the next execution, not just new
  // planning. Callers with access to settings pass the live value; undefined
  // keeps the pure authority helper usable in benchmark/replay contexts.
  if (demandSignalsEnabled === false) return false;
  if (String(metadata.queryTemplate || '') !== 'DEMAND_SIGNAL_STANDALONE') return false;
  if (metadata.source !== 'DEMAND_SIGNAL') return false;
  if (!Array.isArray(metadata.sourceTypes) || metadata.sourceTypes.length !== 1 || metadata.sourceTypes[0] !== 'DEMAND_SIGNAL') return false;
  if (atoms.length !== 1) return false;
  const atom = atoms[0];
  if (!atom || String(atom.origin || '') !== 'DEMAND_SIGNAL') return false;
  if (Number(atom.tier) !== 3) return false;
  if (String(atom.type || '').toUpperCase() !== 'ENTITY') return false;
  if (atom.retrievalPolicy?.policyVersion !== RETRIEVAL_SPECIFICITY_POLICY_VERSION) return false;
  if (isBareShortTicker(query.query)) return false;
  return true;
}

/** True when a stored row carries any paid-demand provenance. Anchored
 * demand is a MIXED query (local anchor + demand atom), so its source is not
 * DEMAND_SIGNAL; the template and atom origins are the authoritative markers. */
function hasDemandSignalMetadata(metadata: Record<string, any>): boolean {
  const template = String(metadata.queryTemplate || '').toUpperCase();
  if (template === 'DEMAND_SIGNAL_STANDALONE' || template === 'ANCHOR_DEMAND_SIGNAL') return true;
  if (String(metadata.source || '').toUpperCase() === 'DEMAND_SIGNAL') return true;
  const atoms = Array.isArray(metadata.atoms) ? metadata.atoms as Array<Record<string, any>> : [];
  return atoms.some(atom => String(atom?.origin || '').toUpperCase() === 'DEMAND_SIGNAL');
}

/** True when a stored row needs the paid-demand execution exception. */
export function isDemandSignalRecord(query: QueryRecord): boolean {
  return hasDemandSignalMetadata(metadataOf(query));
}

function metadataOf(query: QueryRecord): Record<string, any> {
  const raw = (query as QueryRecord & { generation_metadata?: unknown }).generation_metadata;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, any>; } catch { return {}; }
  }
  return typeof raw === 'object' ? raw as Record<string, any> : {};
}

/**
 * Whether a stored query record carries a scope-promotion marker of any
 * basis (PERSISTENT_SCOPE_SELECTION, DIRECT_TARGET, or a legacy marker
 * without promotionBasis, which authorizes as the persistent form). The
 * queue worker uses this to read live scope only for promoted jobs: ordinary
 * jobs skip the settings read entirely, so a malformed/unavailable scope
 * configuration can never burn their attempts before retrieval.
 */
export function isScopePromotedRecord(metadata: unknown): boolean {
  if (!metadata) return false;
  if (typeof metadata === 'string') {
    try {
      const parsed: unknown = JSON.parse(metadata);
      return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).scopePromoted === true;
    } catch {
      return false;
    }
  }
  return typeof metadata === 'object' && (metadata as Record<string, unknown>).scopePromoted === true;
}

/**
 * Execution-time authority gate for every autonomous query source.
 *
 * A query is not grandfathered merely because it is already stored as PROVEN or
 * EXPERIMENTAL. It must carry current retrieval-specificity provenance and still
 * satisfy the current retrieval-shape policy at the moment it is about to spend
 * YouTube quota. This also applies to persistent-research allocations.
 */
export function evaluateAutonomousQueryAuthority(
  query: QueryRecord,
  options: { scopePromotionActive?: boolean; demandSignalsEnabled?: boolean } = {},
): AutonomousQueryAuthorityDecision {
  const reasons: string[] = [];
  if (query.collection === 'REJECTED') return { eligible: false, reasonCodes: ['QUERY_ALREADY_REJECTED'] };

  const metadata = metadataOf(query);
  const specificity = metadata.retrievalSpecificity as Record<string, any> | undefined;
  const atoms = Array.isArray(metadata.atoms) ? metadata.atoms as Array<Record<string, any>> : [];
  const template = String(metadata.queryTemplate || '');
  const extractedStandalone = template === 'EXTRACTED_STANDALONE' && atoms.length === 1;
  const shapeOk = extractedStandalone
    ? isExtractedStandaloneQuery({ term: query.query, country: query.country, language: typeof metadata.extractedCandidateLanguage === 'string' ? metadata.extractedCandidateLanguage : undefined })
    : isRetrievalOrientedQuery(query.country, query.query);
  if (!shapeOk) return { eligible: false, reasonCodes: ['CURRENT_RETRIEVAL_SHAPE_FAILED'] };
  // A persistent scope promotion is valid only while the operator still has
  // the country selected. Check this for every promoted shape, including
  // STANDALONE native singles, because their eligibility otherwise bypasses
  // the pair-only promotion check below. DIRECT_TARGET is a one-shot order
  // and keeps its existing exception.
  if (
    metadata.scopePromoted === true
    && String(metadata.promotionBasis || 'PERSISTENT_SCOPE_SELECTION') !== 'DIRECT_TARGET'
    && options.scopePromotionActive === false
  ) {
    return {
      eligible: false,
      reasonCodes: ['SCOPE_PROMOTION_INACTIVE'],
      retrievalPolicyVersion: String(specificity?.policyVersion || ''),
    };
  }

  // The paid-demand setting is a live execution kill switch. Record-level
  // demand provenance (standalone OR anchored) must be rejected here, not
  // only in the standalone exception: an authorized primary anchor would
  // otherwise execute an ANCHOR_DEMAND_SIGNAL row after the operator disabled
  // paid demand.
  if (options.demandSignalsEnabled === false && hasDemandSignalMetadata(metadata)) {
    return { eligible: false, reasonCodes: ['DEMAND_SIGNALS_DISABLED'], retrievalPolicyVersion: String(specificity?.policyVersion || '') };
  }

  if (!specificity) return { eligible: false, reasonCodes: ['CURRENT_RETRIEVAL_PROVENANCE_MISSING'] };
  if (specificity.policyVersion !== RETRIEVAL_SPECIFICITY_POLICY_VERSION) {
    return { eligible: false, reasonCodes: ['STALE_RETRIEVAL_POLICY_VERSION'], retrievalPolicyVersion: String(specificity.policyVersion || '') };
  }
  if (
    !['STANDALONE', 'ANCHOR_ONLY'].includes(String(specificity.eligibility))
    && !isScopePromotedAnchor(metadata, atoms, options.scopePromotionActive)
    && !isFreeSignalStandaloneAuthorized(query, metadata, atoms)
    && !isDemandSignalStandaloneAuthorized(query, metadata, atoms, options.demandSignalsEnabled)
  ) {
    return { eligible: false, reasonCodes: ['PRIMARY_ATOM_NOT_AUTHORIZED_FOR_RETRIEVAL'], retrievalPolicyVersion: specificity.policyVersion };
  }

  if (atoms.length) {
    const staleAtom = atoms.find(atom => atom.retrievalPolicy?.policyVersion !== RETRIEVAL_SPECIFICITY_POLICY_VERSION);
    if (staleAtom) return { eligible: false, reasonCodes: ['ATOM_POLICY_PROVENANCE_STALE'], retrievalPolicyVersion: specificity.policyVersion };
    const anchor = atoms[0]?.retrievalPolicy?.eligibility;
    if (
      !['STANDALONE', 'ANCHOR_ONLY'].includes(String(anchor))
      && !isScopePromotedAnchor(metadata, atoms, options.scopePromotionActive)
      && !isFreeSignalStandaloneAuthorized(query, metadata, atoms)
      && !isDemandSignalStandaloneAuthorized(query, metadata, atoms, options.demandSignalsEnabled)
    ) {
      return { eligible: false, reasonCodes: ['QUERY_ANCHOR_NOT_CURRENTLY_AUTHORIZED'], retrievalPolicyVersion: specificity.policyVersion };
    }

    // A generic method can be semantically trading-related while still being a
    // poor global retrieval surface (for example "Order Flow" or "Price Action").
    // Country-targeted autonomous retrieval therefore requires a concrete market/
    // instrument companion unless the standalone surface carries explicit trading
    // context. Free-signal bootstrap methods obey the same rule as curated
    // SINGLE_ATOM methods; localized method surfaces that meet the standard pass.
    const primaryType = String(atoms[0]?.type || '').toUpperCase();
    const reviewedNativeSurface = Array.isArray(atoms[0]?.retrievalPolicy?.reasonCodes)
      && atoms[0].retrievalPolicy.reasonCodes.includes('REVIEWED_NATIVE_PHRASE');
    if (
      (template === 'SINGLE_ATOM' || template === 'FREE_SIGNAL_STANDALONE')
      && primaryType === 'METHOD'
      && !reviewedNativeSurface
      && !EXPLICIT_STANDALONE_METHOD_CONTEXT.test(query.query)
    ) {
      return { eligible: false, reasonCodes: ['STANDALONE_METHOD_REQUIRES_CONCRETE_TRADING_ANCHOR'], retrievalPolicyVersion: specificity.policyVersion };
    }
  } else if (!['SINGLE_ATOM', 'ORGANIC_STANDALONE'].includes(template)) {
    return { eligible: false, reasonCodes: ['COMPOUND_QUERY_ATOM_PROVENANCE_MISSING'], retrievalPolicyVersion: specificity.policyVersion };
  }

  // Q2d execution-time admission gate: the stored admission is re-derived and
  // revalidated immediately before quota spend. Policy/registry drift,
  // composition drift and an ineligible tier all fail closed here.
  const admission = revalidateQueryRecordAdmission(query, { now: new Date().toISOString() });
  if (!admission.eligible) {
    return {
      eligible: false,
      reasonCodes: [
        ...reasons,
        ...admission.reasonCodes.map(code => `QUERY_ADMISSION_${code}`),
        'QUERY_ADMISSION_REJECTED',
      ],
      retrievalPolicyVersion: specificity.policyVersion,
      admissionHash: admission.admission.candidateHash,
      admissionTier: admission.admission.tier,
      compositionFamily: admission.admission.compositionFamily,
      admissionReasonCodes: admission.reasonCodes,
    };
  }

  reasons.push('CURRENT_RETRIEVAL_POLICY_SATISFIED', 'EXECUTION_TIME_REVALIDATION_PASSED', 'QUERY_ADMISSION_CURRENT');
  return {
    eligible: true,
    reasonCodes: reasons,
    retrievalPolicyVersion: specificity.policyVersion,
    admissionHash: admission.admission.candidateHash,
    admissionTier: admission.admission.tier,
    compositionFamily: admission.admission.compositionFamily,
    admissionReasonCodes: admission.reasonCodes,
  };
}
