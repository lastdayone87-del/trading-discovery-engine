import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
  });
  const db = await pool.connect();
  try {
    await db.query('BEGIN TRANSACTION READ ONLY');

    const columns = await db.query(`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='provider_call_events'
       ORDER BY ordinal_position`);

    const grouped = await db.query(`
      SELECT provider, operation, status, COALESCE(error_class,'NONE') AS error_class,
             COUNT(*)::int AS count,
             MIN(occurred_at) AS first_at,
             MAX(occurred_at) AS last_at,
             ROUND(AVG(latency_ms))::int AS average_latency_ms
        FROM provider_call_events
       WHERE provider='gemini' OR operation='multilingual-semantic-classification'
       GROUP BY provider, operation, status, COALESCE(error_class,'NONE')
       ORDER BY count DESC, provider, operation, status`);

    const recent = await db.query(`
      SELECT id, provider, operation, status, error_class, latency_ms, attempt, policy_version, occurred_at
        FROM provider_call_events
       WHERE provider='gemini' OR operation='multilingual-semantic-classification'
       ORDER BY occurred_at DESC
       LIMIT 50`);

    const coverage = await db.query(`
      SELECT COUNT(*)::int AS snapshots,
             COUNT(*) FILTER (WHERE provider_availability::text LIKE '%gemini_semantic%')::int AS snapshots_with_gemini,
             MIN(observed_at) AS first_at,
             MAX(observed_at) AS last_at
        FROM evidence_coverage_snapshots`);

    const coverageFailures = await db.query(`
      SELECT provider_entry->>'availability' AS availability,
             provider_entry->>'outcome' AS outcome,
             provider_entry->'reasonCodes' AS reason_codes,
             COUNT(*)::int AS count
        FROM evidence_coverage_snapshots c
        CROSS JOIN LATERAL jsonb_array_elements(c.provider_availability) provider_entry
       WHERE provider_entry->>'provider'='gemini_semantic'
       GROUP BY provider_entry->>'availability', provider_entry->>'outcome', provider_entry->'reasonCodes'
       ORDER BY count DESC`);

    await db.query('ROLLBACK');

    const report = {
      reportType: 'GEMINI_PROVIDER_FAILURE_DIAGNOSIS',
      readOnly: true,
      servingAuthority: false,
      automaticPromotion: false,
      providerCallsPerformed: false,
      providerCallEventColumns: columns.rows,
      providerCallEventSummary: grouped.rows,
      recentProviderCallEvents: recent.rows,
      coverageSummary: coverage.rows[0] || {},
      coverageGeminiFailureSummary: coverageFailures.rows,
      interpretationHints: {
        noGeminiProviderEvents: 'If coverage says FAILED_PROVIDER but no Gemini provider_call_events exist, inspect telemetry emit failure as a possible false provider failure.',
        geminiFailureEventsPresent: 'If matching failure events exist, executeProviderCall reached the provider catch path and telemetry persistence worked; inspect the stored error_class to narrow the upstream failure.'
      }
    };

    const outputDir = path.join(process.cwd(), 'stage0-output');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'gemini-provider-failure-diagnosis.json');
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({
      providerCallEventSummary: report.providerCallEventSummary,
      coverageSummary: report.coverageSummary,
      coverageGeminiFailureSummary: report.coverageGeminiFailureSummary
    }, null, 2) + '\n');
    process.stdout.write(`Wrote ${outputPath}\n`);
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
