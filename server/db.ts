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

function rowToQuery(r:any):QueryRecord{return {id:r.id,query:r.query,country:r.country,collection:r.collection,intent:r.intent,times_executed:r.times_executed||0,last_executed:iso(r.last_executed),total_channels_found:r.total_channels_found||0,unique_channels_found:r.unique_channels_found||0,quality_channels_found:r.quality_channels_found||0,community_channels_found:r.community_channels_found||0,avg_quality_score:r.avg_quality_score||0,performance_score:r.performance_score||0,created_at:iso(r.created_at)||new Date().toISOString(),status:r.status||'ACTIVE',knowledge_tiers:r.knowledge_tiers||[1],generation_mode:r.generation_mode||'LEGACY',generation_reason:r.generation_reason||'Legacy query',discovery_objective:r.discovery_objective||'Discover relevant trading creators.',primary_term:r.primary_term||undefined,generation_metadata:parseJson(r.generation_metadata,{})};}
export async function getAllQueries():Promise<QueryRecord[]>{const db=await getDb(); const res=await db.query('SELECT * FROM query_library ORDER BY performance_score DESC,times_executed DESC'); return res.rows.map(rowToQuery);}
export async function getQueriesByCountry(country:string):Promise<QueryRecord[]>{return (await getAllQueries()).filter(q=>q.country.toLowerCase()===country.toLowerCase()&&q.status==='ACTIVE');}
export async function getQueryByText(queryText:string):Promise<QueryRecord|null>{const db=await getDb(); const res=await db.query('SELECT * FROM query_library WHERE LOWER(query)=LOWER($1)',[queryText.trim()]); return res.rows[0]?rowToQuery(res.rows[0]):null;}
export async function upsertQueryRecord(record:{query:string;country:string;collection:'PROVEN'|'EXPERIMENTAL'|'REJECTED';intent:string;knowledgeTiers?:number[];generationMode?:string;generationReason?:string;discoveryObjective?:string;primaryTerm?:string;generationMetadata?:Record<string,unknown>;}):Promise<QueryRecord>{const db=await getDb(); const res=await db.query(`INSERT INTO query_library(query,country,collection,intent,knowledge_tiers,generation_mode,generation_reason,discovery_objective,primary_term,generation_metadata,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT(query) DO UPDATE SET collection=excluded.collection,intent=excluded.intent,knowledge_tiers=excluded.knowledge_tiers,generation_mode=excluded.generation_mode,generation_reason=excluded.generation_reason,discovery_objective=excluded.discovery_objective,primary_term=excluded.primary_term,generation_metadata=excluded.generation_metadata RETURNING *`,[record.query.trim(),record.country,record.collection,record.intent,record.knowledgeTiers||[1],record.generationMode||'LEGACY',record.generationReason||'Legacy query',record.discoveryObjective||'Discover relevant trading creators.',record.primaryTerm||null,JSON.stringify(record.generationMetadata||{})]); return rowToQuery(res.rows[0]);}

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
export async function enqueueJob(type:string,payload:any,opts:{priority?:number;maxAttempts?:number;runAfter?:string;idempotencyKey?:string}={}):Promise<DurableJob>{const db=await getDb(); const res=await db.query(`INSERT INTO jobs(type,payload,priority,max_attempts,run_after,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO UPDATE SET payload=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN excluded.payload ELSE jobs.payload END,status=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN 'PENDING' ELSE jobs.status END,attempts=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN 0 ELSE jobs.attempts END,run_after=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN excluded.run_after ELSE jobs.run_after END,locked_by=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.locked_by END,locked_at=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.locked_at END,last_error=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.last_error END,completed_at=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN NULL ELSE jobs.completed_at END,updated_at=CASE WHEN jobs.status IN ('COMPLETED','FAILED') THEN now() ELSE jobs.updated_at END RETURNING *`,[type,JSON.stringify(payload),opts.priority||0,opts.maxAttempts||3,opts.runAfter||new Date().toISOString(),opts.idempotencyKey||null]); return rowToJob(res.rows[0]);}
function rowToJob(r:any):DurableJob{return {id:r.id,type:r.type,status:r.status,payload:parseJson(r.payload,{}),attempts:r.attempts,max_attempts:r.max_attempts,run_after:iso(r.run_after)||'',locked_by:r.locked_by,locked_at:iso(r.locked_at),last_error:r.last_error,created_at:iso(r.created_at)||''};}
export async function claimNextJob(workerId:string,types?:string[]):Promise<DurableJob|null>{const db=await getDb(); const client=await db.connect(); try{await client.query('BEGIN'); const res=await client.query(`SELECT * FROM jobs WHERE status='PENDING' AND run_after<=now() AND ($1::text[] IS NULL OR type=ANY($1)) ORDER BY priority DESC,created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`,[types||null]); if(!res.rowCount){await client.query('COMMIT'); return null;} const job=res.rows[0]; const upd=await client.query(`UPDATE jobs SET status='PROCESSING',locked_by=$1,locked_at=now(),attempts=attempts+1,updated_at=now() WHERE id=$2 RETURNING *`,[workerId,job.id]); await client.query(`INSERT INTO job_attempts(job_id,attempt_number,status) VALUES($1,$2,'PROCESSING')`,[job.id,upd.rows[0].attempts]); await client.query('COMMIT'); return rowToJob(upd.rows[0]);}catch(e){await client.query('ROLLBACK'); throw e;}finally{client.release();}}
export async function completeJob(jobId:string):Promise<void>{const db=await getDb(); await db.query(`UPDATE jobs SET status='COMPLETED',completed_at=now(),locked_by=NULL,locked_at=NULL,updated_at=now() WHERE id=$1`,[jobId]); await db.query(`UPDATE job_attempts SET status='COMPLETED',finished_at=now() WHERE job_id=$1 AND finished_at IS NULL`,[jobId]);}
export async function failJob(jobId:string,error:any):Promise<void>{const db=await getDb(); const res=await db.query('SELECT attempts,max_attempts FROM jobs WHERE id=$1',[jobId]); if(!res.rowCount)return; const {attempts,max_attempts}=res.rows[0]; const msg=String(error?.message||error).slice(0,2000); if(attempts>=max_attempts){await db.query(`UPDATE jobs SET status='FAILED',last_error=$2,locked_by=NULL,locked_at=NULL,updated_at=now() WHERE id=$1`,[jobId,msg]);}else{const seconds=Math.min(900,30*Math.pow(2,Math.max(0,attempts-1))); await db.query(`UPDATE jobs SET status='PENDING',last_error=$2,locked_by=NULL,locked_at=NULL,run_after=now()+($3||' seconds')::interval,updated_at=now() WHERE id=$1`,[jobId,msg,String(seconds)]);} await db.query(`UPDATE job_attempts SET status='FAILED',finished_at=now(),error=$2 WHERE job_id=$1 AND finished_at IS NULL`,[jobId,msg]);}
export async function recoverStaleJobs(staleAfterMinutes=15):Promise<number>{const db=await getDb(); const res=await db.query(`UPDATE jobs SET status='PENDING',locked_by=NULL,locked_at=NULL,updated_at=now(),last_error=COALESCE(last_error,'Recovered stale processing lock') WHERE status='PROCESSING' AND locked_at < now()-($1||' minutes')::interval RETURNING id`,[String(staleAfterMinutes)]); return res.rowCount||0;}

export async function getSchedulerState(name='autonomous_discovery'):Promise<any>{const db=await getDb(); const res=await db.query('SELECT * FROM scheduler_state WHERE name=$1',[name]); return res.rows[0]||null;}
export async function updateSchedulerState(name:string,patch:Record<string,any>):Promise<void>{const db=await getDb(); const current=await getSchedulerState(name); if(!current) await db.query('INSERT INTO scheduler_state(name) VALUES($1) ON CONFLICT DO NOTHING',[name]); const sets=Object.keys(patch).map((k,i)=>`${k}=$${i+2}`).join(','); if(sets) await db.query(`UPDATE scheduler_state SET ${sets},updated_at=now() WHERE name=$1`,[name,...Object.values(patch).map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v)]);}
export async function acquireSchedulerLock(name:string,workerId:string,staleAfterMinutes=15):Promise<boolean>{const db=await getDb(); const res=await db.query(`UPDATE scheduler_state SET is_running=true,locked_by=$2,locked_at=now(),updated_at=now() WHERE name=$1 AND is_enabled=true AND (locked_at IS NULL OR locked_at < now()-($3||' minutes')::interval OR is_running=false)`,[name,workerId,String(staleAfterMinutes)]); return !!res.rowCount;}
export async function releaseSchedulerLock(name:string,report?:any,nextRunAt?:string):Promise<void>{const db=await getDb(); await db.query(`UPDATE scheduler_state SET is_running=false,locked_by=NULL,locked_at=NULL,last_run_at=now(),next_run_at=$2,last_report=$3,updated_at=now() WHERE name=$1`,[name,nextRunAt||null,report?JSON.stringify(report):null]);}
  
