const fs = require('node:fs');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL secret is required');

const TARGET_REASONS = [
  'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  'UPSTREAM_REQUIRED_ACQUISITION_FAILURE',
];

function qident(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

function redact(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(postgres(?:ql)?:\\/\\/[^:]+:)[^@]+(@)/gi, '$1[REDACTED]$2');
}

function json(value) {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'string' && /^postgres(?:ql)?:\\/\\//i.test(v)) return redact(v);
    return v;
  });
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, application_name: 'read-only-forensic-investigation' });
  await client.connect();

  // Hard safety boundary: every query in this run is inside a read-only transaction.
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '2s'");

  try {
    const tables = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY table_schema, table_name
    `);

    const tableNames = new Set(tables.rows.filter(r => r.table_schema === 'public').map(r => r.table_name));
    const requiredTables = ['channels', 'jobs', 'external_acquisition_observations'];
    const missing = requiredTables.filter(t => !tableNames.has(t));
    if (missing.length) throw new Error(`Required production tables missing: ${missing.join(', ')}`);

    const columns = await client.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name IN ('channels','jobs','external_acquisition_observations','provider_call_events')
      ORDER BY table_name, ordinal_position
    `);

    // Retry reason is durable job metadata. Pull every matching retry job, not only pending jobs.
    const retryJobs = await client.query(`
      SELECT
        j.id::text AS job_id,
        j.status,
        j.attempts,
        j.max_attempts,
        j.run_after,
        j.created_at,
        j.updated_at,
        j.last_error,
        j.payload,
        j.payload->>'channelId' AS channel_id,
        j.payload->>'retryReason' AS retry_reason,
        j.payload->>'retryCode' AS retry_code,
        j.payload->>'retrySource' AS retry_source,
        j.payload->>'observedAt' AS retry_observed_at,
        j.payload->>'observationAt' AS observation_at
      FROM jobs j
      WHERE j.type='RETRY_COMMUNITY_ACQUISITION'
        AND j.payload->>'retryReason' = ANY($1::text[])
      ORDER BY j.payload->>'channelId', j.created_at, j.id
    `, [TARGET_REASONS]);

    const channelIds = [...new Set(retryJobs.rows.map(r => r.channel_id).filter(Boolean))];

    const channels = channelIds.length ? await client.query(`
      SELECT channel_id, channel_name, discord_status, discord_validation_status,
             scan_status, scan_attempts, last_checked, next_check,
             inspection_trail, created_at, updated_at
      FROM channels
      WHERE channel_id = ANY($1::text[])
      ORDER BY channel_id
    `, [channelIds]) : { rows: [] };

    const observations = channelIds.length ? await client.query(`
      SELECT observation_key, channel_id, requested_url, final_url, outcome,
             retryable, http_status, failure_class, detail, provenance,
             policy_version, observed_at
      FROM external_acquisition_observations
      WHERE channel_id = ANY($1::text[])
      ORDER BY channel_id, observed_at, observation_key
    `, [channelIds]) : { rows: [] };

    const jobIds = retryJobs.rows.map(r => r.job_id);
    let providerCalls = { rows: [] };
    if (tableNames.has('provider_call_events') && jobIds.length) {
      providerCalls = await client.query(`
        SELECT id::text AS id, provider, operation, request_id, run_id,
               job_id::text AS job_id, attempt, status, latency_ms,
               error_class, policy_version, occurred_at
        FROM provider_call_events
        WHERE job_id::text = ANY($1::text[])
        ORDER BY occurred_at
      `, [jobIds]);
    }

    const reconEvents = tableNames.has('community_retry_projection_reconciliation_events') && channelIds.length
      ? await client.query(`
          SELECT event_key, channel_id, job_id, prior_validation_status,
                 resulting_validation_status, policy_version, created_at
          FROM community_retry_projection_reconciliation_events
          WHERE channel_id = ANY($1::text[])
          ORDER BY channel_id, created_at
        `, [channelIds])
      : { rows: [] };

    const byChannel = new Map(channelIds.map(id => [id, {
      channel_id: id,
      channel: channels.rows.find(r => r.channel_id === id) || null,
      retry_jobs: retryJobs.rows.filter(r => r.channel_id === id),
      acquisition_observations: observations.rows.filter(r => r.channel_id === id),
      provider_calls: providerCalls.rows.filter(r => r.job_id && retryJobs.rows.some(j => j.channel_id === id && j.job_id === r.job_id)),
      reconciliation_events: reconEvents.rows.filter(r => r.channel_id === id),
    }]));

    const reportRows = [...byChannel.values()].map(item => {
      const obs = item.acquisition_observations;
      const qualifying = obs.filter(o =>
        o.outcome === 'ACQUISITION_FAILED' &&
        o.retryable === true &&
        o.provenance && o.provenance.required !== false
      );
      const communitySurfaceQualifying = qualifying.filter(o => {
        const surface = String(o.provenance?.surface || '').toUpperCase();
        return !['YOUTUBE_ABOUT', 'RECENT_VIDEO_DESCRIPTIONS'].includes(surface);
      });
      const step4 = item.channel?.inspection_trail?.filter?.(x => {
        const text = JSON.stringify(x).toLowerCase();
        return text.includes('linked websites') || text.includes('custom_domains') || text.includes('custom domains') || text.includes('step 4');
      }) || [];
      return {
        channel_id: item.channel_id,
        channel_name: item.channel?.channel_name || null,
        projected_reasons: [...new Set(item.retry_jobs.map(j => j.retry_reason).filter(Boolean))],
        retry_codes: [...new Set(item.retry_jobs.map(j => j.retry_code).filter(Boolean))],
        retry_sources: [...new Set(item.retry_jobs.map(j => j.retry_source).filter(Boolean))],
        retry_jobs: item.retry_jobs,
        channel_state: item.channel,
        step4_relevant_inspection_trail: step4,
        observation_summary: {
          total: obs.length,
          acquisition_failed: obs.filter(o => o.outcome === 'ACQUISITION_FAILED').length,
          retryable_failures: obs.filter(o => o.outcome === 'ACQUISITION_FAILED' && o.retryable).length,
          required_retryable_failures: qualifying.length,
          community_surface_required_retryable_failures: communitySurfaceQualifying.length,
          youtube_surface_failures: obs.filter(o => ['YOUTUBE_ABOUT','RECENT_VIDEO_DESCRIPTIONS'].includes(String(o.provenance?.surface || '').toUpperCase())).length,
          partial_or_incomplete: obs.filter(o => ['PARTIALLY_INSPECTED','ACQUISITION_FAILED'].includes(o.outcome)).length,
          found: obs.filter(o => o.outcome === 'FOUND').length,
          no_match: obs.filter(o => o.outcome === 'INSPECTED_NO_MATCH').length,
        },
        acquisition_observations: obs,
        provider_calls_for_retry_jobs: item.provider_calls,
        reconciliation_events: item.reconciliation_events,
      };
    });

    const counts = {
      matching_retry_jobs: retryJobs.rowCount,
      distinct_affected_channels: channelIds.length,
      community_reason_jobs: retryJobs.rows.filter(r => r.retry_reason === TARGET_REASONS[0]).length,
      upstream_reason_jobs: retryJobs.rows.filter(r => r.retry_reason === TARGET_REASONS[1]).length,
      channels_with_required_retryable_failure: reportRows.filter(r => r.observation_summary.required_retryable_failures > 0).length,
      channels_with_community_surface_required_retryable_failure: reportRows.filter(r => r.observation_summary.community_surface_required_retryable_failures > 0).length,
      channels_with_no_qualifying_observation: reportRows.filter(r => r.observation_summary.required_retryable_failures === 0).length,
    };

    const result = {
      generated_at: new Date().toISOString(),
      mode: 'READ_ONLY_POSTGRES_FORENSIC',
      safety: {
        transaction: 'READ ONLY',
        statement_timeout: '120s',
        lock_timeout: '2s',
        writes_performed: false,
        migrations_run: false,
        queue_operations: false,
        production_mutations: false,
      },
      target_reasons: TARGET_REASONS,
      counts,
      schema_snapshot: columns.rows,
      affected_channels: reportRows,
    };

    fs.mkdirSync('forensic-output', { recursive: true });
    fs.writeFileSync('forensic-output/forensic-report.json', json(result) + '\n');

    const md = [];
    md.push('# Production Forensic DB Investigation');
    md.push('');
    md.push(`Generated: ${result.generated_at}`);
    md.push('');
    md.push('## Safety');
    md.push('- PostgreSQL transaction mode: READ ONLY');
    md.push('- No INSERT/UPDATE/DELETE/DDL performed');
    md.push('- No migrations, queue operations, retries, or application calls performed');
    md.push('');
    md.push('## Counts');
    for (const [k, v] of Object.entries(counts)) md.push(`- ${k}: ${v}`);
    md.push('');
    md.push('## Channel-by-channel causal evidence');
    md.push('');
    for (const r of reportRows) {
      md.push(`### ${r.channel_id} — ${r.channel_name || 'unknown'}`);
      md.push(`- Projected reasons: ${r.projected_reasons.join(', ') || 'none'}`);
      md.push(`- Retry codes: ${r.retry_codes.join(', ') || 'none'}`);
      md.push(`- Required + retryable ACQUISITION_FAILED observations: ${r.observation_summary.required_retryable_failures}`);
      md.push(`- Community-surface qualifying failures: ${r.observation_summary.community_surface_required_retryable_failures}`);
      md.push(`- YouTube About/recent-video failures: ${r.observation_summary.youtube_surface_failures}`);
      md.push(`- Total acquisition observations: ${r.observation_summary.total}`);
      md.push(`- Provider calls linked through retry job IDs: ${r.provider_calls_for_retry_jobs.length}`);
      md.push('');
      md.push('#### Step 4 / relevant inspection trail');
      md.push('```json');
      md.push(JSON.stringify(r.step4_relevant_inspection_trail, null, 2));
      md.push('```');
      md.push('');
      md.push('#### Acquisition observations');
      md.push('```json');
      md.push(JSON.stringify(r.acquisition_observations, null, 2));
      md.push('```');
      md.push('');
      md.push('#### Retry jobs');
      md.push('```json');
      md.push(JSON.stringify(r.retry_jobs, null, 2));
      md.push('```');
      md.push('');
      md.push('#### Provider calls linked to retry jobs');
      md.push('```json');
      md.push(JSON.stringify(r.provider_calls_for_retry_jobs, null, 2));
      md.push('```');
      md.push('');
      md.push('#### Reconciliation events');
      md.push('```json');
      md.push(JSON.stringify(r.reconciliation_events, null, 2));
      md.push('```');
      md.push('');
    }
    md.push('## Interpretation rule');
    md.push('A Step 4 PARTIAL status is not treated as a failure by itself. The decisive production evidence is the persisted per-URL observation: outcome=ACQUISITION_FAILED, retryable=true, and provenance.required not false, with surface ownership determining whether the observation qualifies for community retry.');
    fs.writeFileSync('forensic-output/forensic-report.md', md.join('\n'));

    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, counts }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('[forensic-read-only] failed:', error.message);
  process.exit(1);
});
