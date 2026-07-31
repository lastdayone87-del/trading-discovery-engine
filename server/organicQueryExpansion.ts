import { createHash } from 'node:crypto';
import type { QueryIntent } from '../src/types';
import { getDb } from './db';
import { assessLanguageCapability, type LanguageCapabilityDecision } from './globalLanguageModel';

export const ORGANIC_QUERY_POLICY_VERSION = 'organic-query-expansion-v2-global-language';

export type OrganicQuerySource =
  | 'VALIDATED_CONCEPT' | 'MULTILINGUAL_SURFACE' | 'RELATED_ENTITY'
  | 'PLAYLIST_TOPIC' | 'CREATOR_NEIGHBORHOOD' | 'CROSS_LANGUAGE_CONCEPT'
  | 'TRANSCRIPT_KEYPHRASE' | 'EXTERNAL_ENTITY' | 'COVERAGE_GAP';
export type OrganicQueryLifecycle = 'CANDIDATE' | 'VALIDATED' | 'SEARCH_TRIAL' | 'PROVEN' | 'STALE' | 'SATURATED' | 'HARMFUL' | 'INVALID';

export interface OrganicQueryCandidate {
  candidateId: string;
  conceptId: string;
  surface: string;
  sourceType: OrganicQuerySource;
  sourceRefs: string[];
  independentSourceIds: string[];
  language: string;
  script: string;
  locale?: string;
  intent: QueryIntent;
  lifecycle: OrganicQueryLifecycle;
  validation: { language: boolean; script: boolean; safety: boolean; retrievalShape: boolean; policyVersion: string };
  catalog?: { versionId: string; checksum: string; pointerVersion: number };
  trial?: { experimentId: string; armKey: string; assignmentCap: number; quotaCap: number };
}

export interface GovernedOrganicCandidate extends OrganicQueryCandidate {
  normalizedSurface: string;
  provenanceChecksum: string;
  eligibilityReason: string;
  languageCapability: LanguageCapabilityDecision;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseQuerySpec(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Admission is deliberately deterministic: generators propose; governance decides eligibility. */
export function admitOrganicQueryCandidates(candidates: OrganicQueryCandidate[]): GovernedOrganicCandidate[] {
  const admitted = new Map<string, GovernedOrganicCandidate>();
  for (const candidate of [...candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId))) {
    const normalizedSurface = candidate.surface.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
    const validations = candidate.validation;
    const independentlyCorroborated = new Set(candidate.independentSourceIds.filter(Boolean)).size >= 2;
    const isTrial = candidate.lifecycle === 'SEARCH_TRIAL';
    const isProven = candidate.lifecycle === 'PROVEN';
    const governedTrial = !!candidate.trial && candidate.trial.assignmentCap > 0 && candidate.trial.quotaCap > 0;
    const published = !!candidate.catalog?.versionId && !!candidate.catalog.checksum && (candidate.catalog.pointerVersion || 0) > 0;
    const languageCapability = assessLanguageCapability(
      [{ field: 'query_surface', text: candidate.surface, language: candidate.language }],
      { contentLanguage: candidate.language, contentScript: candidate.script, queryLocale: candidate.locale, targetAudienceLocale: candidate.locale },
      { controlledTrial: isTrial }
    );
    if (!candidate.candidateId || !candidate.conceptId || !normalizedSurface || !candidate.sourceRefs.length || !validations) continue;
    if (validations.policyVersion !== ORGANIC_QUERY_POLICY_VERSION || !validations.language || !validations.script || !validations.safety || !validations.retrievalShape) continue;
    if (languageCapability.disposition === 'ABSTAIN') continue;
    if (!independentlyCorroborated || (!isTrial && !isProven) || (isTrial && !governedTrial) || (isProven && !published)) continue;
    const provenanceChecksum = createHash('sha256').update(stable({ ...candidate, independentSourceIds: [...new Set(candidate.independentSourceIds)].sort(), sourceRefs: [...new Set(candidate.sourceRefs)].sort() })).digest('hex');
    const key = `${candidate.conceptId}\u001f${normalizedSurface}`;
    if (!admitted.has(key)) admitted.set(key, { ...candidate, normalizedSurface, provenanceChecksum, languageCapability, eligibilityReason: isProven ? 'PUBLISHED_PROVEN_CANDIDATE' : 'QUOTA_LIMITED_CONTROLLED_TRIAL' });
  }
  return [...admitted.values()];
}

/** Reads only the immutable catalog pinned for SEARCH; malformed/legacy entries fail closed. */
export async function getPublishedOrganicQueryCandidates(country: string, locale = 'und'): Promise<OrganicQueryCandidate[]> {
  const db = await getDb();
  const result = await db.query(`SELECT e.candidate_key,e.surface_text,e.query_spec,e.ordinal,
      e.catalog_version_id,p.pointer_version,v.checksum,h.state
    FROM active_catalog_pointers p
    JOIN serving_catalog_versions v ON v.id=p.catalog_version_id AND v.status='APPROVED'
    JOIN serving_catalog_entries e ON e.catalog_version_id=p.catalog_version_id AND e.country=p.country AND e.locale=p.locale AND e.lane=p.lane
    JOIN catalog_lifecycle_heads h ON h.lifecycle_key=e.country||chr(31)||e.locale||chr(31)||e.lane||chr(31)||e.candidate_key AND h.state='PROVEN'
    WHERE p.country=$1 AND p.locale=$2 AND p.lane='SEARCH' ORDER BY e.ordinal`, [country, locale]);
  return result.rows.flatMap((row: any) => {
    const spec = parseQuerySpec(row.query_spec);
    const provenance = spec?.organicProvenance;
    if (!provenance?.conceptId || !Array.isArray(provenance.sourceRefs) || !Array.isArray(provenance.independentSourceIds)) return [];
    return [{
      candidateId: String(row.candidate_key), conceptId: String(provenance.conceptId), surface: String(row.surface_text),
      sourceType: provenance.sourceType as OrganicQuerySource, sourceRefs: provenance.sourceRefs.map(String),
      independentSourceIds: provenance.independentSourceIds.map(String), language: String(provenance.language || 'und'),
      script: String(provenance.script || 'Zyyy'), locale, intent: (spec.intent || 'strategy') as QueryIntent, lifecycle: 'PROVEN' as const,
      validation: provenance.validation, catalog: { versionId: String(row.catalog_version_id), checksum: String(row.checksum), pointerVersion: Number(row.pointer_version) }
    }];
  });
}
