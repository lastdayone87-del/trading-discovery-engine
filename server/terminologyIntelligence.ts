import type { Pool, PoolClient } from 'pg';
import type { QueryRecord } from '../src/types';
import type { QueryFunnelMetrics } from './queryPerformance';
import { getDb } from './db';
import {
  computeEvidenceChecksum,
  computeObservationKey,
  detectCodeSwitching,
  inferScript,
  recomputeNativeEvidenceProjection,
  type NativeEvidenceStatus,
  type SourceProvenanceFamily
} from './countryNativeIntelligence';

export { inferScript } from './countryNativeIntelligence';

type Queryable = Pool | PoolClient | { query: (sql: string, params?: any[]) => Promise<any> };

export type TerminologyLifecycle = 'CANDIDATE' | 'OBSERVED' | 'MULTI_CREATOR_VALIDATED' | 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' | 'DEMOTED';
export type TerminologyObservationType = 'CHANNEL_NAME' | 'VIDEO_TITLE' | 'DESCRIPTION' | 'ENRICHMENT' | 'HUMAN_APPROVED_CHANNEL';
export type TerminologyTermType = 'TERMINOLOGY' | 'INSTRUMENT' | 'PHRASE' | 'FORMAT' | 'BRAND';

export interface TerminologyPolicy {
  halfLifeDays: number;
  observedEvidence: number;
  validationCreators: number;
  validationCommunities: number;
  trialEvidence: number;
  provenExecutions: number;
  provenYield: number;
  demotionExecutions: number;
  demotionYield: number;
}

export const DEFAULT_TERMINOLOGY_POLICY: TerminologyPolicy = {
  halfLifeDays: 90, observedEvidence: 1, validationCreators: 3, validationCommunities: 2,
  trialEvidence: 5, provenExecutions: 3, provenYield: 0.28, demotionExecutions: 5, demotionYield: 0.08
};

export function normalizeTerm(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en');
}

export function decayWeight(observedAt: Date, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, now.getTime() - observedAt.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

export function decideLifecycle(input: { current: TerminologyLifecycle; decayedEvidence: number; distinctCreators: number; distinctCommunities: number; executions: number; decayedYield: number; termType: TerminologyTermType }, policy = DEFAULT_TERMINOLOGY_POLICY): { status: TerminologyLifecycle; searchEligible: boolean; reason: string } {
  if (input.executions >= policy.demotionExecutions && input.decayedYield < policy.demotionYield)
    return { status: 'DEMOTED', searchEligible: false, reason: 'Sustained production yield fell below the configured demotion threshold.' };
  if (input.termType === 'BRAND') return { status: input.decayedEvidence >= policy.observedEvidence ? 'OBSERVED' : 'CANDIDATE', searchEligible: false, reason: 'Branding evidence is retained but cannot automatically become a search term.' };
  if (input.executions >= policy.provenExecutions && input.decayedYield >= policy.provenYield)
    return { status: 'PROVEN_SEARCH_TERM', searchEligible: true, reason: 'Repeated executions produced sufficient time-decayed net-new creator yield.' };
  if (input.distinctCreators >= policy.validationCreators && input.distinctCommunities >= policy.validationCommunities && input.decayedEvidence >= policy.trialEvidence)
    return { status: 'SEARCH_TRIAL', searchEligible: true, reason: 'Diverse creator and community evidence qualifies the term for controlled exploration.' };
  if (input.distinctCreators >= policy.validationCreators && input.distinctCommunities >= policy.validationCommunities)
    return { status: 'MULTI_CREATOR_VALIDATED', searchEligible: false, reason: 'Independent creator and community diversity requirements were met.' };
  if (input.decayedEvidence >= policy.observedEvidence) return { status: 'OBSERVED', searchEligible: false, reason: 'Durable normalized evidence has been observed.' };
  return { status: 'CANDIDATE', searchEligible: false, reason: 'Evidence remains below the observation threshold.' };
}

export async function observeTerminology(args: {
  term: string;
  country: string;
  language?: string;
  termType: TerminologyTermType;
  observationType: TerminologyObservationType;
  channelId?: string;
  videoId?: string;
  humanApproved?: boolean;
  humanApprovalId?: string;
  communityFingerprint?: string;
  evidence?: Record<string, unknown>;
  sourceCreatorCountry?: string | null;
  targetMarketCountry?: string | null;
  locale?: string;
  nativeEvidenceStatus?: NativeEvidenceStatus | null;
  sourceProvenanceFamily?: SourceProvenanceFamily | null;
  sourceEvidenceId?: string;
}, clientOverride?: Queryable): Promise<number | null> {
  const canonical = args.term.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const normalized = normalizeTerm(canonical);
  if (normalized.length < 2 || normalized.length > 80) return null;

  const isVideoBacked = Boolean(args.videoId && args.videoId.trim() !== '');
  const checksum = computeEvidenceChecksum(args.evidence);
  const hasEvidenceId = Boolean((args.sourceEvidenceId && args.sourceEvidenceId.trim() !== '') || checksum !== '');

  // For non-video observation types, fail closed if no stable source evidence identity is present
  if (!isVideoBacked && !hasEvidenceId && args.observationType !== 'CHANNEL_NAME') {
    return null;
  }

  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return null;

  // A Pool does not bind sequential queries to one connection. Own a transaction
  // so an observation, lifecycle refresh, and native projection either all
  // commit or all roll back; PoolClient/test runners continue directly.
  if ('connect' in runner && typeof (runner as Pool).connect === 'function' && !('release' in runner)) {
    const client = await (runner as Pool).connect();
    try {
      await client.query('BEGIN');
      const result = await observeTerminology(args, client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const contextLang = args.locale ? args.locale.split('-')[0] : args.language || 'und';
  const codeSwitching = detectCodeSwitching(canonical, contextLang);
  const weight = args.humanApproved ? 2.5 : args.observationType === 'ENRICHMENT' ? 1.25 : 1;

  // 1. Insert or fetch canonical trading term WITHOUT advancing last_observed_at on conflict
  const saved = await runner.query(
    `INSERT INTO canonical_trading_terms(canonical_term, normalized_term, country, language, script, term_type, first_observed_at, last_observed_at)
     VALUES($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT(country, normalized_term) DO NOTHING
     RETURNING id`,
    [canonical, normalized, args.country.toUpperCase(), contextLang, inferScript(canonical), args.termType]
  );

  let termId: number;
  if (saved.rows && saved.rows[0]) {
    termId = Number(saved.rows[0].id);
  } else {
    const existing = await runner.query(
      `SELECT id FROM canonical_trading_terms WHERE country = $1 AND normalized_term = $2`,
      [args.country.toUpperCase(), normalized]
    );
    if (!existing.rows || !existing.rows[0]) return null;
    termId = Number(existing.rows[0].id);
  }

  // 2. Resolve native creator/locale evidence status
  let resolvedCreatorCountry: string | null = args.sourceCreatorCountry ? args.sourceCreatorCountry.toUpperCase() : null;
  let resolvedMarketCountry: string | null = args.targetMarketCountry ? args.targetMarketCountry.toUpperCase() : null;

  if (!resolvedCreatorCountry && args.channelId) {
    const channelRes = await runner.query(
      `SELECT country FROM channels WHERE channel_id = $1`,
      [args.channelId]
    ).catch(() => ({ rows: [] }));

    if (channelRes.rows && channelRes.rows[0] && channelRes.rows[0].country) {
      resolvedCreatorCountry = String(channelRes.rows[0].country).toUpperCase();
    }
  }

  let resolvedNativeStatus: NativeEvidenceStatus | null = args.nativeEvidenceStatus || null;
  let resolvedProvenanceFamily: SourceProvenanceFamily | null = args.sourceProvenanceFamily || null;

  if (!resolvedNativeStatus && resolvedCreatorCountry && resolvedCreatorCountry === args.country.toUpperCase()) {
    resolvedNativeStatus = 'NATIVE_OBSERVED';
    resolvedProvenanceFamily = 'CREATOR_METADATA';
  }

  // 3. Compute deterministic observation key for single-write idempotency
  const obsKey = computeObservationKey({
    canonicalTermId: termId,
    channelId: args.channelId,
    videoId: args.videoId,
    observationType: args.observationType,
    nativeEvidenceStatus: resolvedNativeStatus,
    sourceProvenanceFamily: resolvedProvenanceFamily,
    sourceEvidenceId: args.sourceEvidenceId,
    evidence: args.evidence
  });

  // 4. Perform single, authoritative observation write
  const obsInsert = await runner.query(
    `INSERT INTO terminology_observations(
       canonical_term_id, source_channel_id, source_video_id, observation_type,
       human_approval_id, human_approved, community_fingerprint, evidence_weight, evidence,
       source_creator_country, target_market_country, locale, is_code_switched,
       native_language, term_language, native_evidence_status, source_provenance_family, code_switch_type,
       observation_key
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT(observation_key) DO NOTHING
     RETURNING id, observed_at`,
    [
      termId,
      args.channelId || null,
      args.videoId || null,
      args.observationType,
      args.humanApprovalId || null,
      Boolean(args.humanApproved),
      args.communityFingerprint || null,
      weight,
      JSON.stringify(args.evidence || {}),
      resolvedCreatorCountry,
      resolvedMarketCountry,
      args.locale || args.language || 'und',
      codeSwitching.isCodeSwitched,
      codeSwitching.dominantLanguage, // Context / native language (e.g. de)
      codeSwitching.termLanguage,     // Embedded term language (e.g. en)
      resolvedNativeStatus,           // NATIVE_OBSERVED | BOOTSTRAP_SEED | TRANSLATED_SEED | NULL
      resolvedProvenanceFamily,
      codeSwitching.codeSwitchType,
      obsKey
    ]
  );

  // 5. Invoke authoritative terminology lifecycle refresh & projection recompute ONLY if a new observation row was actually inserted!
  if (obsInsert.rows && obsInsert.rows.length > 0) {
    const obsAt = obsInsert.rows[0].observed_at || new Date().toISOString();
    await runner.query(
      `UPDATE canonical_trading_terms
       SET last_observed_at = GREATEST(last_observed_at, $2)
       WHERE id = $1`,
      [termId, obsAt]
    );
    await refreshTerminologyLifecycle(termId, DEFAULT_TERMINOLOGY_POLICY, runner);
    await recomputeNativeEvidenceProjection(termId, runner);
  }

  return termId;
}

export async function addTerminologyAlias(canonicalTermId: number, alias: string, aliasType: 'ABBREVIATION' | 'SPELLING' | 'TRANSLITERATION' | 'SHORTHAND' | 'REGIONAL' | 'SPELLING_VARIANT', language = 'und', clientOverride?: Queryable): Promise<void> {
  const normalized = normalizeTerm(alias);
  if (normalized.length < 2) return;
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  await runner.query(`INSERT INTO trading_term_aliases(canonical_term_id,alias,normalized_alias,language,script,alias_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(canonical_term_id,normalized_alias) DO NOTHING`, [canonicalTermId, alias.normalize('NFKC').trim(), normalized, language, inferScript(alias), aliasType]);
}

export async function refreshTerminologyLifecycle(termId: number, policy = DEFAULT_TERMINOLOGY_POLICY, clientOverride?: Queryable): Promise<void> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  const result = await runner.query(`SELECT t.*, COALESCE(o.distinct_creators,0)::int distinct_creators, COALESCE(o.distinct_communities,0)::int distinct_communities,
    COALESCE(o.human_approved,0)::int human_approved, COALESCE(o.decayed_evidence,0)::float decayed_evidence,
    COALESCE(p.executions,0)::int executions, COALESCE(p.decayed_yield,0)::float decayed_yield
    FROM canonical_trading_terms t LEFT JOIN LATERAL (SELECT COUNT(DISTINCT source_channel_id) FILTER (WHERE source_channel_id IS NOT NULL) distinct_creators,
      COUNT(DISTINCT community_fingerprint) FILTER (WHERE community_fingerprint IS NOT NULL) distinct_communities, COUNT(DISTINCT source_channel_id) FILTER (WHERE human_approved) human_approved,
      SUM(evidence_weight * power(0.5, EXTRACT(EPOCH FROM (now()-observed_at))/86400/$2)) decayed_evidence FROM terminology_observations WHERE canonical_term_id=t.id) o ON true
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(executions),0) executions, COALESCE(SUM(decayed_yield_score*executions)/NULLIF(SUM(executions),0),0) decayed_yield FROM terminology_performance WHERE canonical_term_id=t.id) p ON true WHERE t.id=$1`, [termId, policy.halfLifeDays]);
  if (!result.rows[0]) return;
  const row = result.rows[0];
  const decision = decideLifecycle({ current: row.lifecycle_status, decayedEvidence: row.decayed_evidence, distinctCreators: row.distinct_creators, distinctCommunities: row.distinct_communities, executions: row.executions, decayedYield: row.decayed_yield, termType: row.term_type }, policy);
  if (decision.status !== row.lifecycle_status || decision.searchEligible !== row.search_eligible) {
    await runner.query('UPDATE canonical_trading_terms SET lifecycle_status=$2,search_eligible=$3,trust_tier=$4 WHERE id=$1', [termId, decision.status, decision.searchEligible, decision.status === 'PROVEN_SEARCH_TERM' ? 1 : decision.searchEligible ? 2 : 3]);
    await runner.query(`INSERT INTO terminology_lifecycle_events(canonical_term_id,from_status,to_status,event_type,reason,evidence_snapshot) VALUES($1,$2,$3,$4,$5,$6)`, [termId, row.lifecycle_status, decision.status, decision.status === 'DEMOTED' ? 'DEMOTION' : 'PROMOTION', decision.reason, JSON.stringify({ distinctCreators: row.distinct_creators, distinctCommunities: row.distinct_communities, executions: row.executions, decayedEvidence: row.decayed_evidence, decayedYield: row.decayed_yield })]);
  }
  await runner.query(`INSERT INTO terminology_score_snapshots(canonical_term_id,distinct_creators,distinct_communities,human_approved_creators,decayed_evidence,decayed_yield_score,lifecycle_status,configuration) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [termId, row.distinct_creators, row.distinct_communities, row.human_approved, row.decayed_evidence, row.decayed_yield, decision.status, JSON.stringify(policy)]);
}

export async function attributeTerminologyPerformance(query: QueryRecord, metrics: QueryFunnelMetrics, quotaConsumed = 0, retrievalLane?: string, searchOrdering?: string, clientOverride?: Queryable): Promise<void> {
  const metadata = query.generation_metadata || {};
  const learned = typeof metadata.learnedTerm === 'string' ? normalizeTerm(metadata.learnedTerm) : null;
  if (!learned) return;
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return;
  const terms = await runner.query('SELECT id FROM canonical_trading_terms WHERE country=$1 AND normalized_term=$2', [query.country, learned]);
  for (const row of terms.rows) {
    const yieldScore = metrics.distinctResults ? metrics.newChannels / metrics.distinctResults : 0;
    await runner.query(`INSERT INTO terminology_performance(canonical_term_id,query_id,retrieval_lane,search_ordering,raw_results,unique_creators,new_creators,confirmed_trading_creators,needs_review_creators,non_trading_creators,wrong_country_creators,communities_discovered,quota_consumed,decayed_yield_score) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [row.id, query.id, String(retrievalLane || metadata.retrievalLane || 'UNKNOWN'), String(searchOrdering || metadata.searchOrdering || 'RELEVANCE'), metrics.rawResults, metrics.distinctResults, metrics.newChannels, metrics.tradingConfirmed, metrics.needsReview, metrics.nonTrading, metrics.countryRejected, metrics.communitiesDiscovered, quotaConsumed, yieldScore]);
    await refreshTerminologyLifecycle(Number(row.id), DEFAULT_TERMINOLOGY_POLICY, runner);
  }
}

export async function getTerminologyDashboard(country?: string, clientOverride?: Queryable): Promise<unknown[]> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return [];
  const result = await runner.query(`SELECT t.*, COALESCE(a.aliases,'[]'::json) aliases, COALESCE(o.distinct_creators,0)::int distinct_creator_count,
    COALESCE(p.executions,0)::int executions, COALESCE(p.new_creators,0)::int new_creators, COALESCE(p.decayed_yield_score,0)::float decayed_yield_score,
    COALESCE(p.lanes,'{}'::json) retrieval_lanes, COALESCE(e.history,'[]'::json) lifecycle_history
    FROM canonical_trading_terms t
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('alias',alias,'type',alias_type,'language',language,'script',script)) aliases FROM trading_term_aliases WHERE canonical_term_id=t.id) a ON true
    LEFT JOIN LATERAL (SELECT COUNT(DISTINCT source_channel_id) distinct_creators FROM terminology_observations WHERE canonical_term_id=t.id) o ON true
    LEFT JOIN LATERAL (SELECT SUM(executions) executions,SUM(new_creators) new_creators,COALESCE(SUM(decayed_yield_score*executions)/NULLIF(SUM(executions),0),0) decayed_yield_score,json_object_agg(retrieval_lane,lane_yield) lanes FROM (SELECT retrieval_lane,SUM(executions) executions,SUM(new_creators) new_creators,AVG(decayed_yield_score) lane_yield FROM terminology_performance WHERE canonical_term_id=t.id GROUP BY retrieval_lane) x) p ON true
    LEFT JOIN LATERAL (SELECT json_agg(json_build_object('type',event_type,'from',from_status,'to',to_status,'reason',reason,'at',created_at) ORDER BY created_at DESC) history FROM terminology_lifecycle_events WHERE canonical_term_id=t.id) e ON true
    WHERE ($1::text IS NULL OR t.country=$1) ORDER BY t.search_eligible DESC,p.decayed_yield_score DESC,t.last_observed_at DESC NULLS LAST`, [country || null]);
  return result.rows;
}

export async function getPlannerTerminology(country: string, clientOverride?: Queryable): Promise<Array<{ id: number; term: string; score: number; lifecycle: 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' }>> {
  const runner = clientOverride || (process.env.DATABASE_URL ? await getDb() : null);
  if (!runner) return [];
  const result = await runner.query(`SELECT t.id,t.canonical_term term,t.lifecycle_status,COALESCE(AVG(p.decayed_yield_score),0)::float score FROM canonical_trading_terms t LEFT JOIN terminology_performance p ON p.canonical_term_id=t.id WHERE t.country=$1 AND t.search_eligible=true AND t.lifecycle_status IN ('SEARCH_TRIAL','PROVEN_SEARCH_TERM') GROUP BY t.id ORDER BY score DESC,t.last_observed_at DESC NULLS LAST LIMIT 50`, [country]);
  return result.rows.map(row => ({ id: Number(row.id), term: row.term, score: Number(row.score), lifecycle: row.lifecycle_status as 'SEARCH_TRIAL' | 'PROVEN_SEARCH_TERM' }));
}
