import dotenv from 'dotenv';
dotenv.config();
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { runMigrations, upsertChannel, saveCountryVocabulary, addExcludedCountry, toggleQueuePause, setAppSetting, upsertQueryRecord, addQueryExecutionLog, saveExtractedTerm, getAllChannels, getCountryVocabularies, getExcludedCountries, getAllQueries, getRecentQueryExecutionLogs, getExtractedVocabulary } from '../server/db';

const requireFn = createRequire(import.meta.url);
const DB_DIR = path.join(process.cwd(), 'data');
const PRIMARY = path.join(DB_DIR, 'trading_engine.db');
const BACKUP = path.join(DB_DIR, 'trading_engine.backup.db');
const REPORT_DIR = path.join(DB_DIR, 'migration-reports');
const ARCHIVE_DIR = path.join(DB_DIR, 'archive');

type CountMap = Record<string, number>;

function requireFile(file: string): Buffer {
  if (!fs.existsSync(file)) throw new Error(`Required SQL.js database file not found: ${file}`);
  return fs.readFileSync(file);
}

async function openSqlJsDb() {
  const wasmPath = path.join(path.dirname(requireFn.resolve('sql.js')), 'sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const buf = requireFile(PRIMARY);
  try {
    const db = new SQL.Database(buf);
    db.exec('SELECT name FROM sqlite_master LIMIT 1');
    return db;
  } catch (err) {
    throw new Error(`Failed to load primary SQL.js database. Refusing to silently initialize a new DB. Error: ${err}`);
  }
}

function rows(db: any, table: string): any[] {
  const exists = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
  if (!exists.length) return [];
  const res = db.exec(`SELECT * FROM ${table}`);
  if (!res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map((vals: any[]) => Object.fromEntries(cols.map((c: string, i: number) => [c, vals[i]])));
}

function countRows(db: any, tables: string[]): CountMap {
  const out: CountMap = {};
  for (const t of tables) out[t] = rows(db, t).length;
  return out;
}

function parseJson(value: any, fallback: any) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function archiveLegacyFiles(timestamp: string) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  for (const file of [PRIMARY, BACKUP]) {
    if (fs.existsSync(file)) {
      const dest = path.join(ARCHIVE_DIR, `${path.basename(file, '.db')}.pre-postgres-${timestamp}.db`);
      fs.copyFileSync(file, dest);
      console.log(`[Archive] Copied ${file} -> ${dest}`);
    }
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL migration.');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const db = await openSqlJsDb();
  const tables = ['channels','country_vocabularies','excluded_countries','queue_controls','quota_tracker','app_settings','query_library','query_execution_logs','extracted_trading_vocabulary','search_jobs_queue'];
  const sourceCounts = countRows(db, tables);
  archiveLegacyFiles(timestamp);
  await runMigrations();

  for (const r of rows(db, 'country_vocabularies')) await saveCountryVocabulary({ country: r.country, languages: parseJson(r.languages, []), native_trading_terminology: parseJson(r.native_trading_terminology, []), popular_instruments: parseJson(r.popular_instruments, []), local_market_phrases: parseJson(r.local_market_phrases, []), common_content_format_names: parseJson(r.common_content_format_names, []) });
  for (const r of rows(db, 'excluded_countries')) await addExcludedCountry({ country_name: r.country_name, reason: r.reason });
  for (const r of rows(db, 'queue_controls')) await toggleQueuePause(r.queue_name, !!r.is_paused);
  for (const r of rows(db, 'app_settings')) await setAppSetting(r.setting_key, r.setting_value);

  for (const r of rows(db, 'channels')) await upsertChannel({
    channel_id: r.channel_id, channel_name: r.channel_name, youtube_url: r.youtube_url, country: r.country,
    country_status: r.country_status, confidence_score: r.confidence_score || 0, discord_status: r.discord_status,
    discord_invite: r.discord_invite || null, scan_status: r.scan_status, scan_attempts: r.scan_attempts || 0,
    discovery_source: r.discovery_source, first_seen: r.first_seen, last_checked: r.last_checked || null,
    inspection_trail: parseJson(r.inspection_trail, []), subscriber_count: r.subscriber_count || undefined,
    channel_thumbnail_url: r.channel_thumbnail_url || undefined, quality_score: r.quality_score || 0,
    quality_breakdown: parseJson(r.quality_breakdown, undefined), trading_status: r.trading_status || 'UNCERTAIN',
    trading_confidence_score: r.trading_confidence_score || 0, trading_category: r.trading_category || 'General Trading',
    trading_relevance_breakdown: parseJson(r.trading_relevance_breakdown, undefined)
  } as any);

  const queryIdMap = new Map<number, number>();
  for (const r of rows(db, 'query_library')) {
    const q = await upsertQueryRecord({ query: r.query, country: r.country, collection: r.collection, intent: r.intent });
    queryIdMap.set(r.id, q.id);
  }
  for (const r of rows(db, 'query_execution_logs')) await addQueryExecutionLog({ query_id: r.query_id ? queryIdMap.get(r.query_id) : undefined, query: r.query, country: r.country, executed_at: r.executed_at, channels_discovered: r.channels_discovered || 0, unique_new_channels: r.unique_new_channels || 0, quality_creators_discovered: r.quality_creators_discovered || 0, communities_discovered: r.communities_discovered || 0, cycle_quality_score: r.cycle_quality_score || 0, logs: parseJson(r.logs, []) });
  for (const r of rows(db, 'extracted_trading_vocabulary')) {
    for (let i = 0; i < Math.max(1, r.occurrences || 1); i++) await saveExtractedTerm(r.country, r.term, r.category, r.source_channel_id || undefined);
  }

  const targetCounts: CountMap = {
    channels: (await getAllChannels()).length,
    country_vocabularies: (await getCountryVocabularies()).length,
    excluded_countries: (await getExcludedCountries()).length,
    query_library: (await getAllQueries()).length,
    query_execution_logs: (await getRecentQueryExecutionLogs(100000)).length,
    extracted_trading_vocabulary: (await getExtractedVocabulary()).length
  };
  const mismatches = Object.entries(targetCounts).filter(([k, v]) => sourceCounts[k] !== undefined && sourceCounts[k] > v);
  const samples = { sourceFirstChannel: rows(db, 'channels')[0] || null, targetFirstChannel: (await getAllChannels())[0] || null };
  const report = { timestamp, source: PRIMARY, sourceCounts, targetCounts, mismatches, samples, success: mismatches.length === 0 };
  const reportPath = path.join(REPORT_DIR, `sqljs-to-postgres-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[Migration] Report written to ${reportPath}`);
  if (mismatches.length) throw new Error(`Migration validation failed: ${JSON.stringify(mismatches)}`);
}

main().catch(err => { console.error('[Migration] Failed:', err); process.exit(1); });
