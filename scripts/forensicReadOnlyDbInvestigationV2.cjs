/**
 * Full-population low temporary-space READ-ONLY forensic investigation.
 * Keyset job scan + per-channel indexed lookups; correlation in Node.
 */
const fs = require('node:fs');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL secret is required');

const TARGET_REASONS = [
  'COMMUNITY_REQUIRED_ACQUISITION_FAILURE',
  'UPSTREAM_REQUIRED_ACQUISITION_FAILURE',
];

const JOB_BATCH = Math.max(1, Number(process.env.FORENSIC_JOB_BATCH || 5));
const OBS_LIMIT = Math.max(1, Number(process.env.FORENSIC_OBS_LIMIT || 80));
const MAX_CHANNELS = Math.max(1, Number(process.env.FORENSIC_MAX_CHANNELS || 100000));

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
    if (process.env.FORENSIC_VERBOSE === '1' || label.startsWith('probe') || label.startsWith('index') || label.startsWith('jobs_')) {
      console.error(`[forensic] ok ${label} rows=${res.rowCount} ms=${Date.now() - started}`);
    }
    return res;
  } catch (err) {
    console.error(`[forensic] FAIL ${label} ms=${Date.now() - started}: ${err.message}`);
    err.forensicLabel = label;
    err.forensicSql = sql.replace(/\s+/g, ' ').trim().slice(0, 240);
    throw err;
  }
}

async function trySet(client, sql) {
  try {
    await client.query(sql);
    return true;
  } catch (e) {
    console.error(`[forensic] optional SET skipped: ${e.message}`);
    return false;
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
  ].includes(s);
}

function classifyChannel(item) {
  const reasons = item.projected_reasons || [];
  const hasUpstream = reasons.includes('UPSTREAM_REQUIRED_ACQUISITION_FAILURE');
  const hasCommunity = reasons.includes('COMMUNITY_REQUIRED_ACQUISITION_FAILURE');
  const qf = item.qualifying_failures || [];
  const communityQ = qf.filter((o) => isCommunitySurface(surfaceOf(o.provenance)));
  const upstreamQ = qf.filter((o) => isYoutubeSurface(surfaceOf(o.provenance)));
  const latestSurface = surfaceOf(item.latest_qualifying_failure?.provenance);
  const latestIsCommunity = isCommunitySurface(latestSurface);
  const latestIsUpstream = isYoutubeSurface(latestSurface);

  const noQualifying = qf.length === 0;
  const step4PartialOrBudget = item.step4_status === 'PARTIAL' || item.budget_expired;

  // Priority order (specific first)
  if (noQualifying && step4PartialOrBudget) {
    return 'PARTIAL_OR_BUDGET_WITHOUT_QUALIFYING_FAILURE';
  }
  if (item.later_success_after_failure) {
    return 'STALE_DURABLE_RETRY_METADATA';
  }
  if (noQualifying) {
    return 'STALE_DURABLE_RETRY_METADATA';
  }
  if (hasUpstream && latestIsCommunity) {
    return 'UPSTREAM_ON_COMMUNITY_SURFACE';
  }
  if (hasUpstream && upstreamQ.length > 0 && communityQ.length === 0) {
    return 'LEGITIMATE_UPSTREAM_FAILURE';
  }
  if (hasUpstream && upstreamQ.length > 0) {
    return 'LEGITIMATE_UPSTREAM_FAILURE';
  }
  if (hasCommunity && communityQ.length > 0 && upstreamQ.length === 0) {
    return 'LEGITIMATE_COMMUNITY_FAILURE';
  }
  if (hasCommunity && communityQ.length > 0) {
    return 'LEGITIMATE_COMMUNITY_FAILURE';
  }
  if (hasCommunity && upstreamQ.length > 0 && communityQ.length === 0) {
    return 'OTHER/AMBIGUOUS';
  }
  if (qf.length > 0) {
    return 'OTHER/AMBIGUOUS';
  }
  return 'OTHER/AMBIGUOUS';
}

function extractStep4Meta(trailItems) {
  const step4 = trailItems.filter((x) =>
    /step\s*4|linked websites|custom[_ ]domains|partial|budget|rendered/i.test(JSON.stringify(x))
  );
  const text = JSON.stringify(step4);
  const step4Status = /\bPARTIAL\b/i.test(text) ? 'PARTIAL' : /\bCOMPLETE\b|\bDONE\b|\bSUCCESS\b/i.test(text) ? 'COMPLETE' : null;
  const budgetExpired = /budget expired|Rendered acquisition budget|budgetExhausted/i.test(text);

  let selectedUrlCount = null;
  let attemptedUrlCount = null;
  let completedUrlCount = null;
  let failedUrlCount = null;
  let unattemptedUrlCount = null;

  for (const item of step4) {
    const s = typeof item === 'object' && item ? item : {};
    const candidates = [s, s.details, s.meta, s.telemetry, s.summary].filter(Boolean);
    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;
      if (selectedUrlCount == null && c.selectedUrlCount != null) selectedUrlCount = Number(c.selectedUrlCount);
      if (attemptedUrlCount == null && (c.attemptedUrlCount != null || c.urlsAttempted != null)) {
        attemptedUrlCount = Number(c.attemptedUrlCount ?? c.urlsAttempted);
      }
      if (completedUrlCount == null && (c.completedUrlCount != null || c.urlsCompleted != null)) {
        completedUrlCount = Number(c.completedUrlCount ?? c.urlsCompleted);
      }
      if (failedUrlCount == null && (c.failedUrlCount != null || c.urlsFailed != null)) {
        failedUrlCount = Number(c.failedUrlCount ?? c.urlsFailed);
      }
      if (unattemptedUrlCount == null && (c.unattemptedUrlCount != null || c.urlsUnattempted != null || c.skippedUrlCount != null)) {
        unattemptedUrlCount = Number(c.unattemptedUrlCount ?? c.urlsUnattempted ?? c.skippedUrlCount);
      }
    }
  }

  return {
    step4,
    step4Status,
    budgetExpired,
    selectedUrlCount,
    attemptedUrlCount,
    completedUrlCount,
    failedUrlCount,
    unattemptedUrlCount,
  };
}

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    application_name: 'forensic-readonly-full-pop',
    statement_timeout: 60000,
  });
  await client.connect();

  const progress = {
    phase: 'init',
    minimal_query_ok: false,
    jobs_scanned: 0,
    channels_found: 0,
    channels_processed: 0,
  };

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await trySet(client, "SET LOCAL statement_timeout = '60s'");
    await trySet(client, "SET LOCAL lock_timeout = '5s'");
    await trySet(client, "SET LOCAL work_mem = '1MB'");
    await trySet(client, "SET LOCAL temp_file_limit = '32MB'");

    progress.phase = 'probe';
    await q(client, 'probe_select_1', 'SELECT 1 AS ok');
    progress.minimal_query_ok = true;

    progress.phase = 'catalog';
    const idx = await q(
      client,
      'index_probe',
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename IN ('jobs','external_acquisition_observations','channels','job_attempts')
       LIMIT 50`
    );

    progress.phase = 'scan_jobs';
    const jobsByChannel = new Map();

    for (const reason of TARGET_REASONS) {
      let lastCreated = null;
      let lastId = null;
      let safetyLoops = 0;
      while (safetyLoops < 20000) {
        safetyLoops += 1;
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
                   payload->>'observationAt' AS observation_at,
                   payload->>'reconciliationStatus' AS reconciliation_status,
                   payload->>'reconciliationCode' AS reconciliation_code,
                   payload->>'deferralCount' AS deferral_count
            FROM jobs
            WHERE type = 'RETRY_COMMUNITY_ACQUISITION'
              AND payload->>'retryReason' = $1
            ORDER BY created_at ASC, id ASC
            LIMIT $2`;
          params = [reason, JOB_BATCH];
        } else {
          sql = `
            SELECT id::text AS job_id, status, attempts, max_attempts,
                   run_after, created_at, updated_at, last_error,
                   payload->>'channelId' AS channel_id,
                   payload->>'retryReason' AS retry_reason,
                   payload->>'retryCode' AS retry_code,
                   payload->>'retrySource' AS retry_source,
                   payload->>'observedAt' AS retry_observed_at,
                   payload->>'observationAt' AS observation_at,
                   payload->>'reconciliationStatus' AS reconciliation_status,
                   payload->>'reconciliationCode' AS reconciliation_code,
                   payload->>'deferralCount' AS deferral_count
            FROM jobs
            WHERE type = 'RETRY_COMMUNITY_ACQUISITION'
              AND payload->>'retryReason' = $1
              AND (created_at, id) > ($2::timestamptz, $3::uuid)
            ORDER BY created_at ASC, id ASC
            LIMIT $4`;
          params = [reason, lastCreated, lastId, JOB_BATCH];
        }

        const batch = await q(client, `jobs_${reason.slice(0, 16)}_${safetyLoops}`, sql, params);
        progress.jobs_scanned += batch.rowCount;
        if (batch.rowCount === 0) break;

        for (const row of batch.rows) {
          if (!row.channel_id) continue;
          if (!jobsByChannel.has(row.channel_id)) {
            if (jobsByChannel.size >= MAX_CHANNELS) continue;
            jobsByChannel.set(row.channel_id, []);
          }
          jobsByChannel.get(row.channel_id).push(row);
          lastCreated = row.created_at;
          lastId = row.job_id;
        }
        if (batch.rowCount < JOB_BATCH) break;
        if (safetyLoops % 50 === 0) {
          console.error(`[forensic] progress jobs_scanned=${progress.jobs_scanned} channels=${jobsByChannel.size}`);
        }
      }
    }

    const channelIds = [...jobsByChannel.keys()];
    progress.channels_found = channelIds.length;
    progress.phase = 'per_channel';
    console.error(`[forensic] scanning ${channelIds.length} channels (jobs=${progress.jobs_scanned})`);

    const report = [];

    for (let i = 0; i < channelIds.length; i++) {
      const channelId = channelIds[i];
      const retryJobs = jobsByChannel.get(channelId) || [];
      // Prefer most recent job first for projection fields
      retryJobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

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
      const step4Meta = extractStep4Meta(trailItems);

      const urlsAttempted = [...new Set(obs.map((o) => o.requested_url).filter(Boolean))];
      const urlsFailed = [
        ...new Set(
          obs
            .filter((o) => o.outcome === 'ACQUISITION_FAILED')
            .map((o) => o.requested_url)
            .filter(Boolean)
        ),
      ];
      const urlsCompleted = [
        ...new Set(
          obs
            .filter((o) => o.outcome === 'FOUND' || o.outcome === 'INSPECTED_NO_MATCH')
            .map((o) => o.requested_url)
            .filter(Boolean)
        ),
      ];

      const latestQualifying = qualifying[0] || null;
      const laterSuccess =
        !!latestQualifying &&
        obs.some(
          (o) =>
            new Date(o.observed_at) > new Date(latestQualifying.observed_at) &&
            (o.outcome === 'FOUND' || o.outcome === 'INSPECTED_NO_MATCH')
        );

      let jobAttemptSummary = null;
      try {
        const jid = retryJobs[0]?.job_id;
        if (jid) {
          const att = await q(
            client,
            `attempts_${i}`,
            `SELECT count(*)::int AS n,
                    max(started_at) AS last_started_at,
                    max(finished_at) AS last_finished_at
             FROM job_attempts WHERE job_id = $1::uuid`,
            [jid]
          );
          jobAttemptSummary = {
            latest_job_id: jid,
            attempt_rows: att.rows[0]?.n ?? 0,
            last_started_at: att.rows[0]?.last_started_at || null,
            last_finished_at: att.rows[0]?.last_finished_at || null,
          };
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
        latest_retry_job: sanitize(retryJobs[0] || null),
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
        step4_relevant_inspection_trail: sanitize(step4Meta.step4),
        step4_status: step4Meta.step4Status,
        budget_expired: step4Meta.budgetExpired,
        step4_selected_url_count: step4Meta.selectedUrlCount,
        step4_attempted_url_count: step4Meta.attemptedUrlCount,
        step4_completed_url_count: step4Meta.completedUrlCount,
        step4_failed_url_count: step4Meta.failedUrlCount,
        step4_unattempted_url_count: step4Meta.unattemptedUrlCount,
        urls_attempted_count: urlsAttempted.length,
        urls_failed_count: urlsFailed.length,
        urls_completed_count: urlsCompleted.length,
        urls_attempted: urlsAttempted.slice(0, 40),
        urls_failed: urlsFailed.slice(0, 40),
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
      progress.channels_processed = i + 1;

      if ((i + 1) % 100 === 0) {
        console.error(`[forensic] channels processed ${i + 1}/${channelIds.length}`);
      }
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
      channels_with_community_reason: report.filter((r) =>
        r.projected_reasons.includes(TARGET_REASONS[0])
      ).length,
      channels_with_upstream_reason: report.filter((r) =>
        r.projected_reasons.includes(TARGET_REASONS[1])
      ).length,
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
      channels_with_completed_retry_job: report.filter(
        (r) => r.latest_retry_job?.status === 'COMPLETED'
      ).length,
      channels_with_upstream_reason_latest_community_surface: report.filter(
        (r) =>
          r.projected_reasons.includes('UPSTREAM_REQUIRED_ACQUISITION_FAILURE') &&
          isCommunitySurface(surfaceOf(r.latest_qualifying_failure?.provenance))
      ).length,
      verdict_counts: report.reduce((acc, r) => {
        acc[r.verdict] = (acc[r.verdict] || 0) + 1;
        return acc;
      }, {}),
    };

    const failureClassDist = {};
    const surfaceDist = {};
    for (const r of report) {
      const fc = r.latest_qualifying_failure?.failure_class || '(none)';
      failureClassDist[fc] = (failureClassDist[fc] || 0) + 1;
      const s = surfaceOf(r.latest_qualifying_failure?.provenance) || '(none)';
      surfaceDist[s] = (surfaceDist[s] || 0) + 1;
    }
    counts.failure_class_distribution = failureClassDist;
    counts.surface_distribution = surfaceDist;

    const forensicTable = report.map((r) => ({
      Channel: r.channel_id,
      Name: r.channel_name,
      Reason: (r.projected_reasons || []).join('|'),
      RetryCode: (r.retry_codes || []).join('|'),
      RetrySource: (r.retry_sources || []).join('|'),
      JobStatus: r.latest_retry_job?.status || null,
      JobAttempts: r.latest_retry_job?.attempts ?? null,
      Deferral: r.latest_retry_job?.deferral_count ?? null,
      ScanStatus: r.channel_state?.scan_status || null,
      DiscordStatus: r.channel_state?.discord_status || null,
      LastChecked: r.channel_state?.last_checked || null,
      Step4: r.step4_status || (r.budget_expired ? 'BUDGET' : 'n/a'),
      URLs_attempted: r.urls_attempted_count,
      URLs_completed: r.urls_completed_count,
      Failed: r.urls_failed_count,
      Qualifying_failure: r.observation_summary.required_retryable_failures > 0,
      Required_retryable: r.observation_summary.required_retryable_failures,
      Community_surface_q: r.observation_summary.community_surface_required_retryable_failures,
      Later_success: r.later_success_after_failure,
      Failure_class: r.latest_qualifying_failure?.failure_class || null,
      Surface: surfaceOf(r.latest_qualifying_failure?.provenance) || null,
      Verdict: r.verdict,
    }));

    // Representative examples per verdict
    const examples = {};
    for (const r of report) {
      if (!examples[r.verdict]) examples[r.verdict] = [];
      if (examples[r.verdict].length < 8) {
        examples[r.verdict].push({
          channel_id: r.channel_id,
          channel_name: r.channel_name,
          reasons: r.projected_reasons,
          step4_status: r.step4_status,
          budget_expired: r.budget_expired,
          later_success_after_failure: r.later_success_after_failure,
          latest_qualifying: r.latest_qualifying_failure
            ? {
                outcome: r.latest_qualifying_failure.outcome,
                retryable: r.latest_qualifying_failure.retryable,
                failure_class: r.latest_qualifying_failure.failure_class,
                surface: surfaceOf(r.latest_qualifying_failure.provenance),
                required: parseJson(r.latest_qualifying_failure.provenance)?.required,
                observed_at: r.latest_qualifying_failure.observed_at,
                requested_url: r.latest_qualifying_failure.requested_url,
              }
            : null,
          job_status: r.latest_retry_job?.status,
          observation_summary: r.observation_summary,
        });
      }
    }

    fs.mkdirSync('forensic-output', { recursive: true });
    const payload = {
      generated_at: new Date().toISOString(),
      mode: 'READ_ONLY_POSTGRES_FORENSIC_FULL_POPULATION',
      safety: {
        transaction: 'READ ONLY',
        statement_timeout: '60s',
        work_mem: '1MB',
        writes_performed: false,
        production_mutations: false,
        strategy: 'per-reason keyset job scan + per-channel indexed lookups; correlation in Node; no population cap',
      },
      progress,
      indexes_seen: idx.rows.map((r) => r.indexname),
      target_reasons: TARGET_REASONS,
      counts,
      examples_by_verdict: examples,
      forensic_table: forensicTable,
      affected_channels: report,
    };
    fs.writeFileSync('forensic-output/forensic-report.json', JSON.stringify(payload, null, 2) + '\n');

    const md = [
      '# Production Forensic DB Investigation (FULL POPULATION)',
      '',
      `Generated: ${payload.generated_at}`,
      '',
      '## Safety',
      '- READ ONLY transaction',
      '- Keyset + per-channel indexed lookups; no production writes',
      '',
      '## Counts',
    ];
    for (const [k, v] of Object.entries(counts)) {
      md.push(`- **${k}**: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    md.push('', '## Examples by verdict');
    for (const [verdict, list] of Object.entries(examples)) {
      md.push('', `### ${verdict}`);
      for (const ex of list) {
        md.push(`- ${ex.channel_id} (${ex.channel_name || '?'}) reasons=${(ex.reasons || []).join('|')} job=${ex.job_status} later_success=${ex.later_success_after_failure}`);
      }
    }
    md.push('', '## Forensic table', '', '```json', JSON.stringify(forensicTable, null, 2), '```');
    fs.writeFileSync('forensic-output/forensic-report.md', md.join('\n') + '\n');

    // Slim CSV-like table for quick review
    fs.writeFileSync(
      'forensic-output/forensic-table.json',
      JSON.stringify({ generated_at: payload.generated_at, counts, forensic_table: forensicTable, examples_by_verdict: examples }, null, 2) + '\n'
    );

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
          note: 'Stopped without destructive cleanup.',
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
  console.error('[forensic-read-only-full] failed:', e.message);
  process.exit(1);
});
