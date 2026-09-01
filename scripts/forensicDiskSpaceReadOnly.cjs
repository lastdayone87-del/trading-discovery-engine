/**
 * READ-ONLY Postgres disk / temp / relation size forensic.
 * Does NOT write, vacuum, truncate, or alter anything.
 */
const fs = require('node:fs');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL secret is required');

function sanitize(v) {
  if (typeof v === 'string') {
    return v.replace(/postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/gi, 'postgresql://[REDACTED]@');
  }
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  }
  return v;
}

async function q(client, label, sql, params = []) {
  const started = Date.now();
  try {
    const res = await client.query(sql, params);
    console.error(`[disk] ok ${label} rows=${res.rowCount} ms=${Date.now() - started}`);
    return res;
  } catch (err) {
    console.error(`[disk] FAIL ${label}: ${err.message}`);
    return { rows: [], rowCount: 0, error: err.message, label };
  }
}

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    application_name: 'forensic-disk-readonly',
    statement_timeout: 120000,
  });
  await client.connect();

  const out = {
    generated_at: new Date().toISOString(),
    mode: 'READ_ONLY_DISK_SPACE_FORENSIC',
    safety: {
      transaction: 'READ ONLY',
      writes_performed: false,
      production_mutations: false,
    },
  };

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    out.probe = (await q(client, 'probe', 'SELECT 1 AS ok, now() AS ts, current_database() AS db, current_user AS usr, version() AS version')).rows[0];

    // Data directory / settings that relate to disk
    out.settings = (
      await q(
        client,
        'settings',
        `SELECT name, setting, unit, short_desc
         FROM pg_settings
         WHERE name IN (
           'data_directory',
           'log_directory',
           'temp_tablespaces',
           'temp_file_limit',
           'work_mem',
           'maintenance_work_mem',
           'shared_buffers',
           'wal_level',
           'max_wal_size',
           'min_wal_size',
           'wal_keep_size',
           'archive_mode',
           'archive_command',
           'checkpoint_timeout',
           'max_connections',
           'autovacuum'
         )
         ORDER BY name`
      )
    ).rows;

    // Database sizes
    out.database_sizes = (
      await q(
        client,
        'db_sizes',
        `SELECT datname,
                pg_database_size(datname) AS size_bytes,
                pg_size_pretty(pg_database_size(datname)) AS size_pretty
         FROM pg_database
         ORDER BY pg_database_size(datname) DESC`
      )
    ).rows;

    // Top relations by total size (table + indexes + toast)
    out.top_relations = (
      await q(
        client,
        'top_relations',
        `SELECT n.nspname AS schema,
                c.relname AS relation,
                c.relkind,
                pg_total_relation_size(c.oid) AS total_bytes,
                pg_size_pretty(pg_total_relation_size(c.oid)) AS total_pretty,
                pg_relation_size(c.oid) AS table_bytes,
                pg_size_pretty(pg_relation_size(c.oid)) AS table_pretty,
                pg_indexes_size(c.oid) AS indexes_bytes,
                pg_size_pretty(pg_indexes_size(c.oid)) AS indexes_pretty,
                COALESCE(pg_total_relation_size(c.reltoastrelid), 0) AS toast_bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND c.relkind IN ('r', 'm', 'p', 'i')
         ORDER BY pg_total_relation_size(c.oid) DESC
         LIMIT 40`
      )
    ).rows;

    // Dead tuples / bloat indicators (read-only stats)
    out.dead_tuple_stats = (
      await q(
        client,
        'dead_tuples',
        `SELECT schemaname, relname,
                n_live_tup, n_dead_tup,
                CASE WHEN n_live_tup > 0
                  THEN round((n_dead_tup::numeric / n_live_tup) * 100, 2)
                  ELSE NULL END AS dead_pct,
                last_vacuum, last_autovacuum,
                last_analyze, last_autoanalyze,
                vacuum_count, autovacuum_count
         FROM pg_stat_user_tables
         ORDER BY n_dead_tup DESC NULLS LAST
         LIMIT 30`
      )
    ).rows;

    // WAL / checkpoint activity
    out.wal_stats = (
      await q(
        client,
        'wal_stats',
        `SELECT * FROM pg_stat_wal`
      )
    ).rows;

    out.bgwriter = (
      await q(
        client,
        'bgwriter',
        `SELECT * FROM pg_stat_bgwriter`
      )
    ).rows;

    // Temp files (backend activity)
    out.temp_file_activity = (
      await q(
        client,
        'temp_files',
        `SELECT datname, temp_files, temp_bytes,
                pg_size_pretty(temp_bytes) AS temp_pretty,
                blks_read, blks_hit
         FROM pg_stat_database
         WHERE datname IS NOT NULL
         ORDER BY temp_bytes DESC NULLS LAST`
      )
    ).rows;

    // Current backends / activity that might be holding temp
    out.activity = (
      await q(
        client,
        'activity',
        `SELECT pid, usename, application_name, state,
                wait_event_type, wait_event,
                backend_type,
                query_start, state_change,
                left(query, 120) AS query_preview
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
         ORDER BY query_start NULLS LAST
         LIMIT 40`
      )
    ).rows;

    // Tablespaces
    out.tablespaces = (
      await q(
        client,
        'tablespaces',
        `SELECT spcname, pg_tablespace_location(oid) AS location,
                pg_size_pretty(pg_tablespace_size(oid)) AS size_pretty,
                pg_tablespace_size(oid) AS size_bytes
         FROM pg_tablespace`
      )
    ).rows;

    // Try to estimate free space if extension available (often not)
    out.extensions = (
      await q(
        client,
        'extensions',
        `SELECT extname, extversion FROM pg_extension ORDER BY extname`
      )
    ).rows;

    // Replication slots (can hold WAL)
    out.replication_slots = (
      await q(
        client,
        'repl_slots',
        `SELECT slot_name, slot_type, active, restart_lsn, confirmed_flush_lsn,
                wal_status, safe_wal_size,
                pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal_pretty
         FROM pg_replication_slots`
      )
    ).rows;

    // Prepared xacts
    out.prepared_xacts = (
      await q(
        client,
        'prepared',
        `SELECT * FROM pg_prepared_xacts`
      )
    ).rows;

    // Approximate total of user relations
    out.total_user_relations_bytes = (
      await q(
        client,
        'total_user',
        `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint AS total_bytes,
                pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)),0)) AS total_pretty
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND c.relkind IN ('r','m','p')`
      )
    ).rows[0];

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    out.fatal_error = e.message;
    throw e;
  } finally {
    await client.end();
  }

  fs.mkdirSync('forensic-output', { recursive: true });
  const safe = sanitize(out);
  fs.writeFileSync('forensic-output/disk-space-report.json', JSON.stringify(safe, null, 2) + '\n');

  const lines = [
    '# Postgres Disk Space Forensic (READ-ONLY)',
    '',
    `Generated: ${out.generated_at}`,
    '',
    '## Probe',
    '```json',
    JSON.stringify(safe.probe, null, 2),
    '```',
    '',
    '## Database sizes',
    '```json',
    JSON.stringify(safe.database_sizes, null, 2),
    '```',
    '',
    '## Top relations',
    '```json',
    JSON.stringify(safe.top_relations, null, 2),
    '```',
    '',
    '## Dead tuples (top)',
    '```json',
    JSON.stringify(safe.dead_tuple_stats, null, 2),
    '```',
    '',
    '## Temp file activity',
    '```json',
    JSON.stringify(safe.temp_file_activity, null, 2),
    '```',
    '',
    '## Settings (disk-related)',
    '```json',
    JSON.stringify(safe.settings, null, 2),
    '```',
    '',
    '## Tablespaces',
    '```json',
    JSON.stringify(safe.tablespaces, null, 2),
    '```',
    '',
    '## Replication slots',
    '```json',
    JSON.stringify(safe.replication_slots, null, 2),
    '```',
  ];
  fs.writeFileSync('forensic-output/disk-space-report.md', lines.join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, probe: safe.probe, database_sizes: safe.database_sizes, total_user: safe.total_user_relations_bytes }, null, 2));
}

main().catch((e) => {
  console.error('[disk-forensic] failed:', e.message);
  process.exit(1);
});
