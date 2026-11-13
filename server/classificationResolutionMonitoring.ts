import { getDb } from './db';
import { calculateEnrichmentQuotaReserve, readEnrichmentQuotaDemand } from './dbCore';
import { getYouTubeQuotaDay } from './youtubeQuotaDay';
import { ENFORCED_CAP_UNITS } from './quotaKeyCapShadow';

const STAGE2_POSTFIX_SHADOW_OBSERVATION_PREFIX = 'stage2-postfix-shadow-v1:';

export const CLASSIFICATION_RESOLUTION_MONITORING_VERSION = 'classification-resolution-monitoring-v1';

export interface ResolutionAlert {
  code: string;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  message: string;
  value: number | string;
}

export interface ClassificationResolutionOverview {
  version: string;
  generatedAt: string;
  channels: {
    total: number;
    trading: Record<string, number>;
    scan: Record<string, number>;
    uncertain: number;
    needsReview: number;
  };
  enrichment: {
    pending: number;
    due: number;
    processing: number;
    oldestDueHours: number;
    completed24h: number;
    failed24h: number;
    orphanPending: number;
    genericFailures: number;
    recoveryCycles24h: number;
    exhaustionReviewsPending: number;
  };
  reviews: {
    pending: number;
    oldestPendingDays: number;
    eligible: number;
    deferred: number;
    notEligible: number;
    eligibleWithoutPendingReview: number;
  };
  routes: {
    byRoute: Record<string, number>;
    byRecognition: Record<string, number>;
    semanticUsed: number;
    semanticAttempted: number;
    unclassified: number;
  };
  quota: {
    dailyLimit: number;
    used: number;
    remaining: number;
    dueStage1: number;
    dueStage2: number;
    reserveUnits: number;
    protectedShare: number;
    discoveryAvailable: number;
    recentAutonomousUnits: number;
    recentEnrichmentUnits: number;
  };
  alerts: ResolutionAlert[];
}

function countMap(rows: Array<{ key?: unknown; count?: unknown }>): Record<string, number> {
  return Object.fromEntries(rows.map(row => [String(row.key || 'UNKNOWN'), Number(row.count) || 0]));
}

export function buildResolutionAlerts(input: {
  dueEnrichment: number;
  oldestDueHours: number;
  orphanPending: number;
  genericFailures: number;
  unresolvedCompleted: number;
  eligibleWithoutPendingReview: number;
  pendingReviews: number;
  oldestReviewDays: number;
  semanticRateLimitCalls15m: number;
  youtubeKeysAtCap: number;
}): ResolutionAlert[] {
  const alerts: ResolutionAlert[] = [];
  if (input.dueEnrichment > 100 || input.oldestDueHours >= 6) {
    alerts.push({
      code: 'ENRICHMENT_BACKLOG_AGED',
      severity: input.oldestDueHours >= 24 || input.dueEnrichment >= 1000 ? 'CRITICAL' : 'WARN',
      message: 'Due enrichment backlog is aged or large; discovery may be consuming enrichment quota.',
      value: `${input.dueEnrichment} due / ${Math.round(input.oldestDueHours)}h oldest`,
    });
  }
  if (input.orphanPending > 0) {
    alerts.push({
      code: 'ORPHAN_ENRICHMENT_PENDING',
      severity: 'WARN',
      message: 'Channels are ENRICHMENT_PENDING with no active job.',
      value: input.orphanPending,
    });
  }
  if (input.genericFailures > 0) {
    alerts.push({
      code: 'GENERIC_TERMINAL_FAILURES',
      severity: 'WARN',
      message: 'Generic enrichment failures are awaiting bounded recovery or review.',
      value: input.genericFailures,
    });
  }
  if (input.unresolvedCompleted > 0) {
    alerts.push({
      code: 'UNRESOLVED_COMPLETED',
      severity: 'CRITICAL',
      message: 'UNCERTAIN/COMPLETED rows are not a successful resolution.',
      value: input.unresolvedCompleted,
    });
  }
  if (input.eligibleWithoutPendingReview > 0) {
    alerts.push({
      code: 'ELIGIBLE_REVIEW_WITHOUT_PENDING',
      severity: 'CRITICAL',
      message: 'Eligible review projections exist without a pending review row.',
      value: input.eligibleWithoutPendingReview,
    });
  }
  if (input.pendingReviews > 0 && input.oldestReviewDays >= 7) {
    alerts.push({
      code: 'REVIEW_QUEUE_AGED',
      severity: input.oldestReviewDays >= 30 ? 'CRITICAL' : 'WARN',
      message: 'The oldest pending human review is aged.',
      value: `${input.pendingReviews} pending / ${Math.round(input.oldestReviewDays)}d oldest`,
    });
  }
  if (input.semanticRateLimitCalls15m >= 20) {
    alerts.push({
      code: 'SEMANTIC_ROUTE_PRESSURE',
      severity: input.semanticRateLimitCalls15m >= 100 ? 'CRITICAL' : 'WARN',
      message: 'Semantic providers are rate-limited/deferred; the claim gate is throttling enrichment.',
      value: input.semanticRateLimitCalls15m,
    });
  }
  if (input.youtubeKeysAtCap >= 5) {
    alerts.push({
      code: 'YOUTUBE_KEYS_AT_CAP',
      severity: input.youtubeKeysAtCap >= 20 ? 'CRITICAL' : 'WARN',
      message: 'Many YouTube keys are at the enforced daily cap; enrichment quota may be starved.',
      value: input.youtubeKeysAtCap,
    });
  }
  return alerts;
}

export async function getClassificationResolutionOverview(dbOverride?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): Promise<ClassificationResolutionOverview> {
  const db: any = dbOverride || await getDb();
  const quotaDay = getYouTubeQuotaDay();
  const [
    channelStatus,
    scanStatus,
    routes,
    enrichmentJobs,
    orphanPending,
    genericFailures,
    recoveryCycles,
    exhaustionReviews,
    reviewStates,
    eligibility,
    eligibleWithoutPending,
    quotaRow,
    reservedQuota,
    hardCapSetting,
    recentProviderCalls,
    keysAtCap,
    unresolvedCompletedRows,
    demand,
  ] = await Promise.all([
    db.query(`SELECT trading_status AS key,count(*)::int AS count FROM channels GROUP BY trading_status`),
    db.query(`SELECT scan_status AS key,count(*)::int AS count FROM channels GROUP BY scan_status`),
    db.query(
      `SELECT COALESCE(latest.decision->'deterministicRouting'->>'route','UNROUTED') AS key,
              COALESCE(latest.decision->>'recognitionState',latest.decision->'recognition'->>'state','UNKNOWN') AS recognition,
              CASE WHEN latest.decision->'deterministicRouting' ? 'semanticUsed'
                THEN COALESCE(latest.decision->'deterministicRouting'->>'semanticUsed','false')
                ELSE CASE WHEN EXISTS(
                  SELECT 1 FROM jsonb_array_elements(COALESCE(latest.decision->'evidenceCollection'->'providers','[]'::jsonb)) p
                   WHERE p->>'provider' IN('gemini_semantic','groq_semantic','gemini_free_semantic')
                     AND p->>'outcome'='EXECUTED_WITH_EVIDENCE'
                ) THEN 'true' ELSE 'false' END
              END AS semantic_used,
              CASE WHEN latest.decision->'deterministicRouting' ? 'semanticAttempted'
                THEN COALESCE(latest.decision->'deterministicRouting'->>'semanticAttempted','false')
                ELSE CASE WHEN EXISTS(
                  SELECT 1 FROM jsonb_array_elements(COALESCE(latest.decision->'evidenceCollection'->'providers','[]'::jsonb)) p
                   WHERE p->>'provider' IN('gemini_semantic','groq_semantic','gemini_free_semantic')
                     AND p->>'availability' IN('AVAILABLE','FAILED')
                     AND p->>'outcome' NOT IN('SUPPRESSED_BY_POLICY','NOT_APPLICABLE','UNAVAILABLE_CONFIGURATION')
                ) THEN 'true' ELSE 'false' END
              END AS semantic_attempted,
              count(*)::int AS count
         FROM (
           SELECT DISTINCT ON (channel_id) decision
             FROM production_classification_diagnostics
            WHERE observation_key IS NULL OR observation_key NOT LIKE '${STAGE2_POSTFIX_SHADOW_OBSERVATION_PREFIX}%'
            ORDER BY channel_id,created_at DESC,id DESC
         ) latest
        GROUP BY 1,2,3,4`,
    ),
    db.query(
      `SELECT status AS key,count(*)::int AS count,
              COALESCE(MAX(EXTRACT(EPOCH FROM(now()-run_after))/3600) FILTER (WHERE status='PENDING' AND run_after<=now()),0) AS oldest_due_hours
         FROM jobs WHERE type IN ('ENRICH_CHANNEL','PROCESS_DISCOVERED_CHANNEL') AND (status IN('PENDING','PROCESSING') OR updated_at>=now()-interval '24 hours')
        GROUP BY status`,
    ),
    db.query(
      `SELECT count(*)::int AS count
         FROM channels c
        WHERE c.trading_status='UNCERTAIN' AND c.scan_status='ENRICHMENT_PENDING'
          AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.payload->>'channelId'=c.channel_id AND j.type IN('ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','PROCESS_DISCOVERED_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION') AND j.status IN('PENDING','PROCESSING'))`,
    ),
    db.query(
      `SELECT count(*)::int AS count
         FROM channels c
         JOIN LATERAL (
           SELECT j.status,j.terminal_failure_class FROM jobs j
            WHERE j.type IN('ENRICH_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN') AND j.payload->>'channelId'=c.channel_id
            ORDER BY j.updated_at DESC NULLS LAST,j.id DESC LIMIT 1
         ) j ON true
        WHERE c.trading_status='UNCERTAIN' AND c.scan_status='FAILED'
          AND j.status='FAILED' AND COALESCE(j.terminal_failure_class,'UNKNOWN') IN('RETRYABLE','UNKNOWN')`,
    ),
    db.query(`SELECT count(*)::int AS count FROM operational_enrichment_recovery_events WHERE event_key LIKE 'operational-enrichment:%' AND created_at>=now()-interval '24 hours'`),
    db.query(`SELECT count(*)::int AS count FROM channel_reviews WHERE state='PENDING' AND evidence_snapshot->>'reasonFamily'='EVIDENCE_EXHAUSTED'`),
    db.query(`SELECT state AS key,count(*)::int AS count,COALESCE(MAX(EXTRACT(EPOCH FROM(now()-pending_since))/86400) FILTER (WHERE state='PENDING'),0) AS oldest_days FROM channel_reviews GROUP BY state`),
    db.query(`SELECT status AS key,count(*)::int AS count FROM review_eligibility_projection GROUP BY status`),
    db.query(
      `SELECT count(*)::int AS count FROM review_eligibility_projection p
        WHERE p.status='ELIGIBLE'
          AND NOT EXISTS(SELECT 1 FROM channel_reviews r WHERE r.channel_id=p.channel_id AND r.state='PENDING')
          AND NOT EXISTS(
            SELECT 1 FROM channel_reviews r
             WHERE r.channel_id=p.channel_id
               AND r.state IN('APPROVED','REJECTED')
               AND r.decided_at IS NOT NULL AND r.decided_at >= p.decided_at
          )`,
    ),
    db.query(`SELECT units_used,daily_limit,last_reset FROM quota_tracker WHERE id='youtube'`),
    db.query(`SELECT COALESCE(SUM(units),0)::int AS reserved FROM quota_reservations WHERE status='RESERVED' AND expires_at>now()`),
    db.query(`SELECT setting_value FROM app_settings WHERE setting_key='youtube_key_daily_cap_enforced'`),
    db.query(
      `SELECT count(*)::int AS count FROM provider_call_events
        WHERE occurred_at>=now()-interval '15 minutes' AND provider IN('gemini','groq','gemini-free') AND operation='multilingual-semantic-classification' AND status IN('RATE_LIMITED','TRANSIENT_ERROR')`,
    ),
    db.query(
      `SELECT count(*)::int AS count
         FROM youtube_key_quota_usage u
        WHERE u.quota_day=$1
          AND u.units_used + COALESCE((
            SELECT SUM(l.reserved_units) FROM youtube_key_cap_shadow_leases l
             WHERE l.quota_day=u.quota_day AND l.key_fingerprint=u.key_fingerprint AND l.expires_at>now()
          ),0) >= $2`,
      [quotaDay, ENFORCED_CAP_UNITS],
    ),
    db.query(`SELECT count(*)::int AS count FROM channels WHERE trading_status='UNCERTAIN' AND scan_status='COMPLETED'`),
    readEnrichmentQuotaDemand(db),
  ]);
  const jobsByStatus = countMap(enrichmentJobs.rows);
  const reviewsByState = countMap(reviewStates.rows);
  const quota = quotaRow.rows[0] || { units_used: 0, daily_limit: 0, last_reset: '' };
  const hardCapEnforced = String(hardCapSetting.rows[0]?.setting_value || '') === 'true';
  const quotaUsed = String(quota.last_reset) === quotaDay ? Number(quota.units_used) || 0 : 0;
  const keysAtCapCount = hardCapEnforced && String(quota.last_reset) === quotaDay ? Number(keysAtCap.rows[0]?.count || 0) : 0;
  const dueStage1: number = demand.dueStage1;
  const dueStage2: number = demand.dueStage2;
  const protection = calculateEnrichmentQuotaReserve({
    dailyBudget: Number(quota.daily_limit) || 0,
    actualUsed: quotaUsed,
    reservedTotal: Number(reservedQuota.rows[0]?.reserved) || 0,
    dueStage1,
    dueStage2,
    recentAutonomousUnits: demand.recentAutonomousUnits,
    recentEnrichmentUnits: demand.recentEnrichmentUnits,
  });
  const oldestDueHours = Math.max(0, ...enrichmentJobs.rows.map(row => Number(row.oldest_due_hours) || 0));
  const channelTrading = countMap(channelStatus.rows);
  const channelScan = countMap(scanStatus.rows);
  const totalChannels = Object.values(channelTrading).reduce((sum, value) => sum + value, 0);
  const byRoute: Record<string, number> = {};
  const byRecognition: Record<string, number> = {};
  let semanticUsed = 0;
  let semanticAttempted = 0;
  for (const row of routes.rows) {
    const count = Number(row.count) || 0;
    byRoute[String(row.key || 'UNROUTED')] = (byRoute[String(row.key || 'UNROUTED')] || 0) + count;
    byRecognition[String(row.recognition || 'UNKNOWN')] = (byRecognition[String(row.recognition || 'UNKNOWN')] || 0) + count;
    if (row.semantic_used === 'true') semanticUsed += count;
    if (row.semantic_attempted === 'true') semanticAttempted += count;
  }
  const unresolvedCompleted = Number(unresolvedCompletedRows.rows[0]?.count || 0);
  const pendingReviews = Number(reviewsByState.PENDING || 0);
  const oldestReviewDays = Math.max(0, ...reviewStates.rows.map(row => Number(row.oldest_days) || 0));
  const alerts = buildResolutionAlerts({
    dueEnrichment: dueStage1 + dueStage2,
    oldestDueHours,
    orphanPending: Number(orphanPending.rows[0]?.count || 0),
    genericFailures: Number(genericFailures.rows[0]?.count || 0),
    unresolvedCompleted,
    eligibleWithoutPendingReview: Number(eligibleWithoutPending.rows[0]?.count || 0),
    pendingReviews,
    oldestReviewDays,
    semanticRateLimitCalls15m: Number(recentProviderCalls.rows[0]?.count || 0),
    youtubeKeysAtCap: keysAtCapCount,
  });
  return {
    version: CLASSIFICATION_RESOLUTION_MONITORING_VERSION,
    generatedAt: new Date().toISOString(),
    channels: {
      total: totalChannels,
      trading: channelTrading,
      scan: channelScan,
      uncertain: Number(channelTrading.UNCERTAIN || 0),
      needsReview: Number(channelTrading.NEEDS_REVIEW || 0),
    },
    enrichment: {
      pending: Number(jobsByStatus.PENDING || 0),
      due: dueStage1 + dueStage2,
      processing: Number(jobsByStatus.PROCESSING || 0),
      oldestDueHours: Math.round(oldestDueHours * 10) / 10,
      completed24h: Number(jobsByStatus.COMPLETED || 0),
      failed24h: Number(jobsByStatus.FAILED || 0),
      orphanPending: Number(orphanPending.rows[0]?.count || 0),
      genericFailures: Number(genericFailures.rows[0]?.count || 0),
      recoveryCycles24h: Number(recoveryCycles.rows[0]?.count || 0),
      exhaustionReviewsPending: Number(exhaustionReviews.rows[0]?.count || 0),
    },
    reviews: {
      pending: pendingReviews,
      oldestPendingDays: Math.round(oldestReviewDays * 10) / 10,
      eligible: Number(countMap(eligibility.rows).ELIGIBLE || 0),
      deferred: Number(countMap(eligibility.rows).DEFERRED || 0),
      notEligible: Number(countMap(eligibility.rows).NOT_ELIGIBLE || 0),
      eligibleWithoutPendingReview: Number(eligibleWithoutPending.rows[0]?.count || 0),
    },
    routes: {
      byRoute,
      byRecognition,
      semanticUsed,
      semanticAttempted,
      unclassified: Number(byRoute.UNROUTED || 0),
    },
    quota: {
      dailyLimit: Number(quota.daily_limit) || 0,
      used: quotaUsed,
      remaining: protection.remainingUnits,
      dueStage1,
      dueStage2,
      reserveUnits: protection.reserveUnits,
      protectedShare: protection.protectedShare,
      discoveryAvailable: protection.discoveryAvailableUnits,
      recentAutonomousUnits: demand.recentAutonomousUnits,
      recentEnrichmentUnits: demand.recentEnrichmentUnits,
    },
    alerts,
  };
}
