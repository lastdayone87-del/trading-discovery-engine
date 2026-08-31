/**
 * Low temporary-space READ-ONLY forensic investigation.
 * Strategy: tiny sequential SELECTs on indexed predicates; no large joins;
 * correlation done in Node. Avoid ORDER BY/GROUP BY/DISTINCT across large sets.
 */
const fs = require('node:fs');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL secret is required');

const TARGET_REASONS = [
  'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  'UPSTREAM_REQUIRED_ACQUISITION_FAILURE',
];

const JOB_BATCH = Math.max(1, Number(process.env.FORENSIC_JOB_BATCH || 10));
const OBS_LIMIT = Math.max(1, Number(process.env.FORENSIC_OBS_LIMIT || 80));
const MAX_CHANNELS = Math.max(1, Number(process.env.FORENSIC_MAX_CHANNELS || 500));

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
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  }
  return v;
}

async function q(client, label, sql, params = []) {
  const started = Date.now();
  try {
    const res = await client.query(sql, params);
    console.error(`[forensic] ok ${label} rows=${res.rowCount} ms=${Date.now() - started}`);
    return res;
  } catch (err) {
    console.error(`[forensic] FAIL ${label} ms=${Date.now() - started}: ${err.message}`);
    err.forensicLabel = label;
    err.forensicSql = sql.replace(/\s+/g, ' ').trim().slice(0, 240);
    throw err;
  }
}

function surfaceOf(prov) {
  return String(parseJson(prov)?.surface || '').toUpperCase();
}

function isYoutubeSurface(s) {
  return s === 'YOUTUBE_ABOUT' || s === 'RECENT_VIDEO_DESCRIPTIONS';
}

function isCommunitySurface(s) {
  return [
    'CHANNEL_EXTERNAL_LINKS',
    'CREATOR_WEBSITES',
    'SOCIAL_PROFILES',
    'CUSTOM_DOMAIN',
    'COMMUNITY',
  ].includes(s) || (!!s && !isYoutubeSurface(s) && s !== 'UNKNOWN' && s !== '');
}

function classifyChannel(item) {
  const reasons = item.projected_reasons || [];
  const hasUpstream = reasons.includes('UPSTREAM_REQUIRED_ACQUISITION_FAILURE');
  const hasCommunity = reasons.includes('COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  const q = item.qualifying_failures || [];
  const communityQ = q.filter((o) => isCommunitySurface(surfaceOf(o.provenance)));
  const upstreamQ = q.filter((o) => isYoutubeSurface(surfaceOf(o.provenance)));
  const browserQ = q.filter((o) => {
    const fc = String(o.failure_class || '').toUpperCase();
    return /BROWSER|RUNTIME|NAVIGATION|TIMEOUT|PLAYWRIGHT|CRAWLER/.test(fc + ' ' + String(o.detail || ''));
  });

  const step4Partial = item.step4_status === 'PARTIAL' || item.budget_expired;
  const noQualifying = q.length === 0;

  if (item.later_success_after_failure) return 'STALE/DURABLE RETRY METADATA';
  if (noQualifying && step4Partial) return 'UNATTEMPTED/BUDGET-LIMITED — NO QUALIFYING FAILURE';
  if (noQualifying) return 'STALE/DURABLE RETRY METADATA';
  if (hasUpstream && communityQ.length > 0 && upstreamQ.length === 0) {
    return 'CROSS-CLASSIFIED / POSSIBLE SEMANTIC BUG';
  }
  if (browserQ.length > 0 && communityQ.length === 0 && upstreamQ.length === 0) {
    return 'BROWSER/RUNTIME FAILURE';
  }
  if (hasCommunity && communityQ.length > 0) return 'LEGITIMATE COMMUNITY FAILURE';
  if (hasUpstream && upstreamQ.length > 0) return 'LEGITIMATE UPSTREAM FAILURE';
  if (q.length > 0) return 'LEGITIMATE COMMUNITY FAILURE';
  return 'INCONCLUSIVE';
}

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    application_name: 'forensic-readonly-low-temp',
    statement_timeout: 30000,
  });
  await client.connect();

  const progress = {
    phase: 'init',
    minimal_query_ok: false,
    failed_query: null,
    jobs_scanned: 0,
    channels_found: 0,
  };

  try {
    // Session knobs: prefer less temp spill; hard-cap temp files so we do not worsen disk.
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL work_mem = '256kB'");
    await client.query("SET LOCAL temp_buffers = '128kB'");
    try {
      await client.query("SET LOCAL temp_file_limit = '8MB'");
    } catch (_) {
      // optional on some hosts
    }

    // 1) Minimal connectivity probe (no temp expected)
    progress.phase = 'probe';
    await q(client, 'probe_select_1', 'SELECT 1 AS ok');
    progress.minimal_query_ok = true;

    // 2) Index existence probe (tiny catalog reads)
    progress.phase = 'catalog';
    const idx = await q(
      client,
      'index_probe',
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('jobs','external_acquisition_observations','channels')
       LIMIT 40`
    );

    // 3) Keyset scan jobs for target reasons — one reason at a time, small LIMIT, no ORDER BY on large expressions if possible.
    // Use the partial expression index idx_jobs_retry_community_channel_created when available.
    progress.phase = 'scan_jobs';
    const jobsByChannel = new Map();
    let lastCreated = null;
    let lastId = null;
    let safetyLoops = 0;

    while (jobsByChannel.size < MAX_CHANNELS && safetyLoops < 200) {
      safetyLoops += 1;
      // Keyset pagination on (created_at, id) — indexed-friendly for type filter + small batches.
      let sql;
      let params;
      if (lastId == null) {
        sql = `
          SELECT id::text AS job_id, status, attempts, max_attempts,
                 run_after, created_at, updated_at, last_error,
                 payload->>'channelId' AS channel_id,
                 payload->>'retryReason' AS retry_reason,
                 payload->>'retryCode' AS retry_code,
                 payload->>'retrySource' AS retry_source,
                 payload->>'observedAt' AS retry_observed_at,
                 payload->>'observationAt' AS observation_at
          FROM jobs
          WHERE type = 'RETRY_COMMUNITY_ACQUISITION'
            AND payload->>'retryReason' = ANY($1::text[])
          ORDER BY created_at ASC, id ASC
          LIMIT $2`;
        params = [TARGET_REASONS, JOB_BATCH];
      } else {
        sql = `
          SELECT id::text AS job_id, status, attempts, max_attempts,
                 run_after, created_at, updated_at, last_error,
                 payload->>'channelId' AS channel_id,
                 payload->>'retryReason' AS retry_reason,
                 payload->>'retryCode' AS retry_code,
                 payload->>'retrySource' AS retry_source,
                 payload->>'observedAt' AS retry_observed_at,
                 payload->>'observationAt' AS observation_at
          FROM jobs
          WHERE type = 'RETRY_COMMUNITY_ACQUISITION'
            AND payload->>'retryReason' = ANY($1::text[])
            AND (created_at, id) > ($2::timestamptz, $3::uuid)
          ORDER BY created_at ASC, id ASC
          LIMIT $4`;
        params = [TARGET_REASONS, lastCreated, lastId, JOB_BATCH];
      }

      const batch = await q(client, `jobs_batch_${safetyLoops}`, sql, params);
      progress.jobs_scanned += batch.rowCount;
      if (batch.rowCount === 0) break;

      for (const row of batch.rows) {
        if (!row.channel_id) continue;
        if (!jobsByChannel.has(row.channel_id)) jobsByChannel.set(row.channel_id, []);
        jobsByChannel.get(row.channel_id).push(row);
        lastCreated = row.created_at;
        lastId = row.job_id;
      }

      if (batch.rowCount < JOB_BATCH) break;
    }

    const channelIds = [...jobsByChannel.keys()].slice(0, MAX_CHANNELS);
    progress.channels_found = channelIds.length;
    progress.phase = 'per_channel';

    const report = [];

    for (let i = 0; i < channelIds.length; i++) {
      const channelId = channelIds[i];
      const retryJobs = jobsByChannel.get(channelId) || [];

      // Single-row channel lookup by PK/unique channel_id
      const chRes = await q(
        client,
        `channel_${i}`,
        `SELECT channel_id, channel_name, discord_status, discord_validation_status,
                scan_status, scan_attempts, last_checked, next_check,
                inspection_trail, created_at, updated_at
         FROM channels
         WHERE channel_id = $1
         LIMIT 1`,
        [channelId]
      );
      const channel = chRes.rows[0] || null;

      // Observations for this channel only — index (channel_id, observed_at DESC)
      const obsRes = await q(
        client,
        `obs_${i}`,
        `SELECT observation_key, channel_id, requested_url, final_url, outcome,
                retryable, http_status, failure_class, detail, provenance,
                policy_version, observed_at
         FROM external_acquisition_observations
         WHERE channel_id = $1
         ORDER BY observed_at DESC
         LIMIT $2`,
        [channelId, OBS_LIMIT]
      );

      const obs = obsRes.rows.map((o) => ({ ...o, provenance: parseJson(o.provenance) }));

      const qualifying = obs.filter(
        (o) =>
          o.outcome === 'ACQUISITION_FAILED' &&
          o.retryable === true &&
          parseJson(o.provenance)?.required !== false
      );

      const trail = parseJson(channel?.inspection_trail);
      const trailItems = Array.isArray(trail) ? trail : trail ? [trail] : [];
      const step4 = trailItems.filter((x) =>
        /step\s*4|linked websites|custom[_ ]domains|partial|budget/i.test(JSON.stringify(x))
      );
      const step4Text = JSON.stringify(step4);
      const step4Status = /PARTIAL/i.test(step4Text) ? 'PARTIAL' : null;
      const budgetExpired = /budget expired|Rendered acquisition budget/i.test(step4Text);

      // Per-URL attempted vs failed from observations only (never treat missing as failed)
      const urlsAttempted = [...new Set(obs.map((o) => o.requested_url).filter(Boolean))];
      const urlsFailed = [
        ...new Set(
          obs
            .filter((o) => o.outcome === 'ACQUISITION_FAILED')
            .map((o) => o.requested_url)
            .filter(Boolean)
        ),
      ];

      const latestQualifying = qualifying[0] || null; // already observed_at DESC
      const laterSuccess =
        !!latestQualifying &&
        obs.some(
          (o) =>
            new Date(o.observed_at) > new Date(latestQualifying.observed_at) &&
            (o.outcome === 'FOUND' || o.outcome === 'INSPECTED_NO_MATCH')
        );

      // Optional: latest job attempt counts without heavy join — skip if table missing
      let jobAttemptSummary = null;
      try {
        const jid = retryJobs[0]?.job_id;
        if (jid) {
          const att = await q(
            client,
            `attempts_${i}`,
            `SELECT count(*)::int AS n FROM job_attempts WHERE job_id = $1::uuid`,
            [jid]
          );
          jobAttemptSummary = { latest_job_id: jid, attempt_rows: att.rows[0]?.n ?? 0 };
        }
      } catch (_) {
        jobAttemptSummary = null;
      }

      const item = {
        channel_id: channelId,
        channel_name: channel?.channel_name || null,
        projected_reasons: [...new Set(retryJobs.map((j) => j.retry_reason).filter(Boolean))],
        retry_codes: [...new Set(retryJobs.map((j) => j.retry_code).filter(Boolean))],
        retry_sources: [...new Set(retryJobs.map((j) => j.retry_source).filter(Boolean))],
        retry_jobs: sanitize(retryJobs),
        channel_state: sanitize({
          channel_id: channel?.channel_id,
          channel_name: channel?.channel_name,
          discord_status: channel?.discord_status,
          discord_validation_status: channel?.discord_validation_status,
          scan_status: channel?.scan_status,
          scan_attempts: channel?.scan_attempts,
          last_checked: channel?.last_checked,
          next_check: channel?.next_check,
          updated_at: channel?.updated_at,
        }),
        step4_relevant_inspection_trail: sanitize(step4),
        step4_status: step4Status,
        budget_expired: budgetExpired,
        urls_attempted_count: urlsAttempted.length,
        urls_failed_count: urlsFailed.length,
        urls_attempted: urlsAttempted.slice(0, 30),
        urls_failed: urlsFailed.slice(0, 30),
        later_success_after_failure: laterSuccess,
        qualifying_failures: sanitize(qualifying),
        latest_qualifying_failure: sanitize(latestQualifying),
        observation_summary: {
          total_returned: obs.length,
          acquisition_failed: obs.filter((o) => o.outcome === 'ACQUISITION_FAILED').length,
          retryable_failures: obs.filter(
            (o) => o.outcome === 'ACQUISITION_FAILED' && o.retryable === true
          ).length,
          required_retryable_failures: qualifying.length,
          community_surface_required_retryable_failures: qualifying.filter((o) =>
            isCommunitySurface(surfaceOf(o.provenance))
          ).length,
          youtube_about_or_recent_video_failures: obs.filter((o) =>
            isYoutubeSurface(surfaceOf(o.provenance))
          ).length,
          found: obs.filter((o) => o.outcome === 'FOUND').length,
          no_match: obs.filter((o) => o.outcome === 'INSPECTED_NO_MATCH').length,
          partially_inspected: obs.filter((o) => o.outcome === 'PARTIALLY_INSPECTED').length,
        },
        acquisition_observations: sanitize(obs),
        job_attempt_summary: jobAttemptSummary,
      };
      item.verdict = classifyChannel(item);
      report.push(item);
    }

    const counts = {
      matching_retry_jobs_scanned: progress.jobs_scanned,
      distinct_affected_channels: report.length,
      community_reason_jobs: [...jobsByChannel.values()]
        .flat()
        .filter((r) => r.retry_reason === TARGET_REASONS[0]).length,
      upstream_reason_jobs: [...jobsByChannel.values()]
        .flat()
        .filter((r) => r.retry_reason === TARGET_REASONS[1]).length,
      channels_with_required_retryable_failure: report.filter(
        (r) => r.observation_summary.required_retryable_failures > 0
      ).length,
      channels_with_community_surface_required_retryable_failure: report.filter(
        (r) => r.observation_summary.community_surface_required_retryable_failures > 0
      ).length,
      channels_with_no_qualifying_observation: report.filter(
        (r) => r.observation_summary.required_retryable_failures === 0
      ).length,
      channels_with_step4_partial: report.filter((r) => r.step4_status === 'PARTIAL').length,
      channels_with_budget_expired: report.filter((r) => r.budget_expired).length,
      channels_with_later_success_after_failure: report.filter(
        (r) => r.later_success_after_failure
      ).length,
      verdict_counts: report.reduce((acc, r) => {
        acc[r.verdict] = (acc[r.verdict] || 0) + 1;
        return acc;
      }, {}),
      upstream_reason_with_community_ownership: report.filter(
        (r) =>
          r.projected_reasons.includes('UPSTREAM_REQUIRED_ACQUISITION_FAILURE') &&
          r.observation_summary.community_surface_required_retryable_failures > 0 &&
          r.observation_summary.youtube_about_or_recent_video_failures === 0
      ).length,
    };

    const forensicTable = report.map((r) => ({
      Channel: r.channel_id,
      Name: r.channel_name,
      Reason: (r.projected_reasons || []).join('|'),
      Step4: r.step4_status || (r.budget_expired ? 'BUDGET' : 'n/a'),
      URLs_attempted: r.urls_attempted_count,
      Failed: r.urls_failed_count,
      Qualifying_failure: r.observation_summary.required_retryable_failures > 0,
      Required_retryable: r.observation_summary.required_retryable_failures,
      Community_surface_q: r.observation_summary.community_surface_required_retryable_failures,
      Failure_class: r.latest_qualifying_failure?.failure_class || null,
      Surface: surfaceOf(r.latest_qualifying_failure?.provenance) || null,
      Retry_job_status: r.retry_jobs?.[0]?.status || null,
      Verdict: r.verdict,
    }));

    fs.mkdirSync('forensic-output', { recursive: true });
    const payload = {
      generated_at: new Date().toISOString(),
      mode: 'READ_ONLY_POSTGRES_FORENSIC_LOW_TEMP',
      safety: {
        transaction: 'READ ONLY',
        statement_timeout: '30s',
        work_mem: '256kB',
        temp_file_limit: '8MB',
        writes_performed: false,
        production_mutations: false,
        strategy: 'keyset job scan + per-channel indexed lookups; correlation in Node',
      },
      progress,
      indexes_seen: idx.rows.map((r) => r.indexname),
      target_reasons: TARGET_REASONS,
      counts,
      forensic_table: forensicTable,
      affected_channels: report,
    };
    fs.writeFileSync('forensic-output/forensic-report.json', JSON.stringify(payload, null, 2) + '\n');

    const md = [
      '# Production Forensic DB Investigation (low-temp)',
      '',
      `Generated: ${payload.generated_at}`,
      '',
      '## Safety',
      '- READ ONLY transaction',
      '- Batched index lookups; no production writes',
      '',
      '## Counts',
    ];
    for (const [k, v] of Object.entries(counts)) {
      md.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    md.push('', '## Forensic table', '', '```json', JSON.stringify(forensicTable, null, 2), '```');
    for (const r of report) {
      md.push('', `### ${r.channel_id} — ${r.channel_name || 'unknown'} — **${r.verdict}**`);
      md.push(`- Reasons: ${(r.projected_reasons || []).join(', ')}`);
      md.push(`- Qualifying required+retryable failures: ${r.observation_summary.required_retryable_failures}`);
      md.push(`- Step4: ${r.step4_status || 'n/a'}; budget_expired=${r.budget_expired}`);
    }
    fs.writeFileSync('forensic-output/forensic-report.md', md.join('\n') + '\n');

    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, counts, progress }, null, 2));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fs.mkdirSync('forensic-output', { recursive: true });
    fs.writeFileSync(
      'forensic-output/forensic-failure.json',
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          progress,
          failed_label: e.forensicLabel || null,
          failed_sql_preview: e.forensicSql || null,
          message: e.message,
          note:
            'Stopped without destructive cleanup. If minimal SELECT 1 fails, volume is fully exhausted for even trivial queries.',
        },
        null,
        2
      ) + '\n'
    );
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('[forensic-read-only-low-temp] failed:', e.message);
  process.exit(1);
});
