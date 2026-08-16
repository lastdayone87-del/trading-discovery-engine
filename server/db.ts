import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ChannelRecord, CountryVocabulary, ExcludedCountry, QueueStatus, QueryRecord, QueryExecutionLog, ExtractedTermRecord, DiscoverySource } from '../src/types';
import { INITIAL_COUNTRY_VOCABULARIES, INITIAL_EXCLUDED_COUNTRIES } from '../src/data/initial_countries';
import { allocateRetrievalLane, RetrievalLane } from './retrievalLanes';
import { allocateSearchOrdering, SearchOrdering } from './searchOrdering';
import { calculateYouTubeDailyBudget } from './quotaPolicy';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';
import { getConfiguredYouTubeKeys } from './youtubeKeyPool';
import { youtubeProviderCooldown, type YouTubeProviderOperationalStatus } from './youtubeProviderCooldown';
import type { AuditEvent } from './operatorAuth';
import type { ProviderCallEvent } from './providerResilience';
import { validateLedgerInput, type ValidationKind, type ValidationStatus } from './phase3Validation';
import { assertMinimalPayload, compareMetrics, replayFunnel, REPLAY_FEATURE_VERSION, REPLAY_POLICY_VERSION, type FunnelMetrics, type OutcomeEventType, type VerificationStatus } from './replayMeasurement';

const { Pool } = pg;
const MIGRATIONS_DIR = path.join(process.cwd(), 'server', 'db', 'migrations');
// One database-wide lock serializes deploy-time migrations across Railway replicas.
const MIGRATION_ADVISORY_LOCK = 741963284;

let pool: InstanceType<typeof Pool> | null = null;
let initPromise: Promise<InstanceType<typeof Pool>> | null = null;

const TRANSIENT_PG_STARTUP_CODES = new Set(['57P03','57P01','53300','08000','08001','08003','08006']);
const TRANSIENT_PG_NETWORK_CODES = new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH']);

function isTransientPostgresStartupError(error: any): boolean {
  const code = String(error?.code || '');
  if (TRANSIENT_PG_STARTUP_CODES.has(code) || TRANSIENT_PG_NETWORK_CODES.has(code)) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('database system is starting up') ||
    message.includes('consistent recovery state has not been yet reached') ||
    message.includes('cannot connect now') ||
    message.includes('the database system is in recovery mode');
}

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForPostgresReady(db: InstanceType<typeof Pool>): Promise<void> {
  const configuredMaxWaitMs = Number(process.env.POSTGRES_STARTUP_MAX_WAIT_MS || '300000');
  const maxWaitMs = Number.isFinite(configuredMaxWaitMs) && configuredMaxWaitMs >= 30_000 ? configuredMaxWaitMs : 300_000;
  const started = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await db.query('SELECT 1');
      if (attempt > 1) console.log(`[PostgreSQL] Ready after ${attempt} startup checks.`);
      return;
    } catch (error: any) {
      if (!isTransientPostgresStartupError(error)) throw error;
      const elapsed = Date.now() - started;
      if (elapsed >= maxWaitMs) {
        console.error(`[PostgreSQL] Still unavailable after ${elapsed}ms; giving up startup retry.`, { code: error?.code, message: error?.message });
        throw error;
      }
      const delayMs = Math.min(10_000, 1_000 * Math.pow(2, Math.min(attempt - 1, 3)));
      console.warn(`[PostgreSQL] Database temporarily unavailable during startup (code=${error?.code || 'unknown'}). Retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required. SQL.js fallback is disabled for Phase 1 PostgreSQL runtime. Run npm run migrate:sqljs after configuring PostgreSQL.');
  }
  return url;
}

export async function getDb(): Promise<InstanceType<typeof Pool>> {
  // `pool` is assigned before connectivity checks, migrations, and default-data
  // seeding finish. Always join an in-flight initialization before exposing it;
  // otherwise concurrent HTTP/startup callers can query a partially migrated
  // database and make readiness fail permanently for an otherwise healthy DB.
  if (initPromise) return initPromise;
  if (pool) return pool;
  initPromise = (async () => {
    const connectionString = requireDatabaseUrl();
    pool = new Pool({ connectionString, ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
    try {
      await waitForPostgresReady(pool);
      await runMigrations();
      await seedDefaults();
      return pool;
    } catch (error) {
      const failedPool = pool;
      pool = null;
      initPromise = null;
      await failedPool.end().catch(() => undefined);
      throw error;
    }
  })();
  return initPromise;
}

export function saveDb(): void {
  // PostgreSQL commits writes transactionally; retained as no-op compatibility shim.
}

export async function appendOperatorAuditEvent(event: AuditEvent): Promise<void> { const db=await getDb(); await db.query(`INSERT INTO operator_audit_events(actor_identifier,actor_hash,role,action,target,request_id,outcome,safe_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(request_id,action,target,outcome) DO NOTHING`,[event.actorId||null,event.actorHash||null,event.role||null,event.action,event.target,event.requestId,event.outcome,JSON.stringify(event.metadata||{})]); }
export async function getOperatorAuditEvents(limit=100):Promise<any[]>{const db=await getDb();const res=await db.query(`SELECT id,actor_identifier,actor_hash,role,action,target,request_id,outcome,safe_metadata,created_at FROM operator_audit_events ORDER BY created_at DESC LIMIT $1`,[Math.min(Math.max(limit,1),500)]);return res.rows;}
export async function appendProviderCallEvent(event:ProviderCallEvent):Promise<void>{const db=await getDb();await db.query(`INSERT INTO provider_call_events(id,provider,operation,request_id,run_id,job_id,attempt,status,latency_ms,reserved_cost,actual_cost,error_class,policy_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING`,[event.id,event.provider,event.operation,event.requestId||null,event.runId||null,event.jobId||null,event.attempt,event.status,event.latencyMs,event.reservedCost,event.actualCost,event.errorClass||null,event.policyVersion,event.occurredAt]);}
export interface DiscordAttemptCandidate {candidateId?:string;rawLocator?:string;locatorType?:string;resolvedLocator?:string;sourceSurface?:string;sourceUrl?:string}
export async function appendDiscordCheckAttempts(channelId:string,inviteLocator:string,semanticStatus:string,attempts:Array<{attemptNumber:number;operationalOutcome:string;retryable:boolean;httpStatus?:number;providerErrorClass?:string;providerErrorCode?:number;responseContentType?:string;reason:string;checkedAt:string}>,candidate:DiscordAttemptCandidate={}):Promise<void>{const db=await getDb();for(const attempt of attempts)await db.query(`INSERT INTO discord_check_attempts(attempt_key,channel_id,invite_locator,semantic_status,operational_outcome,retryable,attempt_number,http_status,provider_error_class,reason,provenance,policy_version,checked_at,candidate_id,raw_locator,locator_type,resolved_locator,source_surface,source_url,response_content_type,provider_error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'discord-check-policy-v2',$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT(attempt_key) DO NOTHING`,[`${channelId}:${attempt.checkedAt}:${attempt.attemptNumber}`,channelId,inviteLocator,semanticStatus,attempt.operationalOutcome,attempt.retryable,attempt.attemptNumber,attempt.httpStatus||null,attempt.providerErrorClass||null,attempt.reason,JSON.stringify({provider:'discord',operation:'invite-lookup',candidateLocatorPreserved:true}),attempt.checkedAt,candidate.candidateId||null,candidate.rawLocator||null,candidate.locatorType||null,candidate.resolvedLocator||inviteLocator,candidate.sourceSurface||null,candidate.sourceUrl||null,attempt.responseContentType||null,attempt.providerErrorCode||null]);}
export async function countDiscordInvalidObservations(channelId:string,candidateId:string|undefined,inviteLocator:string):Promise<number>{const db=await getDb();const result=await db.query(`SELECT count(*)::int count FROM discord_check_attempts WHERE channel_id=$1 AND (candidate_id=$2 OR (candidate_id IS NULL AND invite_locator=$3)) AND operational_outcome IN('INVALID_OBSERVED','CONFIRMED_INVALID')`,[channelId,candidateId||null,inviteLocator]);return Number(result.rows[0]?.count||0);}
export async function appendExternalAcquisitionObservations(channelId:string,observations:Array<{requestedUrl:string;finalUrl?:string;wrapperUrl?:string;surface:string;required:boolean;outcome:string;retryable:boolean;httpStatus?:number;failureClass?:string;detail:string;observedAt:string}>):Promise<void>{const db=await getDb();for(const [index,observation] of observations.entries())await db.query(`INSERT INTO external_acquisition_observations(observation_key,channel_id,requested_url,final_url,outcome,retryable,http_status,failure_class,detail,provenance,policy_version,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'external-community-acquisition-v2',$11) ON CONFLICT(observation_key) DO NOTHING`,[`${channelId}:${observation.observedAt}:${index}:${observation.requestedUrl}`,channelId,observation.requestedUrl,observation.finalUrl||null,observation.outcome,observation.retryable,observation.httpStatus||null,observation.failureClass||null,observation.detail,JSON.stringify({provider:'external-link',boundedDepth:2,surface:observation.surface,required:observation.required,wrapperUrl:observation.wrapperUrl||null}),observation.observedAt]);}
export async function getProviderOperationalMetrics(hours=24):Promise<any>{const db=await getDb();const bounded=Math.min(Math.max(hours,1),720);const [summary,queue]=await Promise.all([db.query(`SELECT provider,operation,COUNT(*)::int calls,COUNT(*) FILTER(WHERE status='SUCCESS')::int successes,COUNT(*) FILTER(WHERE status='TIMEOUT')::int timeouts,COUNT(*) FILTER(WHERE status NOT IN('SUCCESS','TIMEOUT'))::int errors,ROUND(AVG(latency_ms))::int average_latency_ms,COALESCE(SUM(reserved_cost),0)::float reserved_cost,COALESCE(SUM(actual_cost),0)::float actual_cost FROM provider_call_events WHERE occurred_at>=now()-($1||' hours')::interval GROUP BY provider,operation ORDER BY provider,operation`,[String(bounded)]),db.query(`SELECT type,COUNT(*)::int depth,COUNT(*) FILTER(WHERE run_after<=now())::int runnable_depth,COUNT(*) FILTER(WHERE run_after>now())::int deferred_depth,MIN(run_after) FILTER(WHERE run_after>now()) next_run_at,COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM(now()-created_at))*1000)),0)::bigint average_age_ms,COALESCE(ROUND(MAX(EXTRACT(EPOCH FROM(now()-created_at))*1000)),0)::bigint oldest_age_ms FROM jobs WHERE status='PENDING' GROUP BY type ORDER BY type`)]);return {windowHours:bounded,policyVersion:'provider-resilience-v1',providers:summary.rows,queueLatency:queue.rows,alertThresholds:{timeoutRate:Number(process.env.PROVIDER_TIMEOUT_ALERT_RATE||'0.05'),errorRate:Number(process.env.PROVIDER_ERROR_ALERT_RATE||'0.10')},runbook:'docs/phase-2-provider-resilience.md'};}

export async function appendValidationRun(run:{id:string;kind:ValidationKind;environment:string;status:ValidationStatus;policyVersion?:string;datasetVersion?:string;artifactChecksum:string;summary:unknown;startedAt:string;completedAt:string}):Promise<void>{validateLedgerInput(run);const db=await getDb();await db.query(`INSERT INTO validation_runs(id,kind,environment,status,policy_version,dataset_version,artifact_checksum,summary,started_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,[run.id,run.kind,run.environment,run.status,run.policyVersion||null,run.datasetVersion||null,run.artifactChecksum,JSON.stringify(run.summary),run.startedAt,run.completedAt]);}
export async function getValidationRuns(limit=100):Promise<any[]>{const db=await getDb();const res=await db.query(`SELECT id,kind,environment,status,policy_version,dataset_version,artifact_checksum,summary,started_at,completed_at,created_at FROM validation_runs ORDER BY created_at DESC LIMIT $1`,[Math.min(Math.max(limit,1),500)]);return res.rows;}

type EventClient={query:(sql:string,values?:any[])=>Promise<any>};
export interface MeasurementLineage {eventKey:string;subjectType:string;subjectId:string;eventType:string;sourceEventKey?:string;queryId?:number;queryRunId?:string;jobId?:string;country?:string;retrievalLane?:string;eventTime?:string;payload:Record<string,unknown>}
async function appendDecisionWith(client:EventClient,event:MeasurementLineage):Promise<void>{assertMinimalPayload(event.payload);await client.query(`INSERT INTO decision_events(event_key,subject_type,subject_id,event_type,event_version,source_event_key,query_id,query_run_id,job_id,country,retrieval_lane,policy_version,feature_version,event_time,payload) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(event_key) DO NOTHING`,[event.eventKey,event.subjectType,event.subjectId,event.eventType,event.sourceEventKey||null,event.queryId||null,event.queryRunId||null,event.jobId||null,event.country||null,event.retrievalLane||null,REPLAY_POLICY_VERSION,REPLAY_FEATURE_VERSION,event.eventTime||new Date().toISOString(),JSON.stringify(event.payload)]);}
async function appendOutcomeWith(client:EventClient,event:MeasurementLineage&{eventType:OutcomeEventType;verificationStatus:VerificationStatus}):Promise<void>{assertMinimalPayload(event.payload);await client.query(`INSERT INTO outcome_events(event_key,subject_type,subject_id,event_type,event_version,source_event_key,query_id,query_run_id,job_id,country,retrieval_lane,verification_status,policy_version,feature_version,event_time,payload) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(event_key) DO NOTHING`,[event.eventKey,event.subjectType,event.subjectId,event.eventType,event.sourceEventKey||null,event.queryId||null,event.queryRunId||null,event.jobId||null,event.country||null,event.retrievalLane||null,event.verificationStatus,REPLAY_POLICY_VERSION,REPLAY_FEATURE_VERSION,event.eventTime||new Date().toISOString(),JSON.stringify(event.payload)]);}
export async function appendDecisionEvent(event:MeasurementLineage):Promise<void>{return appendDecisionWith(await getDb(),event);}
export async function appendOutcomeEvent(event:MeasurementLineage&{eventType:OutcomeEventType;verificationStatus:VerificationStatus}):Promise<void>{return appendOutcomeWith(await getDb(),event);}

/** Authorized report only; it is read-only and never invokes a provider. Legacy aggregates remain authoritative. */
export async function getReplayReport(from:string,to:string,tolerance=0):Promise<any>{
  const start=new Date(from),end=new Date(to);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end<start)throw new Error('Replay window is invalid.');
  const db=await getDb();const [events,legacy]=await Promise.all([
    db.query(`SELECT event_key,subject_id,event_type,verification_status,event_time,recorded_at,country,retrieval_lane,payload FROM outcome_events WHERE event_time >= $1 AND event_time < $2 ORDER BY recorded_at,event_key`,[start.toISOString(),end.toISOString()]),
    db.query(`SELECT COALESCE(SUM(raw_results),0)::int "rawResults",COALESCE(SUM(distinct_results),0)::int "distinctResults",COALESCE(SUM(duplicate_results),0)::int "duplicateResults",COALESCE(SUM(known_channels),0)::int "knownChannels",COALESCE(SUM(new_channels),0)::int "newChannels",COALESCE(SUM(country_rejected),0)::int "countryRejected",COALESCE(SUM(non_trading),0)::int "nonTrading",COALESCE(SUM(uncertain),0)::int uncertain,COALESCE(SUM(needs_review),0)::int "needsReview",COALESCE(SUM(trading_confirmed),0)::int "tradingConfirmed",COALESCE(SUM(unique_channels),0)::int "uniqueChannels",COALESCE(SUM(quality_channels),0)::int "qualityChannels",COALESCE(SUM(communities_discovered),0)::int "communitiesDiscovered",COALESCE(SUM(quota_used),0)::int "quotaUsed" FROM query_runs WHERE status='COMPLETED' AND completed_at >= $1 AND completed_at < $2`,[start.toISOString(),end.toISOString()])
  ]);
  const replayed=replayFunnel(events.rows.map((r:any)=>({eventKey:r.event_key,subjectId:r.subject_id,eventType:r.event_type,verificationStatus:r.verification_status,eventTime:iso(r.event_time)!,recordedAt:iso(r.recorded_at)!,country:r.country,retrievalLane:r.retrieval_lane,payload:parseJson(r.payload,{})})));
  return {mode:'SHADOW',authoritativeSource:'legacy-query-aggregates',networkAccess:false,policyVersion:REPLAY_POLICY_VERSION,featureVersion:REPLAY_FEATURE_VERSION,window:{from:start.toISOString(),to:end.toISOString()},replay:replayed,reconciliation:compareMetrics(replayed.totals,legacy.rows[0] as FunnelMetrics,tolerance)};
}

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value as T;
}

function iso(value: any): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toString() === 'Invalid Date' ? String(value) : new Date(value).toISOString();
}

function normalizeQueryText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export async function runMigrations(): Promise<Array<{ version: number; name: string; applied_at: string }>> {
  const db = pool || new Pool({ connectionString: requireDatabaseUrl(), ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const versions=new Map<number,string>();
    for(const file of files){const version=Number(file.split('_')[0]);const previous=versions.get(version);if(previous)throw new Error(`Duplicate migration version ${version}: ${previous} and ${file}`);versions.set(version,file);}
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
      if (exists.rowCount) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version,name,applied_at) VALUES($1,$2,now())', [version, file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    const res = await client.query('SELECT version,name,applied_at FROM schema_migrations ORDER BY version');
    return res.rows.map(r => ({ version: r.version, name: r.name, applied_at: iso(r.applied_at)! }));
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]).catch(() => undefined);
    client.release();
    if (!pool) await db.end();
  }
}

async function seedDefaults(): Promise<void> {
  const db = await getDbNoInit();
  for (const q of ['search_jobs', 'channel_processing', 'discord_validation', 'recheck']) {
    await db.query(`INSERT INTO queue_controls(queue_name,is_paused) VALUES($1,false) ON CONFLICT(queue_name) DO NOTHING`, [q]);
  }
  const today = new Date().toISOString().split('T')[0];
  await db.query(`INSERT INTO quota_tracker(id,units_used,daily_limit,last_reset) VALUES('youtube',0,10000,$1) ON CONFLICT(id) DO NOTHING`, [today]);
  for (const v of INITIAL_COUNTRY_VOCABULARIES) await saveCountryVocabulary(v);
  const excl = await db.query('SELECT COUNT(*)::int AS count FROM excluded_countries');
  if (excl.rows[0].count === 0) {
    for (const e of INITIAL_EXCLUDED_COUNTRIES) await addExcludedCountry(e);
  }
  await db.query(`INSERT INTO scheduler_state(name,is_enabled,is_running) VALUES('autonomous_discovery',true,false) ON CONFLICT(name) DO NOTHING`);
}

async function getDbNoInit(): Promise<InstanceType<typeof Pool>> {
  if (!pool) throw new Error('PostgreSQL pool not initialized.');
  return pool;
}

function rowToChannel(row: any): ChannelRecord {
  return {
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    youtube_url: row.youtube_url,
    country: row.country,
    country_status: row.country_status,
    confidence_score: row.confidence_score || 0,
    discord_status: row.discord_status,
    discord_invite: row.discord_invite || null,
    scan_status: row.scan_status,
    scan_attempts: row.scan_attempts || 0,
    discovery_source: row.discovery_source,
    first_seen: iso(row.first_seen) || new Date().toISOString(),
    last_checked: iso(row.last_checked),
    inspection_trail: parseJson(row.inspection_trail, []),
    subscriber_count: row.subscriber_count || undefined,
    channel_thumbnail_url: row.channel_thumbnail_url || undefined,
    quality_score: row.quality_score || 0,
    quality_breakdown: parseJson(row.quality_breakdown, undefined),
    trading_status: row.trading_status || 'UNCERTAIN',
    trading_confidence_score: row.trading_confidence_score || 0,
    trading_category: row.trading_category || 'General Trading',
    trading_relevance_breakdown: parseJson(row.trading_relevance_breakdown, undefined),
    country_metadata_status: row.country_metadata_status || 'NOT_REQUESTED',
    country_metadata_checked_at: iso(row.country_metadata_checked_at),
    latest_upload_at: iso(row.latest_upload_at),
    uploads_last_30_days: row.uploads_last_30_days || 0,
    uploads_last_90_days: row.uploads_last_90_days || 0,
    uploads_last_365_days: row.uploads_last_365_days || 0,
    activity_band: row.activity_band || 'UNKNOWN', activity_score: row.activity_score ?? 50,
    activity_observed_at: iso(row.activity_observed_at),
    discord_discovery_status: row.discord_discovery_status || 'NOT_DISCOVERED',
    discord_candidate_locator: row.discord_candidate_locator || null,
    discord_candidate_id:row.discord_candidate_id||null,discord_candidate_raw_locator:row.discord_candidate_raw_locator||null,discord_candidate_type:row.discord_candidate_type||null,
    discord_resolution_status:row.discord_resolution_status||'NOT_ATTEMPTED',discord_liveness_status:row.discord_liveness_status||'NOT_CHECKED',discord_relevance_status:row.discord_relevance_status||'NOT_CHECKED',discord_validation_status:row.discord_validation_status||'NOT_STARTED',
    post_approval_job_status: row.post_approval_job_status || undefined,
    post_approval_job_error: row.post_approval_job_error || undefined
  };
}

export async function getAllChannels(): Promise<ChannelRecord[]> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM channels ORDER BY first_seen DESC');
  return res.rows.map(rowToChannel);
}

export interface ChannelListingFilter {includeRejected:boolean;diagnosticsOnly?:boolean;search?:string;country?:string;countryStatus?:string;tradingStatus?:string;discordStatus?:string;scanStatus?:string}
// This is the single definition of the operator-visible discovery corpus. Keep
// both the paginated listing and dashboard aggregates anchored to this policy.
// The NOT EXISTS check makes policy changes effective immediately, even for a
// channel whose denormalized validation statuses have not yet been refreshed.
export const OPERATOR_VISIBLE_CHANNEL_SQL = `country_status <> 'REJECTED'
  AND scan_status <> 'SKIPPED_EXCLUDED'
  AND trading_status <> 'NON_TRADING'
  AND NOT EXISTS (
    SELECT 1 FROM excluded_countries excluded
    WHERE lower(regexp_replace(trim(excluded.country_name), '\\s+', ' ', 'g')) =
      lower(regexp_replace(trim(channels.country), '\\s+', ' ', 'g'))
  )`;
async function dashboardServingPredicate(db:InstanceType<typeof Pool>):Promise<{predicate:string;scope:string}>{
  const result=await db.query(`SELECT s.setting_value,p.mode,p.activation_id,g.decision
    FROM app_settings s LEFT JOIN release5_rollout_projection p ON p.capability='DASHBOARD_CORPUS'
    LEFT JOIN decision_promotion_gates g ON g.id=p.promotion_gate_id
    WHERE s.setting_key='release5_dashboard_serving_mode'`);
  const control=result.rows[0];
  if(!control||control.setting_value==='OFF'||control.setting_value!==control.mode||control.decision!=='PROMOTE')return {predicate:OPERATOR_VISIBLE_CHANNEL_SQL,scope:'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS'};
  const projected=`EXISTS(SELECT 1 FROM dashboard_corpus_projection dcp WHERE dcp.channel_id=channels.channel_id AND dcp.corpus IN('CONFIRMED','REVIEW'))`;
  if(control.mode==='ACTIVE')return {predicate:projected,scope:'RELEASE5_ACTIVE_DASHBOARD_CORPUS'};
  const assigned=`EXISTS(SELECT 1 FROM release5_serving_assignments rsa WHERE rsa.capability='DASHBOARD_CORPUS' AND rsa.channel_id=channels.channel_id AND rsa.activation_id=(SELECT activation_id FROM release5_rollout_projection WHERE capability='DASHBOARD_CORPUS') AND rsa.assigned=true)`;
  return {predicate:`((${assigned}) AND (${projected}) OR (NOT (${assigned}) AND (${OPERATOR_VISIBLE_CHANNEL_SQL})))`,scope:'RELEASE5_CANARY_DASHBOARD_CORPUS'};
}
export function resolveChannelListingServingScope(defaultServing:{predicate:string;scope:string},includeRejected:boolean,diagnosticsOnly=false):{predicate:string;scope:string}{
  if(diagnosticsOnly)return {predicate:`NOT (${defaultServing.predicate})`,scope:`DIAGNOSTICS_ONLY:${defaultServing.scope}`};
  if(includeRejected)return {predicate:'TRUE',scope:'ALL_CHANNELS'};
  return defaultServing;
}
async function channelListingWhere(db:InstanceType<typeof Pool>,args:ChannelListingFilter):Promise<{where:string;values:string[];scope:string}> {
  const defaultServing=await dashboardServingPredicate(db);
  const serving=resolveChannelListingServingScope(defaultServing,args.includeRejected,Boolean(args.diagnosticsOnly));
  const clauses=[serving.predicate]; const values:string[]=[];
  // Low-audience rows are retained for auditability, but the normal operator
  // corpus should not be diluted by channels intentionally skipped for budget.
  // An explicit scan-status filter opts into this corpus.
  const explicitlyViewingLowAudience=args.scanStatus==='SKIPPED_LOW_AUDIENCE';
  if(!args.includeRejected&&!args.diagnosticsOnly&&!explicitlyViewingLowAudience)clauses.push(`scan_status <> 'SKIPPED_LOW_AUDIENCE' AND NOT (subscriber_count ~ '^[0-9]+$' AND subscriber_count::integer < 30)`);
  const add=(column:string,value:string|undefined)=>{if(value&&value!=='ALL'){values.push(value);clauses.push(`${column}=$${values.length}`);}};
  if(args.search){values.push(args.search);clauses.push(`(channel_name ILIKE '%'||$${values.length}||'%' OR youtube_url ILIKE '%'||$${values.length}||'%')`);}
  add('country',args.country); add('country_status',args.countryStatus); add('trading_status',args.tradingStatus);
  add('discord_status',args.discordStatus); add('scan_status',args.scanStatus);
  return {where:clauses.join(' AND '),values,scope:serving.scope};
}

export async function listChannelsPage(args:ChannelListingFilter&{limit:number;offset:number}):Promise<{items:ChannelRecord[];total:number;revision:string|null}> {
  const db=await getDb(); const limit=Math.min(250,Math.max(1,args.limit)); const offset=Math.max(0,args.offset);
  const {where,values}=await channelListingWhere(db,args);
  const columns=`channel_id,channel_name,youtube_url,country,country_status,confidence_score,discord_status,discord_invite,scan_status,scan_attempts,discovery_source,first_seen,last_checked,subscriber_count,channel_thumbnail_url,quality_score,trading_status,trading_confidence_score,trading_category,country_metadata_status,country_metadata_checked_at,latest_upload_at,uploads_last_30_days,uploads_last_90_days,uploads_last_365_days,activity_band,activity_score,activity_observed_at,discord_discovery_status,discord_candidate_locator,discord_candidate_id,discord_candidate_raw_locator,discord_candidate_type,discord_resolution_status,discord_liveness_status,discord_relevance_status,discord_validation_status,
    (SELECT status FROM jobs WHERE type='POST_APPROVAL_ENRICH' AND payload->>'channelId'=channels.channel_id ORDER BY created_at DESC LIMIT 1) post_approval_job_status,
    (SELECT last_error FROM jobs WHERE type='POST_APPROVAL_ENRICH' AND payload->>'channelId'=channels.channel_id ORDER BY created_at DESC LIMIT 1) post_approval_job_error`;
  const [page,summary]=await Promise.all([
    db.query(`SELECT ${columns} FROM channels WHERE ${where} ORDER BY first_seen DESC,channel_id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,limit,offset]),
    db.query(`SELECT COUNT(*)::int total,MAX(updated_at) revision FROM channels WHERE ${where}`,values)
  ]);
  return {items:page.rows.map(rowToChannel),total:Number(summary.rows[0].total||0),revision:iso(summary.rows[0].revision)};
}

export async function getChannelListingRevision(args:ChannelListingFilter):Promise<{total:number;revision:string|null}> {
  const db=await getDb(); const {where,values}=await channelListingWhere(db,args);
  const result=await db.query(`SELECT COUNT(*)::int total,MAX(updated_at) revision FROM channels WHERE ${where}`,values);
  return {total:Number(result.rows[0].total||0),revision:iso(result.rows[0].revision)};
}

export interface DashboardOperationalSummary {storedChannels:number;activeDiscords:number;pendingScans:number;pendingReviews:number;scope:{storedChannels:string;operationalMetrics:string;pendingReviews:string};deployment:{environment:string;service:string;instance:string}}
export async function getDashboardOperationalSummary(env:NodeJS.ProcessEnv=process.env):Promise<DashboardOperationalSummary> {
  const db=await getDb();
  // One aggregate query preserves the summary-endpoint optimization while the
  // shared eligibility predicate prevents KPI/listing population drift.
  const serving=await dashboardServingPredicate(db);const result=await db.query(`SELECT COUNT(*)::int stored_channels,
    COUNT(*) FILTER(WHERE discord_status IN('ACTIVE','ACTIVE_LOW_VOLUME'))::int active_discords,
    COUNT(*) FILTER(WHERE scan_status IN('PENDING','LOCKED','ENRICHMENT_PENDING','ENRICHING','NEEDS_REVIEW'))::int pending_scans,
    (SELECT COUNT(*)::int FROM channel_reviews WHERE state='PENDING') pending_reviews
    FROM channels WHERE ${serving.predicate}`);
  const row=result.rows[0];
  return {storedChannels:Number(row.stored_channels||0),activeDiscords:Number(row.active_discords||0),pendingScans:Number(row.pending_scans||0),pendingReviews:Number(row.pending_reviews||0),
    scope:{storedChannels:serving.scope,operationalMetrics:serving.scope,pendingReviews:'DURABLE_REVIEW_QUEUE'},
    deployment:{environment:env.RAILWAY_ENVIRONMENT_NAME||env.DEPLOYMENT_ENVIRONMENT||env.NODE_ENV||'unknown',service:env.RAILWAY_SERVICE_NAME||env.SERVICE_NAME||'trading-discovery-engine',instance:env.RAILWAY_DEPLOYMENT_ID?.slice(0,12)||env.DEPLOYMENT_ID?.slice(0,12)||'local'}};
}
export async function getChannelById(channelId: string): Promise<ChannelRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM channels WHERE channel_id=$1', [channelId]);
  return res.rows[0] ? rowToChannel(res.rows[0]) : null;
}

export async function upsertChannel(channel: ChannelRecord): Promise<void> {
  const db = await getDb();
  await db.query(`INSERT INTO channels (
    channel_id,channel_name,youtube_url,country,country_status,confidence_score,discord_status,discord_invite,scan_status,scan_attempts,discovery_source,first_seen,last_checked,next_check,inspection_trail,subscriber_count,channel_thumbnail_url,quality_score,quality_breakdown,trading_status,trading_confidence_score,trading_category,trading_relevance_breakdown,country_metadata_status,country_metadata_checked_at,latest_upload_at,uploads_last_30_days,uploads_last_90_days,uploads_last_365_days,activity_band,activity_score,activity_observed_at,discord_discovery_status,discord_candidate_locator,discord_candidate_id,discord_candidate_raw_locator,discord_candidate_type,discord_resolution_status,discord_liveness_status,discord_relevance_status,discord_validation_status,updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,now())
  ON CONFLICT(channel_id) DO UPDATE SET
    channel_name=excluded.channel_name,youtube_url=excluded.youtube_url,country=excluded.country,country_status=excluded.country_status,confidence_score=excluded.confidence_score,discord_status=excluded.discord_status,discord_invite=excluded.discord_invite,scan_status=excluded.scan_status,scan_attempts=excluded.scan_attempts,discovery_source=excluded.discovery_source,last_checked=excluded.last_checked,next_check=excluded.next_check,inspection_trail=excluded.inspection_trail,subscriber_count=excluded.subscriber_count,channel_thumbnail_url=excluded.channel_thumbnail_url,quality_score=excluded.quality_score,quality_breakdown=excluded.quality_breakdown,trading_status=excluded.trading_status,trading_confidence_score=excluded.trading_confidence_score,trading_category=excluded.trading_category,trading_relevance_breakdown=excluded.trading_relevance_breakdown,country_metadata_status=excluded.country_metadata_status,country_metadata_checked_at=excluded.country_metadata_checked_at,latest_upload_at=excluded.latest_upload_at,uploads_last_30_days=excluded.uploads_last_30_days,uploads_last_90_days=excluded.uploads_last_90_days,uploads_last_365_days=excluded.uploads_last_365_days,activity_band=excluded.activity_band,activity_score=excluded.activity_score,activity_observed_at=excluded.activity_observed_at,discord_discovery_status=excluded.discord_discovery_status,discord_candidate_locator=excluded.discord_candidate_locator,discord_candidate_id=excluded.discord_candidate_id,discord_candidate_raw_locator=excluded.discord_candidate_raw_locator,discord_candidate_type=excluded.discord_candidate_type,discord_resolution_status=excluded.discord_resolution_status,discord_liveness_status=excluded.discord_liveness_status,discord_relevance_status=excluded.discord_relevance_status,discord_validation_status=excluded.discord_validation_status,updated_at=now()`, [
    channel.channel_id, channel.channel_name, channel.youtube_url, channel.country, channel.country_status, channel.confidence_score || 0,
    channel.discord_status, channel.discord_invite || null, channel.scan_status, channel.scan_attempts || 0, channel.discovery_source,
    channel.first_seen || new Date().toISOString(), channel.last_checked || null, null, JSON.stringify(channel.inspection_trail || []),
    channel.subscriber_count || null, channel.channel_thumbnail_url || null, channel.quality_score || 0,
    channel.quality_breakdown ? JSON.stringify(channel.quality_breakdown) : null, channel.trading_status || 'UNCERTAIN',
    channel.trading_confidence_score || 0, channel.trading_category || 'General Trading',
    channel.trading_relevance_breakdown ? JSON.stringify(channel.trading_relevance_breakdown) : null,
    channel.country_metadata_status || 'NOT_REQUESTED', channel.country_metadata_checked_at || null,
    channel.latest_upload_at || null, channel.uploads_last_30_days || 0, channel.uploads_last_90_days || 0,
    channel.uploads_last_365_days || 0, channel.activity_band || 'UNKNOWN', channel.activity_score ?? 50,
    channel.activity_observed_at || null,channel.discord_discovery_status||'NOT_DISCOVERED',channel.discord_candidate_locator||null,channel.discord_candidate_id||null,channel.discord_candidate_raw_locator||null,channel.discord_candidate_type||null,channel.discord_resolution_status||'NOT_ATTEMPTED',channel.discord_liveness_status||'NOT_CHECKED',channel.discord_relevance_status||'NOT_CHECKED',channel.discord_validation_status||'NOT_STARTED'
  ]);
}

export async function getCountryVocabularies(): Promise<CountryVocabulary[]> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM country_vocabularies ORDER BY country');
  return res.rows.map(r => ({ country: r.country, languages: parseJson(r.languages, []), native_trading_terminology: parseJson(r.native_trading_terminology, []), popular_instruments: parseJson(r.popular_instruments, []), local_market_phrases: parseJson(r.local_market_phrases, []), common_content_format_names: parseJson(r.common_content_format_names, []) }));
}

export async function saveCountryVocabulary(vocab: CountryVocabulary): Promise<void> {
  const db = await getDbNoInit().catch(getDb);
  await db.query(`INSERT INTO country_vocabularies(country,languages,native_trading_terminology,popular_instruments,local_market_phrases,common_content_format_names) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(country) DO UPDATE SET languages=excluded.languages,native_trading_terminology=excluded.native_trading_terminology,popular_instruments=excluded.popular_instruments,local_market_phrases=excluded.local_market_phrases,common_content_format_names=excluded.common_content_format_names`, [vocab.country, JSON.stringify(vocab.languages), JSON.stringify(vocab.native_trading_terminology), JSON.stringify(vocab.popular_instruments), JSON.stringify(vocab.local_market_phrases), JSON.stringify(vocab.common_content_format_names)]);
}

export async function getExcludedCountries(): Promise<ExcludedCountry[]> { const db=await getDb(); const res=await db.query('SELECT * FROM excluded_countries ORDER BY country_name'); return res.rows; }
export async function addExcludedCountry(country: ExcludedCountry): Promise<void> { const db=await getDbNoInit().catch(getDb); await db.query('INSERT INTO excluded_countries(country_name,reason) VALUES($1,$2) ON CONFLICT(country_name) DO UPDATE SET reason=excluded.reason',[country.country_name,country.reason]); }
export async function removeExcludedCountry(countryName: string): Promise<void> { const db=await getDb(); await db.query('DELETE FROM excluded_countries WHERE country_name=$1',[countryName]); }

export async function getQueueStatus(): Promise<QueueStatus> {
  const db=await getDb();
  const depths=await db.query(`SELECT type, COUNT(*)::int count FROM jobs WHERE status IN ('PENDING','PROCESSING') GROUP BY type`);
  const controls=await db.query('SELECT queue_name,is_paused FROM queue_controls');
  const paused:Record<string,boolean>={}; controls.rows.forEach(r=>paused[r.queue_name]=!!r.is_paused);
  const typeCount=(types:string[])=>depths.rows.filter(r=>types.includes(r.type)).reduce((a,r)=>a+r.count,0);
  const pending=await db.query(`SELECT id,type,status,priority,run_after,created_at,last_error FROM jobs WHERE status IN ('PENDING','PROCESSING') ORDER BY priority DESC,created_at ASC LIMIT 100`);
  const now=Date.now();
  const pendingWork=pending.rows.map(r=>({id:r.id,type:r.type,status:r.status,priority:r.priority||0,ageMs:Math.max(0,now-new Date(r.created_at).getTime()),waitingReason:r.status==='PROCESSING'?'waiting_for_worker':new Date(r.run_after).getTime()>now?(String(r.last_error||'').match(/rate.?limit|429/i)?'waiting_for_youtube_rate_limit':String(r.last_error||'').match(/quota|provider.*cool/i)?'waiting_for_quota':'retry_at'):'waiting_for_worker',retryAt:r.status==='PENDING'&&new Date(r.run_after).getTime()>now?iso(r.run_after):null,lastProviderError:r.last_error||null}));
  return { searchJobs:{depth:typeCount(['SEARCH_YOUTUBE','MANUAL_SEARCH_PAGE','AUTONOMOUS_DISCOVERY_CYCLE']),isPaused:!!paused.search_jobs}, channelProcessing:{depth:typeCount(['PROCESS_CHANNEL','ENRICH_CHANNEL']),isPaused:!!paused.channel_processing}, discordValidation:{depth:typeCount(['INSPECT_DISCORD']),isPaused:!!paused.discord_validation},pendingWork };
}
export async function toggleQueuePause(queueName:string,isPaused:boolean):Promise<void>{const db=await getDb(); await db.query('INSERT INTO queue_controls(queue_name,is_paused) VALUES($1,$2) ON CONFLICT(queue_name) DO UPDATE SET is_paused=excluded.is_paused',[queueName,isPaused]);}

export function getYouTubeKeyPool(): string[] { return getConfiguredYouTubeKeys(); }
export function getDailyYouTubeQuotaBudget():number{const perKey=Number(process.env.YOUTUBE_DAILY_QUOTA_PER_KEY||'10000');return calculateYouTubeDailyBudget(getYouTubeKeyPool().length,perKey);}
export interface KeyQuotaUsage { keyIndex:number; maskedKey:string; unitsUsed:number; limit:number; isActive:boolean; status:YouTubeProviderOperationalStatus; retryAt:string|null; }
export interface QuotaInfoExtended { unitsUsed:number; dailyLimit:number; lastReset:string; totalKeys:number; keyUsage:KeyQuotaUsage[]; }
export async function getQuota():Promise<QuotaInfoExtended>{const db=await getDb(); const today=getYouTubeQuotaDay(); const keys=getYouTubeKeyPool(); const perKey=Math.max(1,Number(process.env.YOUTUBE_DAILY_QUOTA_PER_KEY||'10000')); const limit=calculateYouTubeDailyBudget(keys.length,perKey); let res=await db.query("SELECT * FROM quota_tracker WHERE id='youtube'"); if(!res.rowCount){await db.query("INSERT INTO quota_tracker(id,units_used,daily_limit,last_reset) VALUES('youtube',0,$1,$2)",[limit,today]); res=await db.query("SELECT * FROM quota_tracker WHERE id='youtube'");} let row=res.rows[0]; if(row.last_reset!==today){await db.query("UPDATE quota_tracker SET units_used=0,daily_limit=$1,last_reset=$2 WHERE id='youtube'",[limit,today]); row={...row,units_used:0,daily_limit:limit,last_reset:today};} else await db.query("UPDATE quota_tracker SET daily_limit=$1 WHERE id='youtube'",[limit]); return {unitsUsed:row.units_used||0,dailyLimit:limit,lastReset:row.last_reset,totalKeys:keys.length,keyUsage:keys.map((k,i)=>{const provider=youtubeProviderCooldown.status(k);return {keyIndex:i+1,maskedKey:k.length>8?`${k.slice(0,4)}...${k.slice(-4)}`:'****',unitsUsed:Math.max(0,Math.min(perKey,(row.units_used||0)-i*perKey)),limit:perKey,isActive:provider.status==='Active',status:provider.status,retryAt:provider.retryAt===null?null:new Date(provider.retryAt).toISOString()};})};}
export async function incrementQuota(units:number):Promise<void>{const db=await getDb(); await getQuota(); await db.query("UPDATE quota_tracker SET units_used=units_used+$1 WHERE id='youtube'",[units]);}

export async function getSchemaInfo(): Promise<{currentVersion:number;migrations:Array<{version:number;name:string;applied_at:string}>;channelCount:number}> { const db=await getDb(); const mig=await db.query('SELECT version,name,applied_at FROM schema_migrations ORDER BY version'); const cnt=await db.query('SELECT COUNT(*)::int count FROM channels'); return {currentVersion:mig.rows.at(-1)?.version||0,migrations:mig.rows.map(r=>({version:r.version,name:r.name,applied_at:iso(r.applied_at)!})),channelCount:cnt.rows[0].count}; }

function rowToQuery(r:any):QueryRecord{return {id:r.id,query:r.query,country:r.country,collection:r.collection,intent:r.intent,times_executed:r.times_executed||0,last_executed:iso(r.last_executed),total_channels_found:r.total_channels_found||0,unique_channels_found:r.unique_channels_found||0,quality_channels_found:r.quality_channels_found||0,community_channels_found:r.community_channels_found||0,avg_quality_score:r.avg_quality_score||0,performance_score:r.performance_score||0,created_at:iso(r.created_at)||new Date().toISOString(),status:r.status||'ACTIVE',knowledge_tiers:r.knowledge_tiers||[1],generation_mode:r.generation_mode||'LEGACY',generation_reason:r.generation_reason||'Legacy query',discovery_objective:r.discovery_objective||'Discover relevant trading creators.',primary_term:r.primary_term||undefined,generation_metadata:parseJson(r.generation_metadata,{}),reserved_until:iso(r.reserved_until),next_eligible_at:iso(r.next_eligible_at)} as QueryRecord;}
export async function getAllQueries():Promise<QueryRecord[]>{const db=await getDb(); const res=await db.query('SELECT * FROM query_library ORDER BY performance_score DESC,times_executed DESC'); return res.rows.map(rowToQuery);}
export async function getQueriesByCountry(country:string):Promise<QueryRecord[]>{const db=await getDb(); const res=await db.query(`SELECT * FROM query_library WHERE LOWER(country)=LOWER($1) AND status='ACTIVE' ORDER BY performance_score DESC,times_executed ASC`,[country]); return res.rows.map(rowToQuery);}
export async function getQueryByText(queryText:string):Promise<QueryRecord|null>{const db=await getDb(); const res=await db.query('SELECT * FROM query_library WHERE LOWER(query)=LOWER($1)',[queryText.trim()]); return res.rows[0]?rowToQuery(res.rows[0]):null;}
export async function upsertQueryRecord(record:{query:string;country:string;collection:'PROVEN'|'EXPERIMENTAL'|'REJECTED';intent:string;knowledgeTiers?:number[];generationMode?:string;generationReason?:string;discoveryObjective?:string;primaryTerm?:string;generationMetadata?:Record<string,unknown>;}):Promise<QueryRecord>{const db=await getDb(); const query=record.query.normalize('NFKC').trim().replace(/\s+/g,' '); const res=await db.query(`INSERT INTO query_library(query,normalized_query,country,collection,intent,knowledge_tiers,generation_mode,generation_reason,discovery_objective,primary_term,generation_metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) ON CONFLICT(country,normalized_query) DO UPDATE SET query=excluded.query,collection=excluded.collection,intent=excluded.intent,knowledge_tiers=excluded.knowledge_tiers,generation_mode=excluded.generation_mode,generation_reason=excluded.generation_reason,discovery_objective=excluded.discovery_objective,primary_term=excluded.primary_term,generation_metadata=excluded.generation_metadata RETURNING *`,[query,normalizeQueryText(query),record.country,record.collection,record.intent,record.knowledgeTiers||[1],record.generationMode||'LEGACY',record.generationReason||'Legacy query',record.discoveryObjective||'Discover relevant trading creators.',record.primaryTerm||null,JSON.stringify(record.generationMetadata||{})]); return rowToQuery(res.rows[0]);}
export async function updateQueryExecutionStats(queryId:number,stats:{totalChannelsFound:number;uniqueChannelsFound:number;qualityChannelsFound:number;communityChannelsFound:number;avgQualityScore:number;performanceScore:number;newCollection?:'PROVEN'|'EXPERIMENTAL'|'REJECTED';}):Promise<void>{const db=await getDb(); await db.query(`UPDATE query_library SET times_executed=times_executed+1,last_executed=now(),total_channels_found=total_channels_found+$1,unique_channels_found=unique_channels_found+$2,quality_channels_found=quality_channels_found+$3,community_channels_found=community_channels_found+$4,avg_quality_score=ROUND(((avg_quality_score*times_executed)+$5)/(times_executed+1)),performance_score=$6,collection=COALESCE($7,collection) WHERE id=$8`,[stats.totalChannelsFound,stats.uniqueChannelsFound,stats.qualityChannelsFound,stats.communityChannelsFound,stats.avgQualityScore,stats.performanceScore,stats.newCollection||null,queryId]);}
export async function setQueryCollection(queryId:number,collection:'PROVEN'|'EXPERIMENTAL'|'REJECTED'):Promise<void>{const db=await getDb(); await db.query('UPDATE query_library SET collection=$1 WHERE id=$2',[collection,queryId]);}
export async function addQueryExecutionLog(log:{query_id?:number;query:string;country:string;executed_at:string;channels_discovered:number;unique_new_channels:number;quality_creators_discovered:number;communities_discovered:number;cycle_quality_score:number;logs?:string[];}):Promise<void>{const db=await getDb(); await db.query(`INSERT INTO query_execution_logs(query_id,query,country,executed_at,channels_discovered,unique_new_channels,quality_creators_discovered,communities_discovered,cycle_quality_score,logs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[log.query_id||null,log.query,log.country,log.executed_at,log.channels_discovered,log.unique_new_channels,log.quality_creators_discovered,log.communities_discovered,log.cycle_quality_score,JSON.stringify(log.logs||[])]);}
export async function getRecentQueryExecutionLogs(limit=20):Promise<QueryExecutionLog[]>{const db=await getDb(); const res=await db.query('SELECT * FROM query_execution_logs ORDER BY executed_at DESC LIMIT $1',[limit]); return res.rows.map(r=>({id:r.id,query_id:r.query_id||undefined,query:r.query,country:r.country,executed_at:iso(r.executed_at)||'',channels_discovered:r.channels_discovered||0,unique_new_channels:r.unique_new_channels||0,quality_creators_discovered:r.quality_creators_discovered||0,communities_discovered:r.communities_discovered||0,cycle_quality_score:r.cycle_quality_score||0,logs:parseJson(r.logs,[])}));}
export async function saveExtractedTerm(country:string,term:string,category:'terminology'|'instrument'|'phrase'|'format',sourceChannelId?:string):Promise<void>{const db=await getDb(); const clean=term.trim(); if(!clean)return; const saved=await db.query(`INSERT INTO extracted_trading_vocabulary(country,term,category,source_channel_id,occurrences,first_extracted,last_extracted,trust_tier,validation_count) VALUES($1,$2,$3,$4,1,now(),now(),3,0) ON CONFLICT(country,term) DO UPDATE SET occurrences=extracted_trading_vocabulary.occurrences+1,last_extracted=now(),source_channel_id=COALESCE($4,extracted_trading_vocabulary.source_channel_id) RETURNING id`,[country,clean,category,sourceChannelId||null]); if(sourceChannelId){await db.query(`INSERT INTO extracted_vocabulary_sources(term_id,channel_id) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM channels WHERE channel_id=$2 AND trading_status='TRADING_CONFIRMED') ON CONFLICT DO NOTHING`,[saved.rows[0].id,sourceChannelId]); await db.query(`UPDATE extracted_trading_vocabulary v SET validation_count=s.confirmed_sources,trust_tier=CASE WHEN s.confirmed_sources>=2 THEN 2 ELSE 3 END FROM (SELECT COUNT(DISTINCT evs.channel_id)::int confirmed_sources FROM extracted_vocabulary_sources evs JOIN channels c ON c.channel_id=evs.channel_id AND c.trading_status='TRADING_CONFIRMED' WHERE evs.term_id=$1) s WHERE v.id=$1`,[saved.rows[0].id]);}}
export async function getExtractedVocabulary(country?:string):Promise<ExtractedTermRecord[]>{const db=await getDb(); const res=country?await db.query('SELECT * FROM extracted_trading_vocabulary WHERE country=$1 ORDER BY trust_tier ASC,occurrences DESC,last_extracted DESC',[country]):await db.query('SELECT * FROM extracted_trading_vocabulary ORDER BY trust_tier ASC,occurrences DESC,last_extracted DESC'); return res.rows.map(r=>({id:r.id,country:r.country,term:r.term,category:r.category,source_channel_id:r.source_channel_id||undefined,occurrences:r.occurrences||1,first_extracted:iso(r.first_extracted)||'',last_extracted:iso(r.last_extracted)||'',trust_tier:r.trust_tier||3,validation_count:r.validation_count||0}));}
export async function getAppSetting(key:string,defaultValue=''):Promise<string>{const db=await getDb(); const res=await db.query('SELECT setting_value FROM app_settings WHERE setting_key=$1',[key]); return res.rows[0]?.setting_value ?? defaultValue;}
export async function setAppSetting(key:string,value:string):Promise<void>{const db=await getDb(); await db.query('INSERT INTO app_settings(setting_key,setting_value) VALUES($1,$2) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value',[key,value]);}
export async function purgeSyntheticTestChannels():Promise<number>{const db=await getDb(); const res=await db.query("DELETE FROM channels WHERE channel_id LIKE 'UC_STRESS_TEST_%' RETURNING channel_id"); return res.rowCount||0;}
export async function performManualDatabaseBackup():Promise<{success:boolean;timestamp:string;backupPath:string}>{throw new Error('Manual SQL.js file backup is disabled after PostgreSQL migration. Use PostgreSQL/Railway backups or pg_dump.');}

export type JobStatus='PENDING'|'PROCESSING'|'COMPLETED'|'FAILED';
export interface DurableJob{ id:string; type:string; status:JobStatus; payload:any; attempts:number; max_attempts:number; run_after:string; locked_by?:string|null; locked_at?:string|null; last_error?:string|null; created_at:string; }
export async function enqueueJob(type:string,payload:any,opts:{priority?:number;maxAttempts?:number;runAfter?:string;idempotencyKey?:string}={}):Promise<DurableJob>{const db=await getDb(); const res=await db.query(`INSERT INTO jobs(type,payload,priority,max_attempts,run_after,idempotency_key,catalog_version_id,catalog_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(idempotency_key) DO UPDATE SET payload=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN excluded.payload ELSE jobs.payload END,status=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN 'PENDING' ELSE jobs.status END,attempts=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN 0 ELSE jobs.attempts END,run_after=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN excluded.run_after ELSE jobs.run_after END,locked_by=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.locked_by END,locked_at=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.locked_at END,last_error=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.last_error END,completed_at=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.completed_at END,updated_at=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN now() ELSE jobs.updated_at END RETURNING *`,[type,JSON.stringify(payload),opts.priority||0,opts.maxAttempts||3,opts.runAfter||new Date().toISOString(),opts.idempotencyKey||null,payload?.catalogPin?.catalogVersionId||null,payload?.catalogPin?.policyVersion||null]); return rowToJob(res.rows[0]);}
function rowToJob(r:any):DurableJob{return {id:r.id,type:r.type,status:r.status,payload:parseJson(r.payload,{}),attempts:r.attempts,max_attempts:r.max_attempts,run_after:iso(r.run_after)||'',locked_by:r.locked_by,locked_at:iso(r.locked_at),last_error:r.last_error,created_at:iso(r.created_at)||''};}
export async function claimNextJob(workerId:string,types?:string[]):Promise<DurableJob|null>{const db=await getDb(); const client=await db.connect(); let claimed:DurableJob|null=null;try{await client.query('BEGIN'); const res=await client.query(`SELECT * FROM jobs WHERE status='PENDING' AND run_after<=now() AND ($1::text[] IS NULL OR type=ANY($1)) ORDER BY priority DESC,created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,[types||null]); if(!res.rowCount){await client.query('COMMIT'); return null;} const job=res.rows[0];const upd=await client.query(`UPDATE jobs SET status='PROCESSING',locked_by=$1,locked_at=now(),attempts=attempts+1,updated_at=now() WHERE id=$2 RETURNING *`,[workerId,job.id]);await client.query(`INSERT INTO job_attempts(job_id,attempt_number,status) VALUES($1,$2,'PROCESSING')`,[job.id,upd.rows[0].attempts]); await client.query('COMMIT');claimed=rowToJob(upd.rows[0]);}catch(e){await client.query('ROLLBACK'); throw e;}finally{client.release();}
  // Trace persistence is deliberately outside the claim transaction. The old
  // implementation inserted diagnostic rows before COMMIT, so any trace-only
  // failure rolled back the PROCESSING transition and the worker could never
  // reach its dispatcher (or the first provider request).
  const traceId=String(claimed?.payload?.traceId||'');
  if(traceId){try{await db.query(`INSERT INTO discovery_execution_trace(trace_id,stage,outcome,detail) VALUES($1,'WORKER_POLLING','REACHED',$2),($1,'QUEUE_CLAIM','REACHED',$3)`,[traceId,JSON.stringify({workerId,claimableTypes:types||null}),JSON.stringify({workerId,jobId:claimed!.id,type:claimed!.type})]);}catch(error){console.warn('[Execution Trace] Claim trace unavailable; discovery claim remains committed.',error instanceof Error?error.message:error);}}
  return claimed;}
export async function completeJob(jobId:string):Promise<void>{const db=await getDb(); await db.query(`UPDATE jobs SET status='COMPLETED',completed_at=now(),locked_by=NULL,locked_at=NULL,updated_at=now() WHERE id=$1`,[jobId]); await db.query(`UPDATE job_attempts SET status='COMPLETED',finished_at=now() WHERE job_id=$1 AND finished_at IS NULL`,[jobId]);}
export type JobFailureDisposition='RETRYING_WITHOUT_ATTEMPT'|'RETRYING'|'FAILED';
const TRANSIENT_PROVIDER_CODES=new Set(['QUOTA_ALLOCATION_EXHAUSTED','YOUTUBE_PROVIDERS_COOLING_DOWN','YOUTUBE_PROVIDER_POOL_EXHAUSTED','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const TRANSIENT_HTTP_STATUS=new Set([408,425,429,500,502,503,504]);
const MAX_TRANSIENT_RETRY_AGE_MS=Math.max(60_000,Number(process.env.MAX_TRANSIENT_RETRY_AGE_MS||6*60*60_000));
export function isRetryableInfrastructureFailure(error:any):boolean{
  const code=String(error?.code||error?.cause?.code||'').toUpperCase();
  const status=Number(error?.status||error?.statusCode||error?.response?.status);
  const name=String(error?.name||'');
  const errorClass=String(error?.errorClass||'').toUpperCase();
  if(TRANSIENT_PROVIDER_CODES.has(code)||TRANSIENT_HTTP_STATUS.has(status))return true;
  if(name==='TimeoutError')return true;
  if(error?.retryable===true&&['TIMEOUT','CANCELLED','RATE_LIMIT','TRANSIENT','CREDENTIALS_EXHAUSTED'].includes(errorClass))return true;
  return false;
}
export function decideJobFailure(error:any,attempts:number,maxAttempts:number,now=Date.now(),firstFailureAt=now):{disposition:JobFailureDisposition;runAfter?:number;operationallyBlocked?:boolean}{
  if(String(error?.code||'')==='INVESTIGATION_DEADLINE_EXCEEDED')return {disposition:'FAILED'};
  if(isRetryableInfrastructureFailure(error)){
    if(now-firstFailureAt>=MAX_TRANSIENT_RETRY_AGE_MS)return {disposition:'FAILED',operationallyBlocked:true};
    const retryAt=Number(error?.retryAt);
    const retryAfterMs=Number(error?.retryAfterMs);
    const exponentialMs=Math.min(15*60_000,30_000*Math.pow(2,Math.max(0,attempts-1)));
    const scheduled=Number.isFinite(retryAt)?Math.max(now,retryAt):Number.isFinite(retryAfterMs)&&retryAfterMs>0?now+retryAfterMs:now+exponentialMs;
    return {disposition:'RETRYING_WITHOUT_ATTEMPT',runAfter:scheduled};
  }
  return {disposition:attempts>=maxAttempts?'FAILED':'RETRYING'};
}
export async function failJob(jobId:string,error:any):Promise<JobFailureDisposition|null>{const db=await getDb(); const res=await db.query('SELECT attempts,max_attempts,created_at FROM jobs WHERE id=$1',[jobId]); if(!res.rowCount)return null; const {attempts,max_attempts,created_at}=res.rows[0]; const msg=String(error?.message||error).slice(0,2000); const decision=decideJobFailure(error,attempts,max_attempts,Date.now(),new Date(created_at).getTime());const persistedMessage=decision.operationallyBlocked?`OPERATIONALLY_BLOCKED_RETRY_REQUIRED: ${msg}`:msg;if(decision.disposition==='RETRYING_WITHOUT_ATTEMPT'){await db.query(`UPDATE jobs SET status='PENDING',attempts=GREATEST(0,attempts-1),last_error=$2,locked_by=NULL,locked_at=NULL,run_after=$3,updated_at=now() WHERE id=$1`,[jobId,persistedMessage,new Date(decision.runAfter!).toISOString()]);}else if(decision.disposition==='FAILED'){await db.query(`UPDATE jobs SET status='FAILED',last_error=$2,locked_by=NULL,locked_at=NULL,updated_at=now() WHERE id=$1`,[jobId,persistedMessage]);}else{const seconds=Math.min(900,30*Math.pow(2,Math.max(0,attempts-1))); await db.query(`UPDATE jobs SET status='PENDING',last_error=$2,locked_by=NULL,locked_at=NULL,run_after=now()+($3||' seconds')::interval,updated_at=now() WHERE id=$1`,[jobId,persistedMessage,String(seconds)]);} await db.query(`UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$2 WHERE job_id=$1 AND finished_at IS NULL`,[jobId,persistedMessage]);return decision.disposition;}
export async function recoverStaleJobs(staleAfterMinutes=15):Promise<number>{const db=await getDb(); const client=await db.connect(); try{await client.query('BEGIN'); const res=await client.query(`UPDATE jobs SET status='PENDING',locked_by=NULL,locked_at=NULL,updated_at=now(),last_error=COALESCE(last_error,'Recovered stale processing lock') WHERE status='PROCESSING' AND locked_at < now()-($1||' minutes')::interval RETURNING id`,[String(staleAfterMinutes)]); if(res.rowCount) await client.query(`UPDATE job_attempts SET status='FAILED',finished_at=now(),error=COALESCE(error,'Worker heartbeat expired; job recovered for retry') WHERE finished_at IS NULL AND job_id=ANY($1::uuid[])`,[res.rows.map(row=>row.id)]); await client.query('COMMIT'); return res.rowCount||0;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
export async function heartbeatJob(jobId:string,workerId:string):Promise<void>{const db=await getDb(); await db.query(`UPDATE jobs SET locked_at=now(),updated_at=now() WHERE id=$1 AND status='PROCESSING' AND locked_by=$2`,[jobId,workerId]);}

export async function getSchedulerState(name='autonomous_discovery'):Promise<any>{const db=await getDb(); const res=await db.query('SELECT * FROM scheduler_state WHERE name=$1',[name]); return res.rows[0]||null;}
export async function updateSchedulerState(name:string,patch:Record<string,any>):Promise<void>{const db=await getDb(); const current=await getSchedulerState(name); if(!current) await db.query('INSERT INTO scheduler_state(name) VALUES($1) ON CONFLICT DO NOTHING',[name]); const sets=Object.keys(patch).map((k,i)=>`${k}=$${i+2}`).join(','); if(sets) await db.query(`UPDATE scheduler_state SET ${sets},updated_at=now() WHERE name=$1`,[name,...Object.values(patch).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v)]);}
export async function acquireSchedulerLock(name:string,workerId:string,staleAfterMinutes=15):Promise<boolean>{const db=await getDb(); const res=await db.query(`UPDATE scheduler_state SET is_running=true,locked_by=$2,locked_at=now(),updated_at=now() WHERE name=$1 AND is_enabled=true AND (locked_at IS NULL OR locked_at < now()-($3||' minutes')::interval OR is_running=false)`,[name,workerId,String(staleAfterMinutes)]); return !!res.rowCount;}
export async function releaseSchedulerLock(name:string,report?:any,nextRunAt?:string):Promise<void>{const db=await getDb(); await db.query(`UPDATE scheduler_state SET is_running=false,locked_by=NULL,locked_at=NULL,last_run_at=now(),next_run_at=$2,last_report=$3,updated_at=now() WHERE name=$1`,[name,nextRunAt||null,report?JSON.stringify(report):null]);}

export interface AutonomousQueryCandidate {
  query: QueryRecord;
  strategy: string;
  reason: string;
  allocationProvenance?: Record<string, unknown>;
}

export interface AutonomousSchedulingSnapshot {
  queueDepth: number;
  autonomousUnitsUsed: number;
  autonomousUnitsReserved: number;
}

export interface ScheduledAutonomousRun {
  runId: string;
  jobId: string;
  query: QueryRecord;
  retrievalLane: RetrievalLane;
  searchOrdering: SearchOrdering;
}

function queryComponents(query: QueryRecord): Array<{ type: string; term: string; tier: number; position: number }> {
  const metadata = query.generation_metadata || {};
  const attributedAtoms = Array.isArray(metadata.atoms)
    ? (metadata.atoms as Array<Record<string, unknown>>).map((item, index) => ({
        type: String(item.type || 'ATOM'),
        term: typeof item.term === 'string' ? item.term : undefined,
        tier: Number(item.tier) || 1,
        position: Number.isInteger(item.position) ? Number(item.position) : index
      }))
    : [];
  const components = [
    { type: 'QUERY_TEXT', term: query.query, tier: 1, position: -1 },
    ...attributedAtoms,
    { type: 'PRIMARY_TERM', term: query.primary_term, tier: 1, position: 0 },
    { type: 'LOCAL_TERM', term: metadata.localTier1Term as string | undefined, tier: 1, position: 1 },
    { type: 'LEARNED_TERM', term: metadata.learnedTerm as string | undefined, tier: query.knowledge_tiers?.includes(2) ? 2 : 3, position: 2 },
    { type: 'CONTENT_FORMAT', term: metadata.contentFormat as string | undefined, tier: 1, position: 3 }
  ];
  return components
    .filter((component): component is { type: string; term: string; tier: number; position: number } => !!component.term?.trim())
    .filter((component, index, all) => all.findIndex(other => other.type === component.type && other.term.trim().toLocaleLowerCase('en') === component.term.trim().toLocaleLowerCase('en')) === index);
}

export async function getAutonomousSchedulingSnapshot(): Promise<AutonomousSchedulingSnapshot> {
  const db = await getDb();
  await db.query(`UPDATE quota_reservations SET status='EXPIRED' WHERE status='RESERVED' AND expires_at <= now()`);
  const [depth, used, reserved] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS count FROM jobs WHERE type='SEARCH_YOUTUBE' AND status IN ('PENDING','PROCESSING') AND payload->>'source'='automated_query'`),
    db.query(`SELECT COALESCE(SUM(quota_used),0)::int AS units FROM query_runs WHERE source='automated_query' AND scheduled_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`),
    db.query(`SELECT COALESCE(SUM(quota_reserved),0)::int AS units FROM query_runs WHERE source='automated_query' AND status IN ('SCHEDULED','RUNNING','RETRYING')`)
  ]);
  return {
    queueDepth: depth.rows[0]?.count || 0,
    autonomousUnitsUsed: used.rows[0]?.units || 0,
    autonomousUnitsReserved: reserved.rows[0]?.units || 0
  };
}

export async function scheduleAutonomousQueryRuns(
  candidates: AutonomousQueryCandidate[],
  workerId: string,
  cooldownMinutes: number
): Promise<ScheduledAutonomousRun[]> {
  const db = await getDb();
  const configuredVideoPercent = Number(await getAppSetting('discovery_video_lane_percent', process.env.DISCOVERY_VIDEO_LANE_PERCENT || '70'));
  const videoLanePercent = Math.min(100, Math.max(0, Number.isFinite(configuredVideoPercent) ? configuredVideoPercent : 70));
  const configuredDatePercent = Number(await getAppSetting('discovery_date_ordering_video_percent', process.env.DISCOVERY_DATE_ORDERING_VIDEO_PERCENT || '10'));
  const datePercent = Math.min(100, Math.max(0, Number.isFinite(configuredDatePercent) ? configuredDatePercent : 10));
  const client = await db.connect();
  const scheduled: ScheduledAutonomousRun[] = [];
  try {
    await client.query('BEGIN');
    for (const candidate of candidates) {
      const reserved = await client.query(
        `UPDATE query_library
         SET reserved_at=now(), reserved_until=now()+interval '20 minutes', reserved_by=$2, last_queued_at=now()
         WHERE id=$1 AND status='ACTIVE' AND collection<>'REJECTED'
           AND (reserved_until IS NULL OR reserved_until <= now())
           AND (next_eligible_at IS NULL OR next_eligible_at <= now())
           AND (last_executed IS NULL OR last_executed <= now()-($3||' minutes')::interval)
           AND NOT EXISTS (SELECT 1 FROM query_runs qr WHERE qr.query_id=query_library.id AND qr.status IN ('SCHEDULED','RUNNING','RETRYING'))
         RETURNING *`,
        [candidate.query.id, workerId, String(cooldownMinutes)]
      );
      if (!reserved.rowCount) continue;

      // Allocate one search lane per run, so dual-lane learning does not double
      // traffic. The deficit allocator converges to the configured mix and gives
      // VIDEO the primary share by default.
      const laneCounts = await client.query(
        `SELECT COUNT(*) FILTER (WHERE retrieval_lane='VIDEO')::int AS video,
                COUNT(*)::int AS total
         FROM query_runs WHERE scheduled_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`
      );
      const video = laneCounts.rows[0]?.video || 0;
      const total = laneCounts.rows[0]?.total || 0;
      const retrievalLane = allocateRetrievalLane(video, total, videoLanePercent);
      const orderingCounts = await client.query(
        `SELECT COUNT(*) FILTER (WHERE search_ordering='DATE')::int AS date, COUNT(*)::int AS total
         FROM query_runs WHERE retrieval_lane='VIDEO' AND scheduled_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`
      );
      const searchOrdering = allocateSearchOrdering(retrievalLane, orderingCounts.rows[0]?.date || 0, orderingCounts.rows[0]?.total || 0, datePercent);

      const run = await client.query(
        `INSERT INTO query_runs(query_id,country,source,selection_strategy,selection_reason,retrieval_lane,search_ordering,quota_reserved,metadata)
         VALUES($1,$2,'automated_query',$3,$4,$5,$6,100,$7) RETURNING id`,
        [candidate.query.id, candidate.query.country, candidate.strategy, candidate.reason, retrievalLane, searchOrdering, JSON.stringify({ ...(candidate.query.generation_metadata || {}), ...(candidate.allocationProvenance ? { creatorIntelligenceAllocation: candidate.allocationProvenance } : {}) })]
      );
      const runId = run.rows[0].id;
      for (const component of queryComponents(candidate.query)) {
        await client.query(
          `INSERT INTO query_run_components(query_run_id,component_type,term,normalized_term,knowledge_tier,position)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [runId, component.type, component.term.trim(), component.term.normalize('NFKC').trim().toLocaleLowerCase('en'), component.tier, component.position]
        );
      }
      const job = await client.query(
        `INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key)
         VALUES('SEARCH_YOUTUBE',$1,20,3,$2) RETURNING id`,
        [JSON.stringify({
          queryRunId: runId,
          queryId: candidate.query.id,
          query: candidate.query.query,
          country: candidate.query.country,
          source: 'automated_query',
          retrievalLane,
          searchOrdering
        }), `search-run:${runId}`]
      );
      const jobId = job.rows[0].id;
      await client.query('UPDATE query_runs SET job_id=$2 WHERE id=$1', [runId, jobId]);
      await appendDecisionWith(client,{eventKey:`query-run:${runId}:selected:v1`,subjectType:'QUERY_RUN',subjectId:runId,eventType:'QUERY_SELECTED',queryId:candidate.query.id,queryRunId:runId,jobId,country:candidate.query.country,retrievalLane,eventTime:new Date().toISOString(),payload:{query:candidate.query.query,selectionStrategy:candidate.strategy,selectionReason:candidate.reason,searchOrdering,quotaReserved:100,generationMode:candidate.query.generation_mode,...(candidate.allocationProvenance?{creatorIntelligenceAllocation:candidate.allocationProvenance}:{})}});
      scheduled.push({ runId, jobId, query: rowToQuery(reserved.rows[0]), retrievalLane, searchOrdering });
    }
    await client.query('COMMIT');
    return scheduled;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getQueryById(queryId: number): Promise<QueryRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM query_library WHERE id=$1', [queryId]);
  return res.rows[0] ? rowToQuery(res.rows[0]) : null;
}

export async function startQueryRun(runId: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE query_runs SET status='RUNNING',started_at=COALESCE(started_at,now()) WHERE id=$1`, [runId]);
  await db.query(`UPDATE quota_reservations SET expires_at=now()+interval '20 minutes' WHERE operation_type='SEARCH_YOUTUBE' AND operation_id=$1 AND status='RESERVED'`, [runId]);
}

export async function completeQueryRun(runId: string, metrics: {
  rawResults: number;
  distinctResults: number;
  duplicateResults: number;
  knownChannels: number;
  newChannels: number;
  countryRejected: number;
  nonTrading: number;
  uncertain: number;
  needsReview: number;
  tradingConfirmed: number;
  uniqueChannels: number;
  qualityChannels: number;
  communitiesDiscovered: number;
  quotaUsed: number;
}): Promise<void> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `UPDATE query_runs SET status='COMPLETED',raw_results=$2,distinct_results=$3,duplicate_results=$4,
       known_channels=$5,new_channels=$6,country_rejected=$7,non_trading=$8,uncertain=$9,needs_review=$10,
       trading_confirmed=$11,unique_channels=$12,quality_channels=$13,communities_discovered=$14,quota_used=$15,
       performance_details=$16,completed_at=now() WHERE id=$1 RETURNING query_id`,
      [runId, metrics.rawResults, metrics.distinctResults, metrics.duplicateResults, metrics.knownChannels,
       metrics.newChannels, metrics.countryRejected, metrics.nonTrading, metrics.uncertain, metrics.needsReview,
       metrics.tradingConfirmed, metrics.uniqueChannels, metrics.qualityChannels, metrics.communitiesDiscovered,
       metrics.quotaUsed, JSON.stringify(metrics)]
    );
    await client.query(`UPDATE query_run_components SET performance_details=$2 WHERE query_run_id=$1`, [runId, JSON.stringify(metrics)]);
    if (run.rowCount) {
      await client.query(
        `UPDATE query_library SET reserved_at=NULL,reserved_until=NULL,reserved_by=NULL,
         next_eligible_at=NULL
         WHERE id=$1`, [run.rows[0].query_id]
      );
    }
    if(run.rowCount){const context=await client.query(`SELECT country,retrieval_lane,job_id,completed_at FROM query_runs WHERE id=$1`,[runId]);const row=context.rows[0];await appendOutcomeWith(client,{eventKey:`query-run:${runId}:funnel:v1`,subjectType:'QUERY_RUN',subjectId:runId,eventType:'QUERY_FUNNEL_RECORDED',verificationStatus:'PROVISIONAL',sourceEventKey:`query-run:${runId}:selected:v1`,queryId:run.rows[0].query_id,queryRunId:runId,jobId:row.job_id,country:row.country,retrievalLane:row.retrieval_lane,eventTime:iso(row.completed_at)!,payload:{...metrics}});}
    await client.query(
      `UPDATE quota_reservations SET status='CONSUMED',consumed_at=now()
       WHERE operation_type='SEARCH_YOUTUBE' AND operation_id=$1 AND status='RESERVED'`, [runId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface QueryRunSighting {
  channelId: string;
  resultRank: number;
  searchLane?: string;
  pageNumber?: number;
  wasKnown: boolean;
  persisted: boolean;
  countryOutcome: string;
  tradingOutcome: string;
  funnelOutcome: string;
  metadata?: Record<string, unknown>;
}

export async function recordQueryRunSightings(runId: string, queryId: number, sightings: QueryRunSighting[]): Promise<void> {
  if (!sightings.length) return;
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const sighting of sightings) {
      await client.query(
        `INSERT INTO channel_sightings(query_run_id,query_id,channel_id,result_rank,search_lane,page_number,
         was_known,persisted,country_outcome,trading_outcome,funnel_outcome,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT(query_run_id,channel_id,search_lane,page_number) DO NOTHING`,
        [runId, queryId, sighting.channelId, sighting.resultRank, sighting.searchLane || 'CHANNEL', sighting.pageNumber || 1,
         sighting.wasKnown, sighting.persisted, sighting.countryOutcome, sighting.tradingOutcome, sighting.funnelOutcome,
         JSON.stringify(sighting.metadata || {})]
      );
      await appendOutcomeWith(client,{eventKey:`query-run:${runId}:page:${sighting.pageNumber||1}:lane:${sighting.searchLane||'CHANNEL'}:channel:${sighting.channelId}:v1`,subjectType:'CHANNEL',subjectId:sighting.channelId,eventType:'CHANNEL_OBSERVED',verificationStatus:'PROVISIONAL',sourceEventKey:`query-run:${runId}:selected:v1`,queryId,queryRunId:runId,country:typeof sighting.metadata?.country==='string'?sighting.metadata.country:undefined,retrievalLane:sighting.searchLane,eventTime:new Date().toISOString(),payload:{resultRank:sighting.resultRank,pageNumber:sighting.pageNumber||1,wasKnown:sighting.wasKnown,persisted:sighting.persisted,countryOutcome:sighting.countryOutcome,tradingOutcome:sighting.tradingOutcome,funnelOutcome:sighting.funnelOutcome}});
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function failQueryRun(runId: string, error: unknown, terminal: boolean): Promise<void> {
  const db = await getDb();
  const message = String((error as any)?.message || error).slice(0, 2000);
  if (!terminal) {
    await db.query(`UPDATE query_runs SET status='RETRYING',error=$2 WHERE id=$1`, [runId, message]);
    return;
  }
  const run = await db.query(`UPDATE query_runs SET status='FAILED',error=$2,completed_at=now() WHERE id=$1 RETURNING query_id`, [runId, message]);
  if (run.rowCount) await db.query(`UPDATE query_library SET reserved_at=NULL,reserved_until=NULL,reserved_by=NULL WHERE id=$1`, [run.rows[0].query_id]);
  await db.query(`UPDATE quota_reservations SET status='RELEASED' WHERE operation_type='SEARCH_YOUTUBE' AND operation_id=$1 AND status='RESERVED'`, [runId]);
}

export async function tryReserveQuota(args: {
  operationType: string;
  operationId: string;
  allocation: 'MANUAL' | 'ENRICHMENT' | 'AUTONOMOUS';
  units: number;
  dailyBudget: number;
  allocationPercent: number;
}): Promise<boolean> {
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const quotaDay = getYouTubeQuotaDay();
    // Rollover belongs to admission so the first worker after the YouTube Pacific quota-day rollover can
    // recover without relying on a dashboard/read request. The upsert holds the
    // tracker row lock for the rest of this reservation transaction.
    await client.query(`INSERT INTO quota_tracker(id,units_used,daily_limit,last_reset)
      VALUES('youtube',0,$1,$2)
      ON CONFLICT(id) DO UPDATE SET
        units_used=CASE WHEN quota_tracker.last_reset<>excluded.last_reset THEN 0 ELSE quota_tracker.units_used END,
        daily_limit=excluded.daily_limit,
        last_reset=excluded.last_reset`, [args.dailyBudget, quotaDay]);
    await client.query(`SELECT id FROM quota_tracker WHERE id='youtube' FOR UPDATE`);
    await client.query(`UPDATE quota_reservations SET status='EXPIRED' WHERE status='RESERVED' AND expires_at<=now()`);
    const existing = await client.query(
      `SELECT status,units FROM quota_reservations WHERE operation_type=$1 AND operation_id=$2 FOR UPDATE`,
      [args.operationType, args.operationId]
    );
    const existingUnits = existing.rows[0]?.status === 'RESERVED' ? Number(existing.rows[0].units) : 0;
    if (existingUnits >= args.units) {
      await client.query('COMMIT');
      return true;
    }
    const totals = await client.query(
      `SELECT
         COALESCE((SELECT units_used FROM quota_tracker WHERE id='youtube'),0)::int AS actual_used,
         COALESCE(SUM(units) FILTER (WHERE status='RESERVED' AND NOT (operation_type=$1 AND operation_id=$2)),0)::int AS reserved_total
       FROM quota_reservations`,
      [args.operationType, args.operationId]
    );
    const row = totals.rows[0];
    // Allocation percentages are scheduling preferences, not hard partitions.
    // Hard partitions strand usable provider capacity and can defer executable
    // work until the next YouTube Pacific quota day while the shared pool still has quota.
    if (row.actual_used + row.reserved_total + args.units > args.dailyBudget) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO quota_reservations(operation_type,operation_id,allocation,units,expires_at)
       VALUES($1,$2,$3,$4,now()+interval '20 minutes')
       ON CONFLICT(operation_type,operation_id) DO UPDATE SET status='RESERVED',units=excluded.units,reserved_at=now(),expires_at=excluded.expires_at`,
      [args.operationType, args.operationId, args.allocation, args.units]
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function topUpQuotaReservation(args: {
  operationType: string;
  operationId: string;
  allocation: 'MANUAL' | 'ENRICHMENT' | 'AUTONOMOUS';
  additionalUnits: number;
  dailyBudget: number;
  allocationPercent: number;
}): Promise<boolean> {
  if (!Number.isFinite(args.additionalUnits) || args.additionalUnits <= 0) return false;

  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const quotaDay = getYouTubeQuotaDay();
    // Use the same tracker lock as initial admission so reservations, top-ups,
    // actual usage, and Pacific quota-day rollover share one serialization point.
    await client.query(`INSERT INTO quota_tracker(id,units_used,daily_limit,last_reset)
      VALUES('youtube',0,$1,$2)
      ON CONFLICT(id) DO UPDATE SET
        units_used=CASE WHEN quota_tracker.last_reset<>excluded.last_reset THEN 0 ELSE quota_tracker.units_used END,
        daily_limit=excluded.daily_limit,
        last_reset=excluded.last_reset`, [args.dailyBudget, quotaDay]);
    await client.query(`SELECT id FROM quota_tracker WHERE id='youtube' FOR UPDATE`);

    const existing = await client.query(
      `SELECT units
       FROM quota_reservations
       WHERE operation_type=$1 AND operation_id=$2
         AND allocation=$3 AND status='RESERVED' AND expires_at>now()
       FOR UPDATE`,
      [args.operationType, args.operationId, args.allocation]
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }

    const totals = await client.query(
      `SELECT
         COALESCE((SELECT units_used FROM quota_tracker WHERE id='youtube'),0)::int AS actual_used,
         COALESCE(SUM(units) FILTER (
           WHERE status='RESERVED' AND expires_at>now()
             AND NOT (operation_type=$1 AND operation_id=$2)
         ),0)::int AS other_reserved_total
       FROM quota_reservations`,
      [args.operationType, args.operationId]
    );
    const currentUnits = Number(existing.rows[0].units);
    const { actual_used: actualUsed, other_reserved_total: otherReservedTotal } = totals.rows[0];
    if (Number(actualUsed) + Number(otherReservedTotal) + currentUnits + args.additionalUnits > args.dailyBudget) {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query(
      `UPDATE quota_reservations
       SET units=units+$4,expires_at=now()+interval '20 minutes'
       WHERE operation_type=$1 AND operation_id=$2
         AND allocation=$3 AND status='RESERVED'`,
      [args.operationType, args.operationId, args.allocation, args.additionalUnits]
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function finishQuotaReservation(operationType: string, operationId: string, consumed: boolean): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE quota_reservations SET status=$3,consumed_at=CASE WHEN $3='CONSUMED' THEN now() ELSE NULL END
     WHERE operation_type=$1 AND operation_id=$2 AND status='RESERVED'`,
    [operationType, operationId, consumed ? 'CONSUMED' : 'RELEASED']
  );
}
