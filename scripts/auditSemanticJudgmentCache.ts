import { getDb } from '../server/db';

/**
 * Read-only audit of semantic AI call and cache accounting.
 *
 * Reports provider-level calls, successful judgments, cache rows and cache
 * hits. Historical provider rows predate channel/checksum metadata; those
 * columns appear as null rather than being inferred.
 */
const args = process.argv.slice(2);
const hoursArg = args.find(arg => arg.startsWith('--hours='));
const hours = Math.max(1, Math.min(24 * 14, Number(hoursArg?.split('=')[1] || 24) || 24));

const db = await getDb();
const [calls, cache, hits, channels] = await Promise.all([
  db.query(
    `SELECT provider,status,COUNT(*)::int AS calls,
            COALESCE(SUM(actual_cost),0)::float AS actual_cost
       FROM provider_call_events
      WHERE operation='multilingual-semantic-classification'
        AND occurred_at >= now() - ($1::int * interval '1 hour')
      GROUP BY provider,status
      ORDER BY calls DESC`,
    [hours],
  ),
  db.query(
    `SELECT provider,COUNT(*)::int AS rows,COALESCE(SUM(hits),0)::int AS hits,
            COUNT(*) FILTER (WHERE created_at >= now() - ($1::int * interval '1 hour'))::int AS created_in_window
       FROM semantic_classification_cache
      GROUP BY provider
      ORDER BY rows DESC`,
    [hours],
  ),
  db.query(
    `SELECT COUNT(*)::int AS diagnostics,
            COUNT(*) FILTER (WHERE provider_execution::text LIKE '%SEMANTIC_RESULT_CACHE_HIT%')::int AS cache_hit_diagnostics
       FROM production_classification_diagnostics
      WHERE created_at >= now() - ($1::int * interval '1 hour')`,
    [hours],
  ),
  db.query(
    `SELECT COALESCE(request_metadata->>'channelId','<unattributed>') AS channel_id,
            COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE status='SUCCESS')::int AS successes
       FROM provider_call_events
      WHERE operation='multilingual-semantic-classification'
        AND occurred_at >= now() - ($1::int * interval '1 hour')
      GROUP BY 1
      ORDER BY calls DESC
      LIMIT 20`,
    [hours],
  ),
]);

console.log(JSON.stringify({
  windowHours: hours,
  providerCalls: calls.rows,
  cache: cache.rows,
  diagnostics: hits.rows[0] || null,
  topChannels: channels.rows,
}, null, 2));
