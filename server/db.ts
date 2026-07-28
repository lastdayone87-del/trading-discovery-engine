import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { ChannelRecord, CountryVocabulary, ExcludedCountry, QueueStatus, QueryRecord, QueryExecutionLog, ExtractedTermRecord, DiscoverySource } from '../src/types';
import { INITIAL_COUNTRY_VOCABULARIES, INITIAL_EXCLUDED_COUNTRIES } from '../src/data/initial_countries';

const { Pool } = pg;
const MIGRATIONS_DIR = path.join(process.cwd(), 'server', 'db', 'migrations');
// One database-wide lock serializes deploy-time migrations across Railway replicas.
const MIGRATION_ADVISORY_LOCK = 741963284;

let pool: InstanceType<typeof Pool> | null = null;
let initPromise: Promise<InstanceType<typeof Pool>> | null = null;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required. SQL.js fallback is disabled for Phase 1 PostgreSQL runtime. Run npm run migrate:sqljs after configuring PostgreSQL.');
  }
  return url;
}

export async function getDb(): Promise<InstanceType<typeof Pool>> {
  if (pool) return pool;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const connectionString = requireDatabaseUrl();
    pool = new Pool({ connectionString, ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
    await pool.query('SELECT 1');
    await runMigrations();
    await seedDefaults();
    return pool;
  })();
  return initPromise;
}

export function saveDb(): void {
  // PostgreSQL commits writes transactionally; retained as no-op compatibility shim.
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
    trading_relevance_breakdown: parseJson(row.trading_relevance_breakdown, undefined)
  };
}

export async function getAllChannels(): Promise<ChannelRecord[]> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM channels ORDER BY first_seen DESC');
  return res.rows.map(rowToChannel);
}

export async function getChannelById(channelId: string): Promise<ChannelRecord | null> {
  const db = await getDb();
  const res = await db.query('SELECT * FROM channels WHERE channel_id=$1', [channelId]);
  return res.rows[0] ? rowToChannel(res.rows[0]) : null;
}

export async function upsertChannel(channel: ChannelRecord): Promise<void> {
  const db = await getDb();
  await db.query(`INSERT INTO channels (
    channel_id,channel_name,youtube_url,country,country_status,confidence_score,discord_status,discord_invite,scan_status,scan_attempts,discovery_source,first_seen,last_checked,next_check,inspection_trail,subscriber_count,channel_thumbnail_url,quality_score,quality_breakdown,trading_status,trading_confidence_score,trading_category,trading_relevance_breakdown,updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,now())
  ON CONFLICT(channel_id) DO UPDATE SET
    channel_name=excluded.channel_name,youtube_url=excluded.youtube_url,country=excluded.country,country_status=excluded.country_status,confidence_score=excluded.confidence_score,discord_status=excluded.discord_status,discord_invite=excluded.discord_invite,scan_status=excluded.scan_status,scan_attempts=excluded.scan_attempts,discovery_source=excluded.discovery_source,last_checked=excluded.last_checked,next_check=excluded.next_check,inspection_trail=excluded.inspection_trail,subscriber_count=excluded.subscriber_count,channel_thumbnail_url=excluded.channel_thumbnail_url,quality_score=excluded.quality_score,quality_breakdown=excluded.quality_breakdown,trading_status=excluded.trading_status,trading_confidence_score=excluded.trading_confidence_score,trading_category=excluded.trading_category,trading_relevance_breakdown=excluded.trading_relevance_breakdown,updated_at=now()`, [
    channel.channel_id, channel.channel_name, channel.youtube_url, channel.country, channel.country_status, channel.confidence_score || 0,
    channel.discord_status, channel.discord_invite || null, channel.scan_status, channel.scan_attempts || 0, channel.discovery_source,
    channel.first_seen || new Date().toISOString(), channel.last_checked || null, null, JSON.stringify(channel.inspection_trail || []),
    channel.subscriber_count || null, channel.channel_thumbnail_url || null, channel.quality_score || 0,
    channel.quality_breakdown ? JSON.stringify(channel.quality_breakdown) : null, channel.trading_status || 'UNCERTAIN',
    channel.trading_confidence_score || 0, channel.trading_category || 'General Trading',
    channel.trading_relevance_breakdown ? JSON.stringify(channel.trading_relevance_breakdown) : null
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
  return { searchJobs:{depth:typeCount(['SEARCH_YOUTUBE','AUTONOMOUS_DISCOVERY_CYCLE']),isPaused:!!paused.search_jobs}, channelProcessing:{depth:typeCount(['PROCESS_CHANNEL','ENRICH_CHANNEL']),isPaused:!!paused.channel_processing}, discordValidation:{depth:typeCount(['INSPECT_DISCORD']),isPaused:!!paused.discord_validation} };
}
export async function toggleQueuePause(queueName:string,isPaused:boolean):Promise<void>{const db=await getDb(); await db.query('INSERT INTO queue_controls(queue_name,is_paused) VALUES($1,$2) ON CONFLICT(queue_name) DO UPDATE SET is_paused=excluded.is_paused',[queueName,isPaused]);}

export function getYouTubeKeyPool(): string[] { return [process.env.YOUTUBE_API_KEY,process.env.YOUTUBE_API_KEY_1,process.env.YOUTUBE_API_KEY_2,process.env.YOUTUBE_API_KEY_3,process.env.YOUTUBE_API_KEY_4,process.env.YOUTUBE_API_KEY_5].filter((k):k is string=>!!k&&!!k.trim()&&!k.trim().startsWith('MY_')).map(k=>k.trim()).filter((k,i,a)=>a.indexOf(k)===i); }
export interface KeyQuotaUsage { keyIndex:number; maskedKey:string; unitsUsed:number; limit:number; isActive:boolean; }
export interface QuotaInfoExtended { unitsUsed:number; dailyLimit:number; lastReset:string; totalKeys:number; keyUsage:KeyQuotaUsage[]; }
export async function getQuota():Promise<QuotaInfoExtended>{const db=await getDb(); const today=new Date().toISOString().split('T')[0]; const keys=getYouTubeKeyPool(); const limit=Math.max(1,keys.length)*10000; let res=await db.query("SELECT * FROM quota_tracker WHERE id='youtube'"); if(!res.rowCount){await db.query("INSERT INTO quota_tracker(id,units_used,daily_limit,last_reset) VALUES('youtube',0,$1,$2)",[limit,today]); res=await db.query("SELECT * FROM quota_tracker WHERE id='youtube'");} let row=res.rows[0]; if(row.last_reset!==today){await db.query("UPDATE quota_tracker SET units_used=0,daily_limit=$1,last_reset=$2 WHERE id='youtube'",[limit,today]); row={...row,units_used:0,daily_limit:limit,last_reset:today};} else await db.query("UPDATE quota_tracker SET daily_limit=$1 WHERE id='youtube'",[limit]); return {unitsUsed:row.units_used||0,dailyLimit:limit,lastReset:row.last_reset,totalKeys:keys.length,keyUsage:keys.map((k,i)=>({keyIndex:i+1,maskedKey:k.length>8?`${k.slice(0,4)}...${k.slice(-4)}`:'****',unitsUsed:Math.max(0,Math.min(10000,(row.units_used||0)-i*10000)),limit:10000,isActive:i===0}))};}
export async function incrementQuota(units:number):Promise<void>{const db=await getDb(); await getQuota(); await db.query("UPDATE quota_tracker SET units_used=units_used+$1 WHERE id='youtube'",[units]);}

export async function getSchemaInfo(): Promise<{currentVersion:number;migrations:Array<{version:number;name:string;applied_at:string}>;channelCount:number}> { const db=await getDb(); const mig=await db.query('SELECT version,name,applied_at FROM schema_migrations ORDER BY version'); const cnt=await db.query('SELECT COUNT(*)::int count FROM channels'); return {currentVersion:mig.rows.at(-1)?.version||0,migrations:mig.rows.map(r=>({version:r.version,name:r.name,applied_at:iso(r.applied_at)!})),channelCount:cnt.rows[0].count}; }

function rowToQuery(r:any):QueryRecord{return {id:r.id,query:r.query,country:r.country,collection:r.collection,intent:r.intent,times_executed:r.times_executed||0,last_executed:iso(r.last_executed),total_channels_found:r.total_channels_found||0,unique_channels_found:r.unique_channels_found||0,quality_channels_found:r.quality_channels_found||0,community_channels_found:r.community_channels_found||0,avg_quality_score:r.avg_quality_score||0,performance_score:r.performance_score||0,created_at:iso(r.created_at)||new Date().toISOString(),status:r.status||'ACTIVE',knowledge_tiers:r.knowledge_tiers||[1],generation_mode:r.generation_mode||'LEGACY',generation_reason:r.generation_reason||'Legacy query',discovery_objective:r.discovery_objective||'Discover relevant trading creators.',primary_term:r.primary_term||null,metadata:parseJson(r.metadata,{})};}

function rowToQueryExecutionLog(r:any):QueryExecutionLog{return {id:r.id,query_id:r.query_id,started_at:iso(r.started_at)!,ended_at:iso(r.ended_at)||null,status:r.status,error:r.error||null,channels_found:r.channels_found||0,new_channels_found:r.new_channels_found||0,metadata:parseJson(r.metadata,{})};}

function rowToExtractedTerm(r:any):ExtractedTermRecord{return {id:r.id,country:r.country,term:r.term,category:r.category,occurrences:r.occurrences,first_extracted:iso(r.first_extracted)!,last_extracted:iso(r.last_extracted)!,trust_tier:r.trust_tier,validation_count:r.validation_count||0,metadata:parseJson(r.metadata,{})};}

export async function getQueries():Promise<QueryRecord[]>{const db=await getDb(); const res=await db.query('SELECT * FROM queries ORDER BY created_at DESC'); return res.rows.map(rowToQuery);}
export async function getQueryById(id:number):Promise<QueryRecord|null>{const db=await getDb(); const res=await db.query('SELECT * FROM queries WHERE id=$1',[id]); return res.rows[0]?rowToQuery(res.rows[0]):null;}
export async function getQueriesByCollection(collection:string):Promise<QueryRecord[]>{const db=await getDb(); const res=await db.query('SELECT * FROM queries WHERE collection=$1 ORDER BY created_at DESC',[collection]); return res.rows.map(rowToQuery);}
export async function upsertQuery(query:QueryRecord):Promise<void>{const db=await getDb(); await db.query(`INSERT INTO queries(id,query,country,collection,intent,times_executed,last_executed,total_channels_found,unique_channels_found,quality_channels_found,community_channels_found,avg_quality_score,performance_score,created_at,status,knowledge_tiers,generation_mode,generation_reason,discovery_objective,primary_term,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT(id) DO UPDATE SET query=excluded.query,country=excluded.country,collection=excluded.collection,intent=excluded.intent,times_executed=excluded.times_executed,last_executed=excluded.last_executed,total_channels_found=excluded.total_channels_found,unique_channels_found=excluded.unique_channels_found,quality_channels_found=excluded.quality_channels_found,community_channels_found=excluded.community_channels_found,avg_quality_score=excluded.avg_quality_score,performance_score=excluded.performance_score,created_at=excluded.created_at,status=excluded.status,knowledge_tiers=excluded.knowledge_tiers,generation_mode=excluded.generation_mode,generation_reason=excluded.generation_reason,discovery_objective=excluded.discovery_objective,primary_term=excluded.primary_term,metadata=excluded.metadata`,[query.id,query.query,query.country,query.collection,query.intent,query.times_executed,query.last_executed,query.total_channels_found,query.unique_channels_found,query.quality_channels_found,query.community_channels_found,query.avg_quality_score,query.performance_score,query.created_at,query.status,JSON.stringify(query.knowledge_tiers),query.generation_mode,query.generation_reason,query.discovery_objective,query.primary_term,JSON.stringify(query.metadata)]);}
export async function deleteQuery(id:number):Promise<void>{const db=await getDb(); await db.query('DELETE FROM queries WHERE id=$1',[id]);}
export async function getQueryExecutionLogs(queryId:number):Promise<QueryExecutionLog[]>{const db=await getDb(); const res=await db.query('SELECT * FROM query_execution_logs WHERE query_id=$1 ORDER BY started_at DESC',[queryId]); return res.rows.map(rowToQueryExecutionLog);}
export async function addQueryExecutionLog(log:QueryExecutionLog):Promise<void>{const db=await getDb(); await db.query(`INSERT INTO query_execution_logs(id,query_id,started_at,ended_at,status,error,channels_found,new_channels_found,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[log.id,log.query_id,log.started_at,log.ended_at,log.status,log.error,log.channels_found,log.new_channels_found,JSON.stringify(log.metadata)]);}
export async function updateQueryExecutionLog(log:QueryExecutionLog):Promise<void>{const db=await getDb(); await db.query(`UPDATE query_execution_logs SET ended_at=$1,status=$2,error=$3,channels_found=$4,new_channels_found=$5,metadata=$6 WHERE id=$7`,[log.ended_at,log.status,log.error,log.channels_found,log.new_channels_found,JSON.stringify(log.metadata),log.id]);}
export async function getExtractedTerms():Promise<ExtractedTermRecord[]>{const db=await getDb(); const res=await db.query('SELECT * FROM extracted_terms ORDER BY last_extracted DESC'); return res.rows.map(rowToExtractedTerm);}
export async function upsertExtractedTerm(term:ExtractedTermRecord):Promise<void>{const db=await getDb(); await db.query(`INSERT INTO extracted_terms(id,country,term,category,occurrences,first_extracted,last_extracted,trust_tier,validation_count,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET country=excluded.country,term=excluded.term,category=excluded.category,occurrences=excluded.occurrences,first_extracted=excluded.first_extracted,last_extracted=excluded.last_extracted,trust_tier=excluded.trust_tier,validation_count=excluded.validation_count,metadata=excluded.metadata`,[term.id,term.country,term.term,term.category,term.occurrences,term.first_extracted,term.last_extracted,term.trust_tier,term.validation_count,JSON.stringify(term.metadata)]);}
export async function getSchedulerState(name:string):Promise<{name:string;isEnabled:boolean;isRunning:boolean}|null>{const db=await getDb(); const res=await db.query('SELECT name,is_enabled,is_running FROM scheduler_state WHERE name=$1',[name]); return res.rows[0]?{name:res.rows[0].name,isEnabled:res.rows[0].is_enabled,isRunning:res.rows[0].is_running}:null;}
export async function updateSchedulerState(name:string,isEnabled:boolean,isRunning:boolean):Promise<void>{const db=await getDb(); await db.query('UPDATE scheduler_state SET is_enabled=$1,is_running=$2 WHERE name=$3',[isEnabled,isRunning,name]);}
export async function getDiscoverySources():Promise<DiscoverySource[]>{const db=await getDb(); const res=await db.query('SELECT * FROM discovery_sources ORDER BY id'); return res.rows.map(r=>({id:r.id,name:r.name,type:r.type,config:parseJson(r.config,{})}));}
export async function upsertDiscoverySource(source:DiscoverySource):Promise<void>{const db=await getDb(); await db.query(`INSERT INTO discovery_sources(id,name,type,config) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,config=excluded.config`,[source.id,source.name,source.type,JSON.stringify(source.config)]);}
export async function deleteDiscoverySource(id:number):Promise<void>{const db=await getDb(); await db.query('DELETE FROM discovery_sources WHERE id=$1',[id]);}

export async function getAppSetting(name: string): Promise<string | null> {
  const db = await getDb();
  const res = await db.query("SELECT value FROM app_settings WHERE name=$1", [name]);
  return res.rows[0]?.value || null;
}

export async function getQueriesByCountry(country: string): Promise<QueryRecord[]> {
  const db = await getDb();
  const res = await db.query("SELECT * FROM queries WHERE country=$1 ORDER BY created_at DESC", [country]);
  return res.rows.map(rowToQuery);
}

export async function upsertQueryRecord(query: QueryRecord): Promise<void> {
  const db = await getDb();
  await db.query(`INSERT INTO queries(id,query,country,collection,intent,times_executed,last_executed,total_channels_found,unique_channels_found,quality_channels_found,community_channels_found,avg_quality_score,performance_score,created_at,status,knowledge_tiers,generation_mode,generation_reason,discovery_objective,primary_term,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT(id) DO UPDATE SET query=excluded.query,country=excluded.country,collection=excluded.collection,intent=excluded.intent,times_executed=excluded.times_executed,last_executed=excluded.last_executed,total_channels_found=excluded.total_channels_found,unique_channels_found=excluded.unique_channels_found,quality_channels_found=excluded.quality_channels_found,community_channels_found=excluded.community_channels_found,avg_quality_score=excluded.avg_quality_score,performance_score=excluded.performance_score,created_at=excluded.created_at,status=excluded.status,knowledge_tiers=excluded.knowledge_tiers,generation_mode=excluded.generation_mode,generation_reason=excluded.generation_reason,discovery_objective=excluded.discovery_objective,primary_term=excluded.primary_term,metadata=excluded.metadata`,[
    query.id, query.query, query.country, query.collection, query.intent, query.times_executed, query.last_executed, query.total_channels_found, query.unique_channels_found, query.quality_channels_found, query.community_channels_found, query.avg_quality_score, query.performance_score, query.created_at, query.status, JSON.stringify(query.knowledge_tiers), query.generation_mode, query.generation_reason, query.discovery_objective, query.primary_term, JSON.stringify(query.metadata)
  ]);
}

export async function updateQueryExecutionStats(queryId: number, totalChannelsFound: number, uniqueChannelsFound: number, qualityChannelsFound: number, communityChannelsFound: number, avgQualityScore: number, performanceScore: number): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE queries SET total_channels_found=$1,unique_channels_found=$2,quality_channels_found=$3,community_channels_found=$4,avg_quality_score=$5,performance_score=$6 WHERE id=$7`,[
    totalChannelsFound, uniqueChannelsFound, qualityChannelsFound, communityChannelsFound, avgQualityScore, performanceScore, queryId
  ]);
}

export async function saveExtractedTerm(term: ExtractedTermRecord): Promise<void> {
  const db = await getDb();
  await db.query(`INSERT INTO extracted_terms(id,country,term,category,occurrences,first_extracted,last_extracted,trust_tier,validation_count,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET country=excluded.country,term=excluded.term,category=excluded.category,occurrences=excluded.occurrences,first_extracted=excluded.first_extracted,last_extracted=excluded.last_extracted,trust_tier=excluded.trust_tier,validation_count=excluded.validation_count,metadata=excluded.metadata`,[
    term.id, term.country, term.term, term.category, term.occurrences, term.first_extracted, term.last_extracted, term.trust_tier, term.validation_count, JSON.stringify(term.metadata)
  ]);
}

export async function getExtractedVocabulary(country: string): Promise<ExtractedTermRecord[]> {
  const db = await getDb();
  const res = await db.query("SELECT * FROM extracted_terms WHERE country=$1 ORDER BY last_extracted DESC", [country]);
  return res.rows.map(rowToExtractedTerm);
}

export async function enqueueJob(type: string, payload: object, options?: { runAt?: Date; collection?: string }): Promise<number> {
  const db = await getDb();
  const res = await db.query(`INSERT INTO jobs(type,payload,run_at,collection) VALUES($1,$2,$3,$4) RETURNING id`, [
    type, JSON.stringify(payload), options?.runAt || new Date(), options?.collection || null
  ]);
  return res.rows[0].id;
}

export async function claimNextJob(workerId: string, types: string[]): Promise<{ id: number; type: string; payload: any; collection: string | null } | null> {
  const db = await getDb();
  const res = await db.query(`UPDATE jobs SET status=\'PROCESSING\', worker_id=$1, started_at=now() WHERE id=(SELECT id FROM jobs WHERE status=\'PENDING\' AND type=ANY($2) AND run_at<=now() ORDER BY run_at ASC, id ASC FOR UPDATE SKIP LOCKED) RETURNING id,type,payload,collection`, [
    workerId, types
  ]);
  return res.rows[0] ? { id: res.rows[0].id, type: res.rows[0].type, payload: res.rows[0].payload, collection: res.rows[0].collection } : null;
}

export async function completeJob(id: number, result: object): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE jobs SET status=\'COMPLETED\', completed_at=now(), result=$1 WHERE id=$2`, [
    JSON.stringify(result), id
  ]);
}

export async function failJob(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.query(`UPDATE jobs SET status=\'FAILED\', completed_at=now(), error=$1 WHERE id=$2`, [
    error, id
  ]);
}

export async function recoverStaleJobs(workerId: string, timeoutMinutes: number): Promise<void> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
  await db.query(`UPDATE jobs SET status=\'PENDING\', worker_id=NULL, started_at=NULL WHERE status=\'PROCESSING\' AND worker_id=$1 AND started_at<$2`, [
    workerId, cutoff
  ]);
}

export async function startQueryRun(queryId: number, logId: number): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE queries SET last_executed=now(), times_executed=times_executed+1 WHERE id=$1", [queryId]);
  await db.query("INSERT INTO query_execution_logs(id,query_id,started_at,status) VALUES($1,$2,now(),'RUNNING')", [logId, queryId]);
}

export async function completeQueryRun(logId: number, channelsFound: number, newChannelsFound: number, metadata: object): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE query_execution_logs SET ended_at=now(), status='COMPLETED', channels_found=$1, new_channels_found=$2, metadata=$3 WHERE id=$4", [
    channelsFound, newChannelsFound, JSON.stringify(metadata), logId
  ]);
}

export async function failQueryRun(logId: number, error: string): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE query_execution_logs SET ended_at=now(), status='FAILED', error=$1 WHERE id=$2", [
    error, logId
  ]);
}

export async function tryReserveQuota(keyIndex: number, units: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.query("UPDATE quota_tracker SET units_reserved=units_reserved+$1 WHERE id='youtube' AND (units_used+units_reserved+$1)<=(daily_limit*($2+1)) RETURNING id", [
    units, keyIndex
  ]);
  return res.rowCount > 0;
}

export async function finishQuotaReservation(keyIndex: number, units: number, isConsumed: boolean): Promise<void> {
  const db = await getDb();
  if (isConsumed) {
    await db.query("UPDATE quota_tracker SET units_used=units_used+$1, units_reserved=units_reserved-$1 WHERE id='youtube' AND (units_used+units_reserved)>=$1 AND units_reserved>=$1", [
      units
    ]);
  } else {
    await db.query("UPDATE quota_tracker SET units_reserved=units_reserved-$1 WHERE id='youtube' AND units_reserved>=$1", [
      units
    ]);
  }
}

export async function heartbeatJob(id: number): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE jobs SET last_heartbeat=now() WHERE id=$1", [id]);
}

export async function recordQueryRunSightings(queryId: number, channelIds: string[]): Promise<void> {
  const db = await getDb();
  for (const channelId of channelIds) {
    await db.query("INSERT INTO query_channel_sightings(query_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [
      queryId, channelId
    ]);
  }
}

export async function acquireSchedulerLock(name: string, workerId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query("UPDATE scheduler_state SET is_running=TRUE, last_run_at=now(), current_worker_id=$1 WHERE name=$2 AND is_running=FALSE RETURNING id", [
    workerId, name
  ]);
  return res.rowCount > 0;
}

export async function releaseSchedulerLock(name: string, lastReport: object, nextScheduledTime?: string): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE scheduler_state SET is_running=FALSE, last_report=$1, next_run_at=$2, current_worker_id=NULL WHERE name=$3", [
    JSON.stringify(lastReport), nextScheduledTime || null, name
  ]);
}

export async function getAutonomousSchedulingSnapshot(): Promise<{ queueDepth: number; autonomousUnitsUsed: number; autonomousUnitsReserved: number }> {
  const db = await getDb();
  const queueDepthRes = await db.query("SELECT COUNT(*)::int FROM jobs WHERE status=\'PENDING\' AND type=\'SEARCH_YOUTUBE\'");
  const quotaRes = await db.query("SELECT units_used, units_reserved FROM quota_tracker WHERE id=\'youtube\'");
  return {
    queueDepth: queueDepthRes.rows[0].count,
    autonomousUnitsUsed: quotaRes.rows[0]?.units_used || 0,
    autonomousUnitsReserved: quotaRes.rows[0]?.units_reserved || 0,
  };
}

export async function scheduleAutonomousQueryRuns(runs: Array<{ query: QueryRecord; strategy: string; reason: string }>, workerId: string, cooldownMinutes: number): Promise<QueryRecord[]> {
  const db = await getDb();
  const scheduledQueries: QueryRecord[] = [];
  for (const run of runs) {
    const newQuery = { ...run.query, last_executed: new Date().toISOString(), times_executed: run.query.times_executed + 1 };
    await upsertQuery(newQuery);
    const logId = Math.floor(Math.random() * 1_000_000_000);
    await addQueryExecutionLog({ id: logId, query_id: newQuery.id, started_at: new Date().toISOString(), status: 'PENDING', channels_found: 0, new_channels_found: 0, metadata: { strategy: run.strategy, reason: run.reason, workerId } });
    scheduledQueries.push(newQuery);
  }
  return scheduledQueries;
}

export async function setAppSetting(name: string, value: string): Promise<void> {
  const db = await getDb();
  await db.query("INSERT INTO app_settings(name,value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=excluded.value", [
    name, value
  ]);
}

export async function performManualDatabaseBackup(): Promise<string> {
  const db = await getDb();
  const client = await db.connect();
  try {
    const backupPath = `/tmp/backup_${new Date().toISOString()}.sql`;
    // This is a placeholder. In a real application, you would use pg_dump or a similar tool.
    // For this exercise, we'll just create a dummy file.
    fs.writeFileSync(backupPath, "-- Dummy database backup\nSELECT 1;\n");
    return backupPath;
  } finally {
    client.release();
  }
}

export async function getAllQueries(): Promise<QueryRecord[]> {
  const db = await getDb();
  const res = await db.query("SELECT * FROM queries ORDER BY created_at DESC");
  return res.rows.map(rowToQuery);
}

export async function getRecentQueryExecutionLogs(limit: number): Promise<QueryExecutionLog[]> {
  const db = await getDb();
  const res = await db.query("SELECT * FROM query_execution_logs ORDER BY started_at DESC LIMIT $1", [limit]);
  return res.rows.map(rowToQueryExecutionLog);
}

export async function setQueryCollection(queryId: number, collection: string): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE queries SET collection=$1 WHERE id=$2", [collection, queryId]);
}

export async function purgeSyntheticTestChannels(): Promise<void> {
  const db = await getDb();
  await db.query("DELETE FROM channels WHERE discovery_source=\'SYNTHETIC_TEST\'");
}
