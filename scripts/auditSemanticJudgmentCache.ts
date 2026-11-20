import pg from 'pg';

/**
 * Read-only audit of semantic AI call and cache accounting.
 *
 * Uses a dedicated read-only pool rather than getDb(), which runs migrations
 * and default seeding. The session is explicitly read-only for defense in
 * depth. Historical provider rows predate channel/checksum metadata; those
 * columns appear as null rather than being inferred.
 */
const args = process.argv.slice(2);
const hoursArg = args.find(arg => arg.startsWith('--hours='));
const parsedHours = Number(hoursArg?.split('=')[1] || 24);
const hours = Number.isFinite(parsedHours) ? Math.max(1, Math.min(24 * 14, Math.floor(parsedHours))) : 24;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the semantic cache audit.');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c default_transaction_read_only=on',
});
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const [calls, cache, hits, channels] = await Promise.all([
      client.query(
        `SELECT provider,status,COUNT(*)::int AS calls,
                COALESCE(SUM(actual_cost),0)::float AS actual_cost
           FROM provider_call_events
          WHERE operation='multilingual-semantic-classification'
            AND occurred_at >= now() - ($1::int * interval '1 hour')
          GROUP BY provider,status
          ORDER BY calls DESC`,
        [hours],
      ),
      client.query(
        `SELECT provider,prompt_version,
                COUNT(*)::int AS lifetime_rows,
                COALESCE(SUM(hits),0)::int AS lifetime_hits,
                COUNT(*) FILTER (WHERE created_at >= now() - ($1::int * interval '1 hour'))::int AS rows_created_in_window
           FROM semantic_classification_cache
          GROUP BY provider,prompt_version
          ORDER BY lifetime_rows DESC`,
        [hours],
      ),
      client.query(
        `SELECT COUNT(*)::int AS diagnostics,
                COUNT(*) FILTER (WHERE evidence_items::text LIKE '%SEMANTIC_RESULT_CACHE_HIT%')::int AS cache_hit_diagnostics
           FROM production_classification_diagnostics
          WHERE created_at >= now() - ($1::int * interval '1 hour')`,
        [hours],
      ),
      client.query(
        `WITH calls AS (
           SELECT CASE
                    WHEN request_metadata->>'channelId' IS NOT NULL THEN request_metadata->>'channelId'
                    WHEN request_metadata->>'semanticBatchChannelIds' IS NOT NULL THEN NULL
                    ELSE '<unattributed>'
                  END AS single_channel,
                  request_metadata->>'semanticBatchChannelIds' AS batch_channels,
                  status
             FROM provider_call_events
            WHERE operation='multilingual-semantic-classification'
              AND occurred_at >= now() - ($1::int * interval '1 hour')
         )
         SELECT channel_id,COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE status='SUCCESS')::int AS successes
           FROM (
             SELECT single_channel AS channel_id,status FROM calls WHERE single_channel IS NOT NULL
             UNION ALL
             SELECT trim(channel) AS channel_id,status
               FROM calls, LATERAL regexp_split_to_table(batch_channels, ',') channel
              WHERE batch_channels IS NOT NULL
           ) attributed
          GROUP BY 1
          ORDER BY calls DESC
          LIMIT 20`,
        [hours],
      ),
    ]);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({
      windowHours: hours,
      providerCalls: calls.rows,
      cache: cache.rows,
      diagnostics: hits.rows[0] || null,
      topChannels: channels.rows,
    }, null, 2));
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
