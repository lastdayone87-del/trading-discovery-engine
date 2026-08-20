import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getDb } from './db';
import { canonicalCountry } from './countryInference';
import { inferScript, isNoiseOrBoilerplate, normalizeNativeTerm } from './countryNativeIntelligence';
import { buildFrontierProposal, type DiscoveryFrontierProposal } from './discoveryProposalGenerators';
import { createNeighborhoodChecksum } from './discoveryNeighborhood';

type Queryable = Pool | PoolClient | { query: (sql: string, params?: any[]) => Promise<any> };
export type OsintSourceFamily = 'PUBLIC_COMMUNITY' | 'PUBLICATION' | 'EDUCATOR_DIRECTORY' | 'BROKER_TERMINOLOGY' | 'TREND_SURFACE';

export interface ExternalOsintObservationInput {
  sourceId: string;
  sourceFamily: OsintSourceFamily;
  sourceUrl?: string | null;
  externalId?: string | null;
  fetchedAt: string;
  observedAt?: string;
  country: string;
  locale?: string | null;
  language: string;
  script?: string | null;
  surface: string;
  extractionMethod: string;
  extractionVersion: string;
  confidence: number;
  reliability: number;
  relevance: number;
  supportingEvidence: Record<string, unknown>;
  correlationKey?: string | null;
}

export interface ExternalOsintObservation extends ExternalOsintObservationInput {
  observationId: string;
  canonicalConcept: string;
  contentChecksum: string;
  script: string;
}

export interface OsintAdapter {
  readonly sourceId: string;
  readonly sourceFamily: OsintSourceFamily;
  readonly timeoutMs: number;
  readonly maxRequests: number;
  readonly maxCost: number;
  readonly retry: { attempts: number; backoffMs: number };
  fetch(signal: AbortSignal): Promise<ExternalOsintObservationInput[]>;
}

export interface OsintEvidenceAggregate {
  canonicalConcept: string;
  country: string;
  language: string;
  script: string;
  observationIds: string[];
  originalSurfaces: string[];
  sourceFamilies: OsintSourceFamily[];
  independentSourceCount: number;
  confidence: number;
  newestObservedAt: string;
  eligible: boolean;
  rejectionReasons: string[];
}

const MAX_SURFACE = 160;
const MAX_URL = 2048;
const MAX_EVIDENCE_BYTES = 16_384;
const FRESHNESS_DAYS = 30;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function normalizeExternalObservation(input: ExternalOsintObservationInput): ExternalOsintObservation {
  const surface = input.surface.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const concept = normalizeNativeTerm(surface);
  const country = canonicalCountry(input.country);
  const language = input.language.trim().toLowerCase();
  const sourceId = input.sourceId.trim().toLowerCase();
  if (!sourceId || sourceId.length > 120) throw new Error('OSINT_INVALID_SOURCE_ID');
  if (!surface || surface.length > MAX_SURFACE || isNoiseOrBoilerplate(surface)) throw new Error('OSINT_INVALID_SURFACE');
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) throw new Error('OSINT_INVALID_LANGUAGE');
  if (!Number.isFinite(input.confidence) || !Number.isFinite(input.reliability) || !Number.isFinite(input.relevance)) throw new Error('OSINT_INVALID_SCORE');
  if (input.sourceUrl && (input.sourceUrl.length > MAX_URL || !/^https:\/\//i.test(input.sourceUrl))) throw new Error('OSINT_INVALID_URL');
  if (Buffer.byteLength(canonicalJson(input.supportingEvidence)) > MAX_EVIDENCE_BYTES) throw new Error('OSINT_EVIDENCE_TOO_LARGE');
  const fetchedAt = new Date(input.fetchedAt);
  const observedAt = new Date(input.observedAt || input.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime()) || !Number.isFinite(observedAt.getTime())) throw new Error('OSINT_INVALID_TIME');
  const contentChecksum = checksum({ sourceId, externalId: input.externalId || null, surface, evidence: input.supportingEvidence });
  const observationId = checksum({ sourceId, sourceFamily: input.sourceFamily, externalId: input.externalId || input.sourceUrl || null, contentChecksum });
  return { ...input, sourceId, surface, country, language, fetchedAt: fetchedAt.toISOString(), observedAt: observedAt.toISOString(), canonicalConcept: concept, script: input.script || inferScript(surface), contentChecksum, observationId };
}

/** Mirrors/reposts share one independence bucket. Absent correlation metadata, source identity is conservative. */
export function aggregateOsintEvidence(observations: ExternalOsintObservation[], now = new Date()): OsintEvidenceAggregate[] {
  const groups = new Map<string, ExternalOsintObservation[]>();
  for (const o of observations) {
    const key = `${o.canonicalConcept}|${o.country}|${o.language}|${o.script}`;
    groups.set(key, [...(groups.get(key) || []), o]);
  }
  return [...groups.values()].map(group => {
    const sorted = [...group].sort((a, b) => a.observationId.localeCompare(b.observationId));
    const independence = new Set(sorted.map(o => o.correlationKey?.trim().toLowerCase() || `source:${o.sourceId}`));
    const newest = Math.max(...sorted.map(o => Date.parse(o.observedAt || o.fetchedAt)));
    const weighted = sorted.reduce((sum, o) => sum + Math.min(1, Math.max(0, o.confidence)) * Math.min(1, Math.max(0, o.reliability)) * Math.min(1, Math.max(0, o.relevance)), 0) / sorted.length;
    const reasons: string[] = [];
    if (independence.size < 2) reasons.push('INSUFFICIENT_INDEPENDENT_SOURCES');
    if (weighted < 0.55) reasons.push('INSUFFICIENT_EVIDENCE_STRENGTH');
    if (now.getTime() - newest > FRESHNESS_DAYS * 86_400_000) reasons.push('STALE_EVIDENCE');
    const scripts = new Set(sorted.map(o => o.script));
    if (scripts.size !== 1) reasons.push('SCRIPT_CONFLICT');
    return { canonicalConcept: sorted[0].canonicalConcept, country: sorted[0].country, language: sorted[0].language, script: sorted[0].script, observationIds: sorted.map(o => o.observationId), originalSurfaces: [...new Set(sorted.map(o => o.surface))].sort(), sourceFamilies: [...new Set(sorted.map(o => o.sourceFamily))].sort() as OsintSourceFamily[], independentSourceCount: independence.size, confidence: Math.min(0.95, weighted + Math.min(0.15, (independence.size - 1) * 0.05)), newestObservedAt: new Date(newest).toISOString(), eligible: reasons.length === 0, rejectionReasons: reasons };
  }).sort((a, b) => b.confidence - a.confidence || a.country.localeCompare(b.country) || a.canonicalConcept.localeCompare(b.canonicalConcept));
}

export async function insertExternalObservation(input: ExternalOsintObservationInput, runner?: Queryable): Promise<{ observation: ExternalOsintObservation; inserted: boolean }> {
  const observation = normalizeExternalObservation(input);
  const db = runner || await getDb();
  const result = await db.query(`INSERT INTO external_osint_observations(observation_id,source_id,source_family,source_url,external_id,fetched_at,observed_at,country,locale,language,script,original_surface,canonical_concept,extraction_method,extraction_version,confidence,reliability,relevance,supporting_evidence,content_checksum,correlation_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT(observation_id) DO NOTHING`, [observation.observationId,observation.sourceId,observation.sourceFamily,observation.sourceUrl||null,observation.externalId||null,observation.fetchedAt,observation.observedAt,observation.country,observation.locale||null,observation.language,observation.script,observation.surface,observation.canonicalConcept,observation.extractionMethod,observation.extractionVersion,observation.confidence,observation.reliability,observation.relevance,JSON.stringify(observation.supportingEvidence),observation.contentChecksum,observation.correlationKey||null]);
  return { observation, inserted: result.rowCount === 1 };
}

export async function runOsintAdapter(adapter: OsintAdapter): Promise<{ observations: ExternalOsintObservation[]; degraded: boolean; error?: string }> {
  if (adapter.maxRequests < 1 || adapter.maxRequests > 100 || adapter.maxCost < 0 || adapter.timeoutMs < 1 || adapter.timeoutMs > 30_000) return { observations: [], degraded: true, error: 'OSINT_ADAPTER_POLICY_REJECTED' };
  let lastError = 'OSINT_PROVIDER_UNAVAILABLE';
  for (let attempt = 0; attempt <= Math.min(3, adapter.retry.attempts); attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), adapter.timeoutMs);
    try {
      const inputs = await adapter.fetch(controller.signal);
      return { observations: inputs.slice(0, adapter.maxRequests).map(normalizeExternalObservation), degraded: false };
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    finally { clearTimeout(timer); }
    if (attempt < adapter.retry.attempts) await new Promise(resolve => setTimeout(resolve, Math.min(adapter.retry.backoffMs * 2 ** attempt, 2_000)));
  }
  return { observations: [], degraded: true, error: lastError };
}

export interface MaterializationCaps { global: number; perSourceFamily: number; perCountry: number }
export function selectBoundedOsintEvidence(aggregates: OsintEvidenceAggregate[], caps: MaterializationCaps): OsintEvidenceAggregate[] {
  const eligible = aggregates.filter(a => a.eligible);
  const selected: OsintEvidenceAggregate[] = [];
  const sourceCounts = new Map<string, number>(); const countryCounts = new Map<string, number>();
  // Round-robin sorted country/family buckets prevents a noisy source or large country monopolizing the cycle.
  const buckets = new Map<string, OsintEvidenceAggregate[]>();
  for (const a of eligible) { const key = `${a.country}|${a.sourceFamilies[0]}`; buckets.set(key, [...(buckets.get(key)||[]), a]); }
  const keys = [...buckets.keys()].sort();
  while (selected.length < caps.global) {
    let progressed = false;
    for (const key of keys) {
      const bucket = buckets.get(key)!; const candidate = bucket.shift(); if (!candidate) continue;
      const family = candidate.sourceFamilies[0];
      if ((sourceCounts.get(family)||0) >= caps.perSourceFamily || (countryCounts.get(candidate.country)||0) >= caps.perCountry) continue;
      selected.push(candidate); sourceCounts.set(family,(sourceCounts.get(family)||0)+1); countryCounts.set(candidate.country,(countryCounts.get(candidate.country)||0)+1); progressed = true;
      if (selected.length >= caps.global) break;
    }
    if (!progressed) break;
  }
  return selected;
}

export function buildExternalOsintProposal(evidence: OsintEvidenceAggregate, revision: number): DiscoveryFrontierProposal {
  const evidenceChecksum = checksum(evidence);
  return buildFrontierProposal({ proposalFamily:'EXTERNAL_OSINT', country:evidence.country, language:evidence.language, concept:evidence.canonicalConcept, primaryTermFamily:evidence.canonicalConcept, retrievalLane:'VIDEO', sourceFamily:'automated_query', sourceProvenance:`external_osint:${evidence.observationIds.join(',')}`, supportingEvidence:{ canonicalConcept:evidence.canonicalConcept, originalSurfaces:evidence.originalSurfaces, country:evidence.country, language:evidence.language, script:evidence.script, sourceFamilies:evidence.sourceFamilies, observationIds:evidence.observationIds, confidence:evidence.confidence, independentSourceCount:evidence.independentSourceCount, newestObservedAt:evidence.newestObservedAt, evidenceRevision:revision, evidenceChecksum, expiresAt:new Date(Date.parse(evidence.newestObservedAt)+FRESHNESS_DAYS*86_400_000).toISOString() }, confidence:evidence.confidence, noveltyRationale:'Independently corroborated, validated external OSINT discovery concept.', ttlDays:FRESHNESS_DAYS, preserveCountryIdentity:true });
}

export async function persistExternalOsintProposal(proposal: DiscoveryFrontierProposal, runner?: Queryable): Promise<boolean> {
  const db=runner||await getDb(); const d=proposal.targetDimensions;
  await db.query(`INSERT INTO discovery_neighborhoods(neighborhood_key,neighborhood_checksum,country,language,query_intent,primary_term_family,retrieval_lane,search_ordering,instrument_or_theme,source_family,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}') ON CONFLICT(neighborhood_key) DO NOTHING`,[proposal.targetNeighborhoodKey,createNeighborhoodChecksum(proposal.targetNeighborhoodKey!),d.country,d.language,d.queryIntent,d.primaryTermFamily,d.retrievalLane,d.searchOrdering,d.instrumentOrTheme,d.sourceFamily]);
  const result=await db.query(`INSERT INTO frontier_discovery_proposals(dedup_key,proposal_family,country,language,concept,target_neighborhood_key,target_dimensions,source_provenance,supporting_evidence,confidence,novelty_rationale,trial_status,expires_at) VALUES($1,'EXTERNAL_OSINT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(dedup_key) DO UPDATE SET source_provenance=excluded.source_provenance,supporting_evidence=excluded.supporting_evidence,confidence=excluded.confidence,expires_at=excluded.expires_at WHERE frontier_discovery_proposals.proposal_family='EXTERNAL_OSINT' AND frontier_discovery_proposals.trial_status NOT IN ('TRIED','EXPIRED') AND COALESCE((excluded.supporting_evidence->>'evidenceRevision')::numeric,0)>COALESCE((frontier_discovery_proposals.supporting_evidence->>'evidenceRevision')::numeric,0)`,[proposal.dedupKey,proposal.country,proposal.language,proposal.concept,proposal.targetNeighborhoodKey,JSON.stringify(proposal.targetDimensions),proposal.sourceProvenance,JSON.stringify(proposal.supportingEvidence),proposal.confidence,proposal.noveltyRationale,proposal.trialStatus,proposal.expiresAt]); return result.rowCount===1;
}

export async function materializeExternalOsintProposals(options: { enabled:boolean; observations:ExternalOsintObservation[]; caps?:Partial<MaterializationCaps>; deadlineMs?:number; runner?:Queryable; now?:Date }): Promise<number> {
  if (!options.enabled) return 0;
  const deadline = options.deadlineMs ?? 5_000;
  const work = async () => {
    const chosen=selectBoundedOsintEvidence(aggregateOsintEvidence(options.observations,options.now),{global:options.caps?.global??20,perSourceFamily:options.caps?.perSourceFamily??5,perCountry:options.caps?.perCountry??4});
    const results=await Promise.all(chosen.map((e,i)=>persistExternalOsintProposal(buildExternalOsintProposal(e,Date.parse(e.newestObservedAt)+i),options.runner)));
    return results.filter(Boolean).length;
  };
  return Promise.race([work(),new Promise<number>((_,reject)=>setTimeout(()=>reject(new Error('OSINT_MATERIALIZATION_DEADLINE')),deadline))]);
}

export async function materializeStoredExternalOsintProposals(options:{enabled:boolean;deadlineMs?:number;runner?:Queryable}):Promise<number>{
  if(!options.enabled)return 0; const db=options.runner||await getDb();
  const rows=await db.query(`SELECT observation_id,source_id,source_family,source_url,external_id,fetched_at,observed_at,country,locale,language,script,original_surface,canonical_concept,extraction_method,extraction_version,confidence,reliability,relevance,supporting_evidence,content_checksum,correlation_key FROM external_osint_observations WHERE observed_at>now()-interval '30 days' ORDER BY observed_at DESC,observation_id LIMIT 1000`);
  const observations:ExternalOsintObservation[]=rows.rows.map((r:any)=>({observationId:r.observation_id,sourceId:r.source_id,sourceFamily:r.source_family,sourceUrl:r.source_url,externalId:r.external_id,fetchedAt:new Date(r.fetched_at).toISOString(),observedAt:new Date(r.observed_at).toISOString(),country:r.country,locale:r.locale,language:r.language,script:r.script,surface:r.original_surface,canonicalConcept:r.canonical_concept,extractionMethod:r.extraction_method,extractionVersion:r.extraction_version,confidence:Number(r.confidence),reliability:Number(r.reliability),relevance:Number(r.relevance),supportingEvidence:r.supporting_evidence,contentChecksum:r.content_checksum,correlationKey:r.correlation_key}));
  return materializeExternalOsintProposals({enabled:true,observations,deadlineMs:options.deadlineMs,runner:db});
}

export function isOsintSnapshotFresh(snapshot: Record<string, any>, now=new Date()): boolean {
  if (snapshot.proposalFamily !== 'EXTERNAL_OSINT') return true;
  const evidence=snapshot.supportingEvidence||{}; return Array.isArray(evidence.observationIds) && evidence.observationIds.length>=2 && Date.parse(evidence.expiresAt)>now.getTime();
}

export async function attributeExternalOsintOutcome(input:{ decisionId:string; queryRunId:string; quotaConsumed:number; rawResults:number; distinctCreators:number; newCreators:number; relevantNewCreators:number; qualityNewCreators:number; confirmedCreators:number; wrongCountryResults?:number; coverageExpansion?:number },runner?:Queryable):Promise<boolean>{
  const db=runner||await getDb();
  const result=await db.query(`INSERT INTO external_osint_performance_attribution(attribution_key,proposal_id,allocation_decision_id,query_run_id,source_families,canonical_concept,country,evidence_snapshot,quota_consumed,raw_results,distinct_creators,new_creators,relevant_new_creators,quality_new_creators,confirmed_creators,wrong_country_results,coverage_expansion,yield_score) SELECT encode(digest(d.decision_id||':'||$2,'sha256'),'hex'),d.proposal_id,d.decision_id,$2,(d.proposal_evidence_snapshot->'supportingEvidence'->'sourceFamilies'),d.proposal_evidence_snapshot->'supportingEvidence'->>'canonicalConcept',d.selected_country,d.proposal_evidence_snapshot,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $3>0 THEN $8::float/$3 ELSE 0 END FROM frontier_allocation_decisions d WHERE d.decision_id=$1 AND d.proposal_evidence_snapshot->>'proposalFamily'='EXTERNAL_OSINT' ON CONFLICT(attribution_key) DO NOTHING`,[input.decisionId,input.queryRunId,input.quotaConsumed,input.rawResults,input.distinctCreators,input.newCreators,input.relevantNewCreators,input.qualityNewCreators,input.confirmedCreators,input.wrongCountryResults||0,input.coverageExpansion||0]);
  return result.rowCount===1;
}
