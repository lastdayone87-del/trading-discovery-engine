const fs = require('node:fs');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL secret is required');

const TARGET_REASONS = [
  'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  'UPSTREAM_REQUIRED_ACQUISITION_FAILURE',
];

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function sanitize(v) {
  if (typeof v === 'string') {
    return v.replace(/postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/gi, 'postgresql://[REDACTED]@');
  }
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  return v;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL, application_name: 'read-only-forensic-investigation-v2' });
  await client.connect();
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query("SET LOCAL lock_timeout = '2s'");

  try {
    const tables = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema='public'
      ORDER BY table_name
    `);
    const tableSet = new Set(tables.rows.map(r => r.table_name));
    for (const t of ['channels', 'jobs', 'external_acquisition_observations']) {
      if (!tableSet.has(t)) throw new Error(`Required table missing: ${t}`);
    }

    const columns = await client.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name IN ('channels','jobs','external_acquisition_observations','provider_call_events')
      ORDER BY table_name, ordinal_position
    `);

    // Also inspect channels that surface the reason on the channel row itself if columns exist
    const channelCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='channels'
    `);
    const chColSet = new Set(channelCols.rows.map(r => r.column_name));

    const jobs = await client.query(`
      SELECT id::text job_id,status,attempts,max_attempts,run_after,created_at,updated_at,last_error,payload,
             payload->>'channelId' channel_id,
             payload->>'retryReason' retry_reason,
             payload->>'retryCode' retry_code,
             payload->>'retrySource' retry_source,
             payload->>'observedAt' retry_observed_at,
             payload->>'observationAt' observation_at
      FROM jobs
      WHERE type='RETRY_COMMUNITY_ACQUISITION'
        AND payload->>'retryReason' = ANY($1::text[])
      ORDER BY payload->>'channelId',created_at,id
    `, [TARGET_REASONS]);

    let extraChannelIds = [];
    // Discover any channel-level reason columns for completeness
    const reasonLikeCols = [...chColSet].filter(c => /retry|reason|discord_validation/i.test(c));

    const channelIds = [...new Set([
      ...jobs.rows.map(r => r.channel_id).filter(Boolean),
      ...extraChannelIds
    ])];

    const channels = channelIds.length ? await client.query(`
      SELECT channel_id,channel_name,discord_status,discord_validation_status,scan_status,scan_attempts,
             last_checked,next_check,inspection_trail,created_at,updated_at
      FROM channels WHERE channel_id=ANY($1::text[]) ORDER BY channel_id
    `, [channelIds]) : { rows: [] };

    const observations = channelIds.length ? await client.query(`
      SELECT observation_key,channel_id,requested_url,final_url,outcome,retryable,http_status,
             failure_class,detail,provenance,policy_version,observed_at
      FROM external_acquisition_observations
      WHERE channel_id=ANY($1::text[])
      ORDER BY channel_id,observed_at,observation_key
    `, [channelIds]) : { rows: [] };

    let providerCalls = { rows: [] };
    if (tableSet.has('provider_call_events') && jobs.rows.length) {
      const ids = jobs.rows.map(r => r.job_id);
      providerCalls = await client.query(`
        SELECT id::text id,provider,operation,request_id,run_id,job_id::text job_id,attempt,status,
               latency_ms,error_class,policy_version,occurred_at
        FROM provider_call_events WHERE job_id::text=ANY($1::text[]) ORDER BY occurred_at
      `, [ids]);
    }

    let reconEvents = { rows: [] };
    if (tableSet.has('community_retry_projection_reconciliation_events') && channelIds.length) {
      reconEvents = await client.query(`
        SELECT * FROM community_retry_projection_reconciliation_events
        WHERE channel_id=ANY($1::text[])
        ORDER BY channel_id
        LIMIT 500
      `, [channelIds]);
    }

    const report = channelIds.map(channelId => {
      const channel = channels.rows.find(r => r.channel_id === channelId) || null;
      const retryJobs = jobs.rows.filter(r => r.channel_id === channelId);
      const obs = observations.rows.filter(r => r.channel_id === channelId).map(o => ({ ...o, provenance: parseJson(o.provenance) }));
      const qualifying = obs.filter(o => o.outcome === 'ACQUISITION_FAILED' && o.retryable === true && parseJson(o.provenance)?.required !== false);
      const communityQualifying = qualifying.filter(o => !['YOUTUBE_ABOUT','RECENT_VIDEO_DESCRIPTIONS'].includes(String(parseJson(o.provenance)?.surface || '').toUpperCase()));
      const trail = parseJson(channel?.inspection_trail);
      const trailItems = Array.isArray(trail) ? trail : (trail ? [trail] : []);
      const step4 = trailItems.filter(x => /step\s*4|linked websites|custom[_ ]domains|partial|budget/i.test(JSON.stringify(x)));
      const linkedProviderCalls = providerCalls.rows.filter(p => retryJobs.some(j => j.job_id === p.job_id));
      const latestObs = obs.slice().sort((a,b) => new Date(b.observed_at) - new Date(a.observed_at))[0] || null;
      const latestQualifying = qualifying.slice().sort((a,b) => new Date(b.observed_at) - new Date(a.observed_at))[0] || null;
      const laterSuccess = latestQualifying && obs.some(o => new Date(o.observed_at) > new Date(latestQualifying.observed_at) && (o.outcome === 'FOUND' || o.outcome === 'INSPECTED_NO_MATCH'));

      // Step 4 telemetry extraction
      let step4Status = null;
      let budgetExpired = false;
      const step4Text = JSON.stringify(step4);
      if (/PARTIAL/i.test(step4Text)) step4Status = 'PARTIAL';
      if (/budget expired|Rendered acquisition budget/i.test(step4Text)) budgetExpired = true;

      return {
        channel_id: channelId,
        channel_name: channel?.channel_name || null,
        projected_reasons: [...new Set(retryJobs.map(j => j.retry_reason).filter(Boolean))],
        retry_codes: [...new Set(retryJobs.map(j => j.retry_code).filter(Boolean))],
        retry_sources: [...new Set(retryJobs.map(j => j.retry_source).filter(Boolean))],
        retry_jobs: sanitize(retryJobs),
        channel_state: sanitize(channel),
        step4_relevant_inspection_trail: sanitize(step4),
        step4_status: step4Status,
        budget_expired_message: budgetExpired,
        later_success_after_failure: !!laterSuccess,
        latest_observation: sanitize(latestObs),
        latest_qualifying_failure: sanitize(latestQualifying),
        observation_summary: {
          total: obs.length,
          acquisition_failed: obs.filter(o => o.outcome === 'ACQUISITION_FAILED').length,
          retryable_failures: obs.filter(o => o.outcome === 'ACQUISITION_FAILED' && o.retryable === true).length,
          required_retryable_failures: qualifying.length,
          community_surface_required_retryable_failures: communityQualifying.length,
          youtube_about_or_recent_video_failures: obs.filter(o => ['YOUTUBE_ABOUT','RECENT_VIDEO_DESCRIPTIONS'].includes(String(parseJson(o.provenance)?.surface || '').toUpperCase())).length,
          found: obs.filter(o => o.outcome === 'FOUND').length,
          no_match: obs.filter(o => o.outcome === 'INSPECTED_NO_MATCH').length,
        },
        acquisition_observations: sanitize(obs),
        provider_calls_for_retry_jobs: sanitize(linkedProviderCalls),
        reconciliation_events: sanitize(reconEvents.rows.filter(r => r.channel_id === channelId)),
        channel_reason_like_columns: reasonLikeCols,
      };
    });

    const counts = {
      matching_retry_jobs: jobs.rowCount,
      distinct_affected_channels: channelIds.length,
      community_reason_jobs: jobs.rows.filter(r => r.retry_reason === TARGET_REASONS[0]).length,
      upstream_reason_jobs: jobs.rows.filter(r => r.retry_reason === TARGET_REASONS[1]).length,
      channels_with_required_retryable_failure: report.filter(r => r.observation_summary.required_retryable_failures > 0).length,
      channels_with_community_surface_required_retryable_failure: report.filter(r => r.observation_summary.community_surface_required_retryable_failures > 0).length,
      channels_with_no_qualifying_observation: report.filter(r => r.observation_summary.required_retryable_failures === 0).length,
      channels_with_step4_partial: report.filter(r => r.step4_status === 'PARTIAL').length,
      channels_with_budget_expired: report.filter(r => r.budget_expired_message).length,
      channels_with_later_success_after_failure: report.filter(r => r.later_success_after_failure).length,
    };

    fs.mkdirSync('forensic-output', { recursive: true });
    fs.writeFileSync('forensic-output/forensic-report.json', JSON.stringify({
      generated_at: new Date().toISOString(),
      mode: 'READ_ONLY_POSTGRES_FORENSIC',
      safety: { transaction: 'READ ONLY', statement_timeout: '120s', lock_timeout: '2s', writes_performed: false, production_mutations: false },
      target_reasons: TARGET_REASONS, counts, schema_snapshot: columns.rows, public_tables: [...tableSet].sort(), affected_channels: report
    }, null, 2) + '\n');

    const md = ['# Production Forensic DB Investigation','',`Generated: ${new Date().toISOString()}`,'','## Safety','- PostgreSQL transaction: READ ONLY','- No INSERT/UPDATE/DELETE/DDL','- No queue operations or application mutations','','## Counts'];
    for (const [k,v] of Object.entries(counts)) md.push(`- ${k}: ${v}`);
    md.push('','## Channel-by-channel causal evidence');
    for (const r of report) {
      md.push('',`### ${r.channel_id} — ${r.channel_name || 'unknown'}`);
      md.push(`- Reasons: ${r.projected_reasons.join(', ') || 'none'}`);
      md.push(`- Required/retryable ACQUISITION_FAILED: ${r.observation_summary.required_retryable_failures}`);
      md.push(`- Community-surface qualifying: ${r.observation_summary.community_surface_required_retryable_failures}`);
      md.push(`- YouTube About/recent-video: ${r.observation_summary.youtube_about_or_recent_video_failures}`);
      md.push(`- Step4 status: ${r.step4_status || 'n/a'}; budget_expired: ${r.budget_expired_message}; later_success: ${r.later_success_after_failure}`);
      md.push('','#### Step 4','```json',JSON.stringify(r.step4_relevant_inspection_trail,null,2),'```');
      md.push('','#### Acquisition observations','```json',JSON.stringify(r.acquisition_observations,null,2),'```');
      md.push('','#### Retry jobs','```json',JSON.stringify(r.retry_jobs,null,2),'```');
      md.push('','#### Linked provider calls','```json',JSON.stringify(r.provider_calls_for_retry_jobs,null,2),'```');
    }
    fs.writeFileSync('forensic-output/forensic-report.md', md.join('\n') + '\n');

    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, counts }, null, 2));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error('[forensic-read-only-v2] failed:', e.message); process.exit(1); });
