import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ChannelRecord, CountryVocabulary, ExcludedCountry, SearchJob, QueueStatus, QueryRecord, QueryExecutionLog, ExtractedTermRecord } from '../src/types';
import { INITIAL_COUNTRY_VOCABULARIES, INITIAL_EXCLUDED_COUNTRIES } from '../src/data/initial_countries';
import { getConfiguredYouTubeKeys } from './youtubeKeyPool';
import { youtubeProviderCooldown, type YouTubeProviderOperationalStatus } from './youtubeProviderCooldown';

const requireFn = typeof require !== 'undefined' ? require : createRequire(import.meta.url);

const DB_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'trading_engine.db');
const DB_BACKUP_FILE = path.join(DB_DIR, 'trading_engine.backup.db');

let dbInstance: Database | null = null;
let dbInitPromise: Promise<Database> | null = null;
let saveCount = 0;

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    if (dbInstance) return dbInstance;

    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }

    const init = typeof initSqlJs === 'function' ? initSqlJs : (initSqlJs as any).default;
    let SQL: any;
    try {
      const wasmPath = path.join(path.dirname(requireFn.resolve('sql.js')), 'sql-wasm.wasm');
      SQL = await init({
        locateFile: () => wasmPath
      });
    } catch (err) {
      console.warn('initSqlJs locateFile fallback:', err);
      SQL = await init();
    }

    const tryLoadCandidate = (buffer: Buffer): Database | null => {
      try {
        const candidate = new SQL.Database(buffer);
        // Validate database health
        candidate.exec('SELECT name FROM sqlite_master LIMIT 1;');
        return candidate;
      } catch (err) {
        console.warn('Database buffer failed health validation:', err);
        return null;
      }
    };

    let loadedDb: Database | null = null;

    // 1. Try loading primary DB file
    if (fs.existsSync(DB_FILE)) {
      try {
        const primaryBuf = fs.readFileSync(DB_FILE);
        loadedDb = tryLoadCandidate(primaryBuf);
        if (loadedDb) {
          console.log('Successfully loaded primary SQLite database.');
        }
      } catch (err) {
        console.warn('Primary database read failed:', err);
      }
    }

    // 2. Fallback to backup DB file if primary failed or missing
    if (!loadedDb && fs.existsSync(DB_BACKUP_FILE)) {
      try {
        const backupBuf = fs.readFileSync(DB_BACKUP_FILE);
        loadedDb = tryLoadCandidate(backupBuf);
        if (loadedDb) {
          console.log('Successfully recovered SQLite database from backup snapshot!');
        }
      } catch (err) {
        console.warn('Backup database read failed:', err);
      }
    }

    // 3. Fallback to clean fresh database if all buffers failed or missing
    if (!loadedDb) {
      console.log('Initializing clean SQLite database instance.');
      loadedDb = new SQL.Database();
    }

    dbInstance = loadedDb;
    initTables(dbInstance);

    try {
      const countRes = dbInstance.exec("SELECT COUNT(*) FROM channels;");
      const channelCount = countRes[0]?.values[0]?.[0] || 0;
      console.log(`[DB Persistence] Successfully restored ${channelCount} channels from SQLite database.`);
    } catch (_) {
      // Ignore initial count error on empty DB
    }

    saveDb();

    return dbInstance;
  })();

  return dbInitPromise;
}

// Register process exit listeners for graceful shutdown & atomic save
process.on('SIGINT', () => {
  console.log('[DB Persistence] Received SIGINT. Synchronizing database to disk...');
  saveDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[DB Persistence] Received SIGTERM. Synchronizing database to disk...');
  saveDb();
  process.exit(0);
});

process.on('beforeExit', () => {
  saveDb();
});

export function saveDb(): void {
  if (!dbInstance) return;
  try {
    // Flush any pending WAL/memory transaction pages to main SQLite page header before export
    try {
      dbInstance.exec('COMMIT;');
    } catch (_) {
      // Ignore if no transaction was currently open
    }

    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    
    // Atomic write to prevent file corruption
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, buffer);
    fs.renameSync(tmpFile, DB_FILE);

    // Create / update SQLite backup snapshot on every 5th save or if backup does not exist
    saveCount++;
    if (saveCount % 5 === 0 || !fs.existsSync(DB_BACKUP_FILE)) {
      const tmpBackupFile = `${DB_BACKUP_FILE}.tmp`;
      fs.writeFileSync(tmpBackupFile, buffer);
      fs.renameSync(tmpBackupFile, DB_BACKUP_FILE);
    }
  } catch (err) {
    console.error('Error persisting database to disk:', err);
  }
}

export async function performManualDatabaseBackup(): Promise<{ success: boolean; timestamp: string; backupPath: string }> {
  const db = await getDb();
  const data = db.export();
  const buffer = Buffer.from(data);
  const timestamp = new Date().toISOString();
  const tmpBackup = `${DB_BACKUP_FILE}.tmp`;
  fs.writeFileSync(tmpBackup, buffer);
  fs.renameSync(tmpBackup, DB_BACKUP_FILE);
  return { success: true, timestamp, backupPath: DB_BACKUP_FILE };
}

function initTables(db: Database): void {
  // Ensure schema_migrations table exists
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // Migration definitions list
  const migrations: Array<{ version: number; name: string; run: (db: Database) => void }> = [
    {
      version: 1,
      name: '001_initial_schema',
      run: (db) => {
        db.run(`
          CREATE TABLE IF NOT EXISTS channels (
            channel_id TEXT PRIMARY KEY,
            channel_name TEXT NOT NULL,
            youtube_url TEXT NOT NULL,
            country TEXT NOT NULL,
            country_status TEXT NOT NULL,
            confidence_score INTEGER NOT NULL,
            discord_status TEXT NOT NULL,
            discord_invite TEXT,
            scan_status TEXT NOT NULL,
            scan_attempts INTEGER DEFAULT 0,
            discovery_source TEXT NOT NULL,
            first_seen TEXT NOT NULL,
            last_checked TEXT,
            next_check TEXT NOT NULL,
            inspection_trail TEXT,
            subscriber_count TEXT,
            channel_thumbnail_url TEXT
          );

          CREATE TABLE IF NOT EXISTS country_vocabularies (
            country TEXT PRIMARY KEY,
            languages TEXT NOT NULL,
            native_trading_terminology TEXT NOT NULL,
            popular_instruments TEXT NOT NULL,
            local_market_phrases TEXT NOT NULL,
            common_content_format_names TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS excluded_countries (
            country_name TEXT PRIMARY KEY,
            reason TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS search_jobs_queue (
            id TEXT PRIMARY KEY,
            query TEXT NOT NULL,
            country TEXT NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            createdAt TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS queue_controls (
            queue_name TEXT PRIMARY KEY,
            is_paused INTEGER DEFAULT 0
          );

          CREATE TABLE IF NOT EXISTS quota_tracker (
            id TEXT PRIMARY KEY,
            units_used INTEGER DEFAULT 0,
            daily_limit INTEGER DEFAULT 10000,
            last_reset TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS app_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL
          );
        `);
      }
    },
    {
      version: 2,
      name: '002_add_channel_indexes',
      run: (db) => {
        db.run(`
          CREATE INDEX IF NOT EXISTS idx_channels_country ON channels(country);
          CREATE INDEX IF NOT EXISTS idx_channels_scan_status ON channels(scan_status);
          CREATE INDEX IF NOT EXISTS idx_channels_discord_status ON channels(discord_status);
          CREATE INDEX IF NOT EXISTS idx_channels_next_check ON channels(next_check);
        `);
      }
    },
    {
      version: 3,
      name: '003_ensure_additive_column_integrity',
      run: (db) => {
        // Dynamic helper to safely ensure columns exist without dropping tables or losing records
        const ensureColumn = (table: string, column: string, colDef: string) => {
          const info = db.exec(`PRAGMA table_info(${table})`);
          if (info.length && info[0].values) {
            const hasCol = info[0].values.some((row: any[]) => row[1] === column);
            if (!hasCol) {
              db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${colDef}`);
            }
          }
        };

        ensureColumn('channels', 'subscriber_count', 'TEXT');
        ensureColumn('channels', 'channel_thumbnail_url', 'TEXT');
      }
    },
    {
      version: 4,
      name: '004_query_intelligence_engine',
      run: (db) => {
        db.run(`
          CREATE TABLE IF NOT EXISTS query_library (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT UNIQUE NOT NULL,
            country TEXT NOT NULL,
            collection TEXT NOT NULL,
            intent TEXT NOT NULL,
            times_executed INTEGER DEFAULT 0,
            last_executed TEXT,
            total_channels_found INTEGER DEFAULT 0,
            unique_channels_found INTEGER DEFAULT 0,
            quality_channels_found INTEGER DEFAULT 0,
            community_channels_found INTEGER DEFAULT 0,
            avg_quality_score REAL DEFAULT 0.0,
            performance_score REAL DEFAULT 0.0,
            created_at TEXT NOT NULL,
            status TEXT DEFAULT 'ACTIVE'
          );

          CREATE TABLE IF NOT EXISTS query_execution_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query_id INTEGER,
            query TEXT NOT NULL,
            country TEXT NOT NULL,
            executed_at TEXT NOT NULL,
            channels_discovered INTEGER DEFAULT 0,
            unique_new_channels INTEGER DEFAULT 0,
            quality_creators_discovered INTEGER DEFAULT 0,
            communities_discovered INTEGER DEFAULT 0,
            cycle_quality_score REAL DEFAULT 0.0,
            logs TEXT
          );

          CREATE TABLE IF NOT EXISTS extracted_trading_vocabulary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            country TEXT NOT NULL,
            term TEXT NOT NULL,
            category TEXT NOT NULL,
            source_channel_id TEXT,
            occurrences INTEGER DEFAULT 1,
            first_extracted TEXT NOT NULL,
            last_extracted TEXT NOT NULL,
            UNIQUE(country, term)
          );

          CREATE INDEX IF NOT EXISTS idx_query_country ON query_library(country);
          CREATE INDEX IF NOT EXISTS idx_query_collection ON query_library(collection);
          CREATE INDEX IF NOT EXISTS idx_extracted_vocab_country ON extracted_trading_vocabulary(country);
        `);

        const ensureColumn = (table: string, column: string, colDef: string) => {
          const info = db.exec(`PRAGMA table_info(${table})`);
          if (info.length && info[0].values) {
            const hasCol = info[0].values.some((row: any[]) => row[1] === column);
            if (!hasCol) {
              db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${colDef}`);
            }
          }
        };

        ensureColumn('channels', 'quality_score', 'INTEGER DEFAULT 0');
        ensureColumn('channels', 'quality_breakdown', 'TEXT');
      }
    }
  ];

  // Execute unapplied migrations
  for (const m of migrations) {
    const check = db.exec(`SELECT version FROM schema_migrations WHERE version = ${m.version}`);
    if (!check.length || !check[0].values.length) {
      db.run('BEGIN TRANSACTION');
      try {
        m.run(db);
        const appliedAt = new Date().toISOString();
        db.run(
          `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
          [m.version, m.name, appliedAt]
        );
        db.run(`PRAGMA user_version = ${m.version}`);
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        console.error(`Failed to apply database migration v${m.version} (${m.name}):`, err);
        throw err;
      }
    }
  }

  // Ensure additive column integrity unconditionally for existing database instances
  const ensureColumn = (table: string, column: string, colDef: string) => {
    try {
      const info = db.exec(`PRAGMA table_info(${table})`);
      if (info.length && info[0].values) {
        const hasCol = info[0].values.some((row: any[]) => row[1] === column);
        if (!hasCol) {
          db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${colDef}`);
        }
      }
    } catch (e) {
      console.warn(`Column check warning for ${table}.${column}:`, e);
    }
  };

  ensureColumn('channels', 'subscriber_count', 'TEXT');
  ensureColumn('channels', 'channel_thumbnail_url', 'TEXT');
  ensureColumn('channels', 'quality_score', 'INTEGER DEFAULT 0');
  ensureColumn('channels', 'quality_breakdown', 'TEXT');
  ensureColumn('channels', 'trading_status', "TEXT DEFAULT 'UNCERTAIN'");
  ensureColumn('channels', 'trading_confidence_score', 'INTEGER DEFAULT 0');
  ensureColumn('channels', 'trading_category', "TEXT DEFAULT 'General Trading'");
  ensureColumn('channels', 'trading_relevance_breakdown', 'TEXT');

  // Initialize queue controls if empty
  const queues = ['search_jobs', 'channel_processing', 'discord_validation', 'recheck'];
  for (const q of queues) {
    const res = db.exec(`SELECT queue_name FROM queue_controls WHERE queue_name = '${q}'`);
    if (!res.length || !res[0].values.length) {
      db.run(`INSERT INTO queue_controls (queue_name, is_paused) VALUES ('${q}', 0)`);
    }
  }

  // Initialize quota tracker
  const today = new Date().toISOString().split('T')[0];
  const quotaRes = db.exec(`SELECT id FROM quota_tracker WHERE id = 'youtube'`);
  if (!quotaRes.length || !quotaRes[0].values.length) {
    db.run(`INSERT INTO quota_tracker (id, units_used, daily_limit, last_reset) VALUES ('youtube', 0, 10000, '${today}')`);
  }

  // Seed or sync default country vocabularies
  for (const v of INITIAL_COUNTRY_VOCABULARIES) {
    db.run(
      `INSERT OR IGNORE INTO country_vocabularies (country, languages, native_trading_terminology, popular_instruments, local_market_phrases, common_content_format_names)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        v.country,
        JSON.stringify(v.languages),
        JSON.stringify(v.native_trading_terminology),
        JSON.stringify(v.popular_instruments),
        JSON.stringify(v.local_market_phrases),
        JSON.stringify(v.common_content_format_names)
      ]
    );
  }

  // Seed default excluded countries if empty
  const exclRes = db.exec(`SELECT country_name FROM excluded_countries LIMIT 1`);
  if (!exclRes.length || !exclRes[0].values.length) {
    for (const e of INITIAL_EXCLUDED_COUNTRIES) {
      db.run(`INSERT INTO excluded_countries (country_name, reason) VALUES (?, ?)`, [e.country_name, e.reason]);
    }
  }

  // Print startup validation check
  const allExcl = db.exec(`SELECT country_name, reason FROM excluded_countries ORDER BY country_name ASC`);
  console.log('======================================================');
  console.log(`Excluded Countries Loaded (${allExcl[0]?.values?.length || 0} Regions Active):`);
  if (allExcl.length && allExcl[0].values) {
    for (const row of allExcl[0].values) {
      console.log(`✓ ${row[0]} (${row[1]})`);
    }
  }
  console.log('======================================================');
}

// Database Helper functions
export async function getAllChannels(): Promise<ChannelRecord[]> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM channels ORDER BY first_seen DESC`);
  const channels: ChannelRecord[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    channels.push({
      channel_id: row.channel_id as string,
      channel_name: row.channel_name as string,
      youtube_url: row.youtube_url as string,
      country: row.country as string,
      country_status: row.country_status as any,
      confidence_score: row.confidence_score as number,
      discord_status: row.discord_status as any,
      discord_invite: row.discord_invite as string || null,
      scan_status: row.scan_status as any,
      scan_attempts: row.scan_attempts as number,
      discovery_source: row.discovery_source as any,
      first_seen: row.first_seen as string,
      last_checked: row.last_checked as string || null,
      inspection_trail: row.inspection_trail ? JSON.parse(row.inspection_trail as string) : [],
      subscriber_count: row.subscriber_count as string || undefined,
      channel_thumbnail_url: row.channel_thumbnail_url as string || undefined,
      quality_score: typeof row.quality_score === 'number' ? row.quality_score : 0,
      quality_breakdown: row.quality_breakdown ? JSON.parse(row.quality_breakdown as string) : undefined,
      trading_status: (row.trading_status as any) || 'UNCERTAIN',
      trading_confidence_score: typeof row.trading_confidence_score === 'number' ? row.trading_confidence_score : 0,
      trading_category: (row.trading_category as string) || 'General Trading',
      trading_relevance_breakdown: row.trading_relevance_breakdown ? JSON.parse(row.trading_relevance_breakdown as string) : undefined
    });
  }
  stmt.free();
  return channels;
}

export async function getChannelById(channelId: string): Promise<ChannelRecord | null> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM channels WHERE channel_id = ?`);
  stmt.bind([channelId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return {
      channel_id: row.channel_id as string,
      channel_name: row.channel_name as string,
      youtube_url: row.youtube_url as string,
      country: row.country as string,
      country_status: row.country_status as any,
      confidence_score: row.confidence_score as number,
      discord_status: row.discord_status as any,
      discord_invite: row.discord_invite as string || null,
      scan_status: row.scan_status as any,
      scan_attempts: row.scan_attempts as number,
      discovery_source: row.discovery_source as any,
      first_seen: row.first_seen as string,
      last_checked: row.last_checked as string || null,
      inspection_trail: row.inspection_trail ? JSON.parse(row.inspection_trail as string) : [],
      subscriber_count: row.subscriber_count as string || undefined,
      channel_thumbnail_url: row.channel_thumbnail_url as string || undefined,
      quality_score: typeof row.quality_score === 'number' ? row.quality_score : 0,
      quality_breakdown: row.quality_breakdown ? JSON.parse(row.quality_breakdown as string) : undefined,
      trading_status: (row.trading_status as any) || 'UNCERTAIN',
      trading_confidence_score: typeof row.trading_confidence_score === 'number' ? row.trading_confidence_score : 0,
      trading_category: (row.trading_category as string) || 'General Trading',
      trading_relevance_breakdown: row.trading_relevance_breakdown ? JSON.parse(row.trading_relevance_breakdown as string) : undefined
    };
  }
  stmt.free();
  return null;
}

export async function upsertChannel(channel: ChannelRecord): Promise<void> {
  const db = await getDb();
  const existing = await getChannelById(channel.channel_id);
  if (existing) {
    db.run(
      `UPDATE channels SET 
        channel_name = ?, youtube_url = ?, country = ?, country_status = ?, confidence_score = ?,
        discord_status = ?, discord_invite = ?, scan_status = ?, scan_attempts = ?, discovery_source = ?,
        last_checked = ?, next_check = ?, inspection_trail = ?, subscriber_count = ?, channel_thumbnail_url = ?,
        quality_score = ?, quality_breakdown = ?, trading_status = ?, trading_confidence_score = ?,
        trading_category = ?, trading_relevance_breakdown = ?
       WHERE channel_id = ?`,
      [
        channel.channel_name,
        channel.youtube_url,
        channel.country,
        channel.country_status,
        channel.confidence_score,
        channel.discord_status,
        channel.discord_invite || null,
        channel.scan_status,
        channel.scan_attempts,
        channel.discovery_source,
        channel.last_checked || null,
        "", // legacy column
        JSON.stringify(channel.inspection_trail || []),
        channel.subscriber_count || null,
        channel.channel_thumbnail_url || null,
        channel.quality_score || 0,
        channel.quality_breakdown ? JSON.stringify(channel.quality_breakdown) : null,
        channel.trading_status || 'UNCERTAIN',
        channel.trading_confidence_score || 0,
        channel.trading_category || 'General Trading',
        channel.trading_relevance_breakdown ? JSON.stringify(channel.trading_relevance_breakdown) : null,
        channel.channel_id
      ]
    );
  } else {
    db.run(
      `INSERT INTO channels (
        channel_id, channel_name, youtube_url, country, country_status, confidence_score,
        discord_status, discord_invite, scan_status, scan_attempts, discovery_source,
        first_seen, last_checked, next_check, inspection_trail, subscriber_count, channel_thumbnail_url,
        quality_score, quality_breakdown, trading_status, trading_confidence_score,
        trading_category, trading_relevance_breakdown
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        channel.channel_id,
        channel.channel_name,
        channel.youtube_url,
        channel.country,
        channel.country_status,
        channel.confidence_score,
        channel.discord_status,
        channel.discord_invite || null,
        channel.scan_status,
        channel.scan_attempts,
        channel.discovery_source,
        channel.first_seen,
        channel.last_checked || null,
        "", // legacy column
        JSON.stringify(channel.inspection_trail || []),
        channel.subscriber_count || null,
        channel.channel_thumbnail_url || null,
        channel.quality_score || 0,
        channel.quality_breakdown ? JSON.stringify(channel.quality_breakdown) : null,
        channel.trading_status || 'UNCERTAIN',
        channel.trading_confidence_score || 0,
        channel.trading_category || 'General Trading',
        channel.trading_relevance_breakdown ? JSON.stringify(channel.trading_relevance_breakdown) : null
      ]
    );
  }
  saveDb();
}

export async function getCountryVocabularies(): Promise<CountryVocabulary[]> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM country_vocabularies`);
  const vocabs: CountryVocabulary[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    vocabs.push({
      country: row.country as string,
      languages: JSON.parse(row.languages as string),
      native_trading_terminology: JSON.parse(row.native_trading_terminology as string),
      popular_instruments: JSON.parse(row.popular_instruments as string),
      local_market_phrases: JSON.parse(row.local_market_phrases as string),
      common_content_format_names: JSON.parse(row.common_content_format_names as string),
    });
  }
  stmt.free();
  return vocabs;
}

export async function saveCountryVocabulary(vocab: CountryVocabulary): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO country_vocabularies (country, languages, native_trading_terminology, popular_instruments, local_market_phrases, common_content_format_names)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      vocab.country,
      JSON.stringify(vocab.languages),
      JSON.stringify(vocab.native_trading_terminology),
      JSON.stringify(vocab.popular_instruments),
      JSON.stringify(vocab.local_market_phrases),
      JSON.stringify(vocab.common_content_format_names)
    ]
  );
  saveDb();
}

export async function getExcludedCountries(): Promise<ExcludedCountry[]> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM excluded_countries`);
  const list: ExcludedCountry[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    list.push({
      country_name: row.country_name as string,
      reason: row.reason as string,
    });
  }
  stmt.free();
  return list;
}

export async function addExcludedCountry(country: ExcludedCountry): Promise<void> {
  const db = await getDb();
  db.run(`INSERT OR REPLACE INTO excluded_countries (country_name, reason) VALUES (?, ?)`, [
    country.country_name,
    country.reason
  ]);
  saveDb();
}

export async function removeExcludedCountry(countryName: string): Promise<void> {
  const db = await getDb();
  db.run(`DELETE FROM excluded_countries WHERE country_name = ?`, [countryName]);
  saveDb();
}

export async function getQueueStatus(): Promise<QueueStatus> {
  const db = await getDb();
  
  // Search Jobs depth
  const stmt1 = db.prepare(`SELECT COUNT(*) as cnt FROM search_jobs_queue WHERE status = 'PENDING'`);
  stmt1.step();
  const searchDepth = (stmt1.getAsObject().cnt as number) || 0;
  stmt1.free();

  // Channel processing depth (LOCKED or PENDING scan_status)
  const stmt2 = db.prepare(`SELECT COUNT(*) as cnt FROM channels WHERE scan_status = 'PENDING'`);
  stmt2.step();
  const channelProcessingDepth = (stmt2.getAsObject().cnt as number) || 0;
  stmt2.free();

  // Discord validation queue (Channels with discord_status = 'PENDING' and scan_status = 'LOCKED')
  const stmt3 = db.prepare(`SELECT COUNT(*) as cnt FROM channels WHERE discord_status = 'PENDING' AND scan_status = 'LOCKED'`);
  stmt3.step();
  const discordValidationDepth = (stmt3.getAsObject().cnt as number) || 0;
  stmt3.free();

  // Queue paused states
  const controls = db.exec(`SELECT queue_name, is_paused FROM queue_controls`);
  const pausedMap: Record<string, boolean> = {};
  if (controls.length && controls[0].values) {
    for (const row of controls[0].values) {
      pausedMap[row[0] as string] = Boolean(row[1]);
    }
  }

  return {
    searchJobs: { depth: searchDepth, isPaused: !!pausedMap['search_jobs'] },
    channelProcessing: { depth: channelProcessingDepth, isPaused: !!pausedMap['channel_processing'] },
    discordValidation: { depth: discordValidationDepth, isPaused: !!pausedMap['discord_validation'] }
  };
}

export async function toggleQueuePause(queueName: string, isPaused: boolean): Promise<void> {
  const db = await getDb();
  db.run(`INSERT OR REPLACE INTO queue_controls (queue_name, is_paused) VALUES (?, ?)`, [queueName, isPaused ? 1 : 0]);
  saveDb();
}

export function getYouTubeKeyPool(): string[] {
  return getConfiguredYouTubeKeys();
}

export interface KeyQuotaUsage {
  keyIndex: number;
  maskedKey: string;
  unitsUsed: number;
  limit: number;
  isActive: boolean;
  status: YouTubeProviderOperationalStatus;
  retryAt: string | null;
}

export interface QuotaInfoExtended {
  unitsUsed: number;
  dailyLimit: number;
  lastReset: string;
  totalKeys: number;
  keyUsage: KeyQuotaUsage[];
}

export async function getQuota(): Promise<QuotaInfoExtended> {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0];
  const keyPool = getYouTubeKeyPool();
  const totalKeys = Math.max(1, keyPool.length);
  const calculatedDailyLimit = totalKeys * 10000;

  const stmt = db.prepare(`SELECT * FROM quota_tracker WHERE id = 'youtube'`);
  let unitsUsed = 0;
  let lastReset = today;

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    if (row.last_reset !== today) {
      db.run(`UPDATE quota_tracker SET units_used = 0, last_reset = ?, daily_limit = ? WHERE id = 'youtube'`, [today, calculatedDailyLimit]);
      saveDb();
      unitsUsed = 0;
      lastReset = today;
    } else {
      unitsUsed = (row.units_used as number) || 0;
      lastReset = (row.last_reset as string) || today;
      db.run(`UPDATE quota_tracker SET daily_limit = ? WHERE id = 'youtube'`, [calculatedDailyLimit]);
      saveDb();
    }
  } else {
    stmt.free();
    db.run(`INSERT INTO quota_tracker (id, units_used, daily_limit, last_reset) VALUES ('youtube', 0, ?, ?)`, [calculatedDailyLimit, today]);
    saveDb();
    unitsUsed = 0;
    lastReset = today;
  }

  const keyUsage: KeyQuotaUsage[] = keyPool.map((k, index) => {
    const quotaPerKey = 10000;
    const startShare = index * quotaPerKey;
    const keyUnitsUsed = Math.max(0, Math.min(quotaPerKey, unitsUsed - startShare));
    const maskedKey = k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : '****';
    const provider = youtubeProviderCooldown.status(k);
    return {
      keyIndex: index + 1,
      maskedKey,
      unitsUsed: keyUnitsUsed,
      limit: quotaPerKey,
      isActive: provider.status === 'Active',
      status: provider.status,
      retryAt: provider.retryAt === null ? null : new Date(provider.retryAt).toISOString()
    };
  });

  return {
    unitsUsed,
    dailyLimit: calculatedDailyLimit,
    lastReset,
    totalKeys,
    keyUsage
  };
}

export async function incrementQuota(units: number): Promise<void> {
  const quota = await getQuota();
  const newUnits = quota.unitsUsed + units;
  const db = await getDb();
  db.run(`UPDATE quota_tracker SET units_used = ? WHERE id = 'youtube'`, [newUnits]);
  saveDb();
}

export async function getSchemaInfo(): Promise<{
  currentVersion: number;
  migrations: Array<{ version: number; name: string; applied_at: string }>;
  channelCount: number;
}> {
  const db = await getDb();
  const verRes = db.exec(`PRAGMA user_version`);
  const currentVersion = (verRes.length && verRes[0].values.length) ? (verRes[0].values[0][0] as number) : 0;

  const migRes = db.exec(`SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC`);
  const migrations: Array<{ version: number; name: string; applied_at: string }> = [];
  if (migRes.length && migRes[0].values) {
    for (const row of migRes[0].values) {
      migrations.push({
        version: row[0] as number,
        name: row[1] as string,
        applied_at: row[2] as string
      });
    }
  }

  const chanRes = db.exec(`SELECT COUNT(*) FROM channels`);
  const channelCount = (chanRes.length && chanRes[0].values.length) ? (chanRes[0].values[0][0] as number) : 0;

  return { currentVersion, migrations, channelCount };
}

// --- QUERY INTELLIGENCE ENGINE DATABASE HELPERS ---

export async function getAllQueries(): Promise<QueryRecord[]> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM query_library ORDER BY performance_score DESC, times_executed DESC`);
  const list: QueryRecord[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    list.push({
      id: row.id as number,
      query: row.query as string,
      country: row.country as string,
      collection: row.collection as any,
      intent: row.intent as any,
      times_executed: row.times_executed as number || 0,
      last_executed: row.last_executed as string || null,
      total_channels_found: row.total_channels_found as number || 0,
      unique_channels_found: row.unique_channels_found as number || 0,
      quality_channels_found: row.quality_channels_found as number || 0,
      community_channels_found: row.community_channels_found as number || 0,
      avg_quality_score: row.avg_quality_score as number || 0,
      performance_score: row.performance_score as number || 0,
      created_at: row.created_at as string,
      status: (row.status as any) || 'ACTIVE'
    });
  }
  stmt.free();
  return list;
}

export async function getQueriesByCountry(country: string): Promise<QueryRecord[]> {
  const all = await getAllQueries();
  return all.filter(q => q.country.toLowerCase() === country.toLowerCase() && q.status === 'ACTIVE');
}

export async function getQueryByText(queryText: string): Promise<QueryRecord | null> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM query_library WHERE LOWER(query) = LOWER(?)`);
  stmt.bind([queryText.trim()]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return {
      id: row.id as number,
      query: row.query as string,
      country: row.country as string,
      collection: row.collection as any,
      intent: row.intent as any,
      times_executed: row.times_executed as number || 0,
      last_executed: row.last_executed as string || null,
      total_channels_found: row.total_channels_found as number || 0,
      unique_channels_found: row.unique_channels_found as number || 0,
      quality_channels_found: row.quality_channels_found as number || 0,
      community_channels_found: row.community_channels_found as number || 0,
      avg_quality_score: row.avg_quality_score as number || 0,
      performance_score: row.performance_score as number || 0,
      created_at: row.created_at as string,
      status: (row.status as any) || 'ACTIVE'
    };
  }
  stmt.free();
  return null;
}

export async function upsertQueryRecord(record: {
  query: string;
  country: string;
  collection: 'PROVEN' | 'EXPERIMENTAL' | 'REJECTED';
  intent: string;
}): Promise<QueryRecord> {
  const db = await getDb();
  const existing = await getQueryByText(record.query);
  const now = new Date().toISOString();

  if (existing) {
    db.run(
      `UPDATE query_library SET collection = ?, intent = ? WHERE id = ?`,
      [record.collection, record.intent, existing.id]
    );
    saveDb();
    return { ...existing, collection: record.collection, intent: record.intent as any };
  } else {
    db.run(
      `INSERT INTO query_library (query, country, collection, intent, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [record.query.trim(), record.country, record.collection, record.intent, now]
    );
    saveDb();
    const newlyCreated = await getQueryByText(record.query);
    return newlyCreated!;
  }
}

export async function updateQueryExecutionStats(
  queryId: number,
  stats: {
    totalChannelsFound: number;
    uniqueChannelsFound: number;
    qualityChannelsFound: number;
    communityChannelsFound: number;
    avgQualityScore: number;
    performanceScore: number;
    newCollection?: 'PROVEN' | 'EXPERIMENTAL' | 'REJECTED';
  }
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`SELECT * FROM query_library WHERE id = ?`);
  stmt.bind([queryId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();

    const timesExecuted = ((row.times_executed as number) || 0) + 1;
    const totalFound = ((row.total_channels_found as number) || 0) + stats.totalChannelsFound;
    const uniqueFound = ((row.unique_channels_found as number) || 0) + stats.uniqueChannelsFound;
    const qualityFound = ((row.quality_channels_found as number) || 0) + stats.qualityChannelsFound;
    const communityFound = ((row.community_channels_found as number) || 0) + stats.communityChannelsFound;

    // Rolling average of quality score
    const prevAvg = (row.avg_quality_score as number) || 0;
    const newAvgQuality = Math.round(((prevAvg * (timesExecuted - 1)) + stats.avgQualityScore) / timesExecuted);

    const collection = stats.newCollection || row.collection;

    db.run(
      `UPDATE query_library SET
        times_executed = ?,
        last_executed = ?,
        total_channels_found = ?,
        unique_channels_found = ?,
        quality_channels_found = ?,
        community_channels_found = ?,
        avg_quality_score = ?,
        performance_score = ?,
        collection = ?
       WHERE id = ?`,
      [
        timesExecuted,
        now,
        totalFound,
        uniqueFound,
        qualityFound,
        communityFound,
        newAvgQuality,
        stats.performanceScore,
        collection,
        queryId
      ]
    );
    saveDb();
  } else {
    stmt.free();
  }
}

export async function setQueryCollection(queryId: number, collection: 'PROVEN' | 'EXPERIMENTAL' | 'REJECTED'): Promise<void> {
  const db = await getDb();
  db.run(`UPDATE query_library SET collection = ? WHERE id = ?`, [collection, queryId]);
  saveDb();
}

export async function addQueryExecutionLog(log: {
  query_id?: number;
  query: string;
  country: string;
  executed_at: string;
  channels_discovered: number;
  unique_new_channels: number;
  quality_creators_discovered: number;
  communities_discovered: number;
  cycle_quality_score: number;
  logs?: string[];
}): Promise<void> {
  const db = await getDb();
  db.run(
    `INSERT INTO query_execution_logs (
      query_id, query, country, executed_at, channels_discovered, unique_new_channels,
      quality_creators_discovered, communities_discovered, cycle_quality_score, logs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.query_id || null,
      log.query,
      log.country,
      log.executed_at,
      log.channels_discovered,
      log.unique_new_channels,
      log.quality_creators_discovered,
      log.communities_discovered,
      log.cycle_quality_score,
      JSON.stringify(log.logs || [])
    ]
  );
  saveDb();
}

export async function getRecentQueryExecutionLogs(limit = 20): Promise<QueryExecutionLog[]> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT * FROM query_execution_logs ORDER BY executed_at DESC LIMIT ?`);
  stmt.bind([limit]);
  const logs: QueryExecutionLog[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    logs.push({
      id: row.id as number,
      query_id: row.query_id as number || undefined,
      query: row.query as string,
      country: row.country as string,
      executed_at: row.executed_at as string,
      channels_discovered: row.channels_discovered as number || 0,
      unique_new_channels: row.unique_new_channels as number || 0,
      quality_creators_discovered: row.quality_creators_discovered as number || 0,
      communities_discovered: row.communities_discovered as number || 0,
      cycle_quality_score: row.cycle_quality_score as number || 0,
      logs: row.logs ? JSON.parse(row.logs as string) : []
    });
  }
  stmt.free();
  return logs;
}

export async function saveExtractedTerm(
  country: string,
  term: string,
  category: 'terminology' | 'instrument' | 'phrase' | 'format',
  sourceChannelId?: string
): Promise<void> {
  const db = await getDb();
  const cleanTerm = term.trim();
  if (!cleanTerm) return;

  const now = new Date().toISOString();
  const stmt = db.prepare(`SELECT * FROM extracted_trading_vocabulary WHERE country = ? AND LOWER(term) = LOWER(?)`);
  stmt.bind([country, cleanTerm]);

  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    const count = ((row.occurrences as number) || 0) + 1;
    db.run(
      `UPDATE extracted_trading_vocabulary SET occurrences = ?, last_extracted = ?, source_channel_id = ? WHERE id = ?`,
      [count, now, sourceChannelId || row.source_channel_id, row.id]
    );
  } else {
    stmt.free();
    db.run(
      `INSERT INTO extracted_trading_vocabulary (country, term, category, source_channel_id, occurrences, first_extracted, last_extracted)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [country, cleanTerm, category, sourceChannelId || null, now, now]
    );
  }
  saveDb();
}

export async function getExtractedVocabulary(country?: string): Promise<ExtractedTermRecord[]> {
  const db = await getDb();
  let query = `SELECT * FROM extracted_trading_vocabulary ORDER BY occurrences DESC, last_extracted DESC`;
  let params: any[] = [];
  if (country) {
    query = `SELECT * FROM extracted_trading_vocabulary WHERE country = ? ORDER BY occurrences DESC, last_extracted DESC`;
    params = [country];
  }
  const stmt = db.prepare(query);
  if (params.length) stmt.bind(params);

  const list: ExtractedTermRecord[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    list.push({
      id: row.id as number,
      country: row.country as string,
      term: row.term as string,
      category: row.category as any,
      source_channel_id: row.source_channel_id as string || undefined,
      occurrences: row.occurrences as number || 1,
      first_extracted: row.first_extracted as string,
      last_extracted: row.last_extracted as string
    });
  }
  stmt.free();
  return list;
}

export async function getAppSetting(key: string, defaultValue: string = ''): Promise<string> {
  const db = await getDb();
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL);`);
  const stmt = db.prepare(`SELECT setting_value FROM app_settings WHERE setting_key = ?`);
  stmt.bind([key]);
  let val = defaultValue;
  if (stmt.step()) {
    const row = stmt.getAsObject();
    val = (row.setting_value as string) || defaultValue;
  }
  stmt.free();
  return val;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL);`);
  db.run(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
    [key, value]
  );
  saveDb();
}

export async function purgeSyntheticTestChannels(): Promise<number> {
  const db = await getDb();
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM channels WHERE channel_id LIKE 'UC_STRESS_TEST_%'`);
  let count = 0;
  if (stmt.step()) {
    count = (stmt.getAsObject().cnt as number) || 0;
  }
  stmt.free();
  db.run(`DELETE FROM channels WHERE channel_id LIKE 'UC_STRESS_TEST_%'`);
  saveDb();
  return count;
}
