import type { QueryRecord } from '../src/types';
import { isRetrievalOrientedQuery } from './queryPlanner';
import { RETRIEVAL_SPECIFICITY_POLICY_VERSION } from './retrievalSpecificity';

export const AUTONOMOUS_QUERY_AUTHORITY_POLICY_VERSION = 'autonomous-query-authority-v2';

export interface AutonomousQueryAuthorityDecision {
  eligible: boolean;
  reasonCodes: string[];
  retrievalPolicyVersion?: string;
}

const EXPLICIT_STANDALONE_METHOD_CONTEXT = /\b(trading|trader|day\s*trading|swing\s*trading|forex|futures?|options?|spread\s*betting|prop\s*firm|funded\s*trader|analyse\s*technique|analisi\s*tecnica|an[aá]lisis\s*t[eé]cnico|technische\s*analyse|teknisk\s*analys|teknisk\s*analyse|b[oö]rsen?analyse\s+schweiz|futures\s*handel|trading\s*psychology)\b/iu;

function metadataOf(query: QueryRecord): Record<string, any> {
  const raw = (query as QueryRecord & { generation_metadata?: unknown }).generation_metadata;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, any>; } catch { return {}; }
  }
  return typeof raw === 'object' ? raw as Record<string, any> : {};
}

/**
 * Execution-time authority gate for every autonomous query source.
 *
 * A query is not grandfathered merely because it is already stored as PROVEN or
 * EXPERIMENTAL. It must carry current retrieval-specificity provenance and still
 * satisfy the current retrieval-shape policy at the moment it is about to spend
 * YouTube quota. This also applies to persistent-research allocations.
 */
export function evaluateAutonomousQueryAuthority(query: QueryRecord): AutonomousQueryAuthorityDecision {
  const reasons: string[] = [];
  if (query.collection === 'REJECTED') return { eligible: false, reasonCodes: ['QUERY_ALREADY_REJECTED'] };
  if (!isRetrievalOrientedQuery(query.country, query.query)) return { eligible: false, reasonCodes: ['CURRENT_RETRIEVAL_SHAPE_FAILED'] };

  const metadata = metadataOf(query);
  const specificity = metadata.retrievalSpecificity as Record<string, any> | undefined;
  const atoms = Array.isArray(metadata.atoms) ? metadata.atoms as Array<Record<string, any>> : [];
  const template = String(metadata.queryTemplate || '');

  if (!specificity) return { eligible: false, reasonCodes: ['CURRENT_RETRIEVAL_PROVENANCE_MISSING'] };
  if (specificity.policyVersion !== RETRIEVAL_SPECIFICITY_POLICY_VERSION) {
    return { eligible: false, reasonCodes: ['STALE_RETRIEVAL_POLICY_VERSION'], retrievalPolicyVersion: String(specificity.policyVersion || '') };
  }
  if (!['STANDALONE', 'ANCHOR_ONLY'].includes(String(specificity.eligibility))) {
    return { eligible: false, reasonCodes: ['PRIMARY_ATOM_NOT_AUTHORIZED_FOR_RETRIEVAL'], retrievalPolicyVersion: specificity.policyVersion };
  }

  if (atoms.length) {
    const staleAtom = atoms.find(atom => atom.retrievalPolicy?.policyVersion !== RETRIEVAL_SPECIFICITY_POLICY_VERSION);
    if (staleAtom) return { eligible: false, reasonCodes: ['ATOM_POLICY_PROVENANCE_STALE'], retrievalPolicyVersion: specificity.policyVersion };
    const anchor = atoms[0]?.retrievalPolicy?.eligibility;
    if (!['STANDALONE', 'ANCHOR_ONLY'].includes(String(anchor))) {
      return { eligible: false, reasonCodes: ['QUERY_ANCHOR_NOT_CURRENTLY_AUTHORIZED'], retrievalPolicyVersion: specificity.policyVersion };
    }

    // A generic method can be semantically trading-related while still being a
    // poor global retrieval surface (for example "Order Flow" or "Price Action").
    // Country-targeted autonomous retrieval therefore requires a concrete market/
    // instrument companion unless the standalone method carries explicit trading
    // context in the surface itself.
    const primaryType = String(atoms[0]?.type || '').toUpperCase();
    if (template === 'SINGLE_ATOM' && primaryType === 'METHOD' && !EXPLICIT_STANDALONE_METHOD_CONTEXT.test(query.query)) {
      return { eligible: false, reasonCodes: ['STANDALONE_METHOD_REQUIRES_CONCRETE_TRADING_ANCHOR'], retrievalPolicyVersion: specificity.policyVersion };
    }
  } else if (!['SINGLE_ATOM', 'ORGANIC_STANDALONE'].includes(template)) {
    return { eligible: false, reasonCodes: ['COMPOUND_QUERY_ATOM_PROVENANCE_MISSING'], retrievalPolicyVersion: specificity.policyVersion };
  }

  reasons.push('CURRENT_RETRIEVAL_POLICY_SATISFIED', 'EXECUTION_TIME_REVALIDATION_PASSED');
  return { eligible: true, reasonCodes: reasons, retrievalPolicyVersion: specificity.policyVersion };
}
