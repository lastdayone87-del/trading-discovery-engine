import { getDb } from './db';
import { calculateEnrichmentQuotaReserve } from './dbCore';

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

export async function getClassificationResolutionOverview(): Promise<ClassificationResolutionOverview> {
  const db = await getDb();
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
    dueStage,
    recentConsumption,
    recentProviderCalls,
    keysAtCap,
    unresolvedCompletedRows,
  ] = await Promise.all([
    db.query(`SELECT trading_status AS key,count(*)::int AS count FROM channels GROUP BY trading_status`),
    db.query(`SELECT scan_status AS key,count(*)::int AS count FROM channels GROUP BY scan_status`),
    db.query(
      `SELECT COALESCE(latest.decision->'deterministicRouting'->>'route','UNROUTED') AS key,count(*)::int AS count
         FROM (
           SELECT DISTINCT ON (channel_id) decision
             FROM production_classification_diagnostics
            ORDER BY channel_id,created_at DESC,id DESC
         ) latest
        GROUP BY 1`,
    ),
    db.query(
      `SELECT status AS key,count(*)::int AS count,
              COALESCE(MAX(EXTRACT(EPOCH FROM(now()-created_at))/3600) FILTER (WHERE status='PENDING' AND run_after<=now()),0) AS oldest_due_hours
         FROM jobs WHERE type='ENRICH_CHANNEL' AND (status IN('PENDING','PROCESSING') OR updated_at>=now()-interval '24 hours')
        GROUP BY status`,
    ),
    db.query(
      `SELECT count(*)::int AS count
         FROM channels c
        WHERE c.trading_status='UNCERTAIN' AND c.scan_status='ENRICHMENT_PENDING'
          AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.payload->>'channelId'=c.channel_id AND j.type IN('ENRICH_CHANNEL','CLASSIFY_DISCOVERED_CHANNEL','POST_APPROVAL_ENRICH','FORCE_REVIEW_RESCAN','RETRY_COMMUNITY_ACQUISITION') AND j.status IN('PENDING','PROCESSING'))`,
    ),
    db.query(
      `SELECT count(*)::int AS count
         FROM channels c
         JOIN LATERAL (
           SELECT j.status,j.terminal_failure_class FROM jobs j
            WHERE j.type='ENRICH_CHANNEL' AND j.payload->>'channelId'=c.channel_id
            ORDER BY j.updated_at DESC NULLS LAST,j.id DESC LIMIT 1
         ) j ON true
        WHERE c.trading_status='UNCERTAIN' AND c.scan_status='FAILED'
          AND j.status='FAILED' AND COALESCE(j.terminal_failure_class,'UNKNOWN') IN('RETRYABLE','UNKNOWN')`,
    ),
    db.query(`SELECT count(*)::int AS count FROM operational_enrichment_recovery_events WHERE event_key LIKE 'classification-resolution-recovery:cycle:%' AND created_at>=now()-interval '24 hours'`),
    db.query(`SELECT count(*)::int AS count FROM channel_reviews WHERE state='PENDING' AND evidence_snapshot->>'reasonFamily'='EVIDENCE_EXHAUSTED'`),
    db.query(`SELECT state AS key,count(*)::int AS count,COALESCE(MAX(EXTRACT(EPOCH FROM(now()-pending_since))/86400) FILTER (WHERE state='PENDING'),0) AS oldest_days FROM channel_reviews GROUP BY state`),
    db.query(`SELECT status AS key,count(*)::int AS count FROM review_eligibility_projection GROUP BY status`),
    db.query(
      `SELECT count(*)::int AS count FROM review_eligibility_projection p
        WHERE p.status='ELIGIBLE'
          AND NOT EXISTS(SELECT 1 FROM channel_reviews r WHERE r.channel_id=p.channel_id AND r.state='PENDING')`,
    ),
    db.query(`SELECT units_used,daily_limit,last_reset FROM quota_tracker WHERE id='youtube'`),
    db.query(
      `SELECT
         count(*) FILTER (WHERE COALESCE((payload->>'enrichmentStage')::int,1)<=1 AND NOT (COALESCE((payload->'candidate'->>'enrichmentStage')::int,0) >= COALESCE((payload->>'enrichmentStage')::int,1)))::int AS stage1,
         count(*) FILTER (WHERE COALESCE((payload->>'enrichmentStage')::int,1)>=2 AND NOT (COALESCE((payload->'candidate'->>'enrichmentStage')::int,0) >= COALESCE((payload->>'enrichmentStage')::int,1)))::int AS stage2
       FROM jobs WHERE type='ENRICH_CHANNEL' AND status='PENDING' AND run_after<=now()`,
    ),
    db.query(
      `SELECT allocation,COALESCE(SUM(units),0)::int AS units
         FROM quota_reservations WHERE status='CONSUMED' AND reserved_at>=now()-interval '7 days' GROUP BY allocation`,
    ),
    db.query(
      `SELECT count(*)::int AS count FROM provider_call_events
        WHERE occurred_at>=now()-interval '15 minutes' AND provider IN('gemini','groq') AND status IN('RATE_LIMITED','TRANSIENT_ERROR')`,
    ),
    db.query(
      `SELECT count(*)::int AS count FROM youtube_key_quota_usage
        WHERE quota_day=(SELECT last_reset FROM quota_tracker WHERE id='youtube') AND units_used>=9000`,
    ),
    db.query(`SELECT count(*)::int AS count FROM channels WHERE trading_status='UNCERTAIN' AND scan_status='COMPLETED'`),
  ]);
  const jobsByStatus = countMap(enrichmentJobs.rows);
  const reviewsByState = countMap(reviewStates.rows);
  const recentByAllocation = new Map(recentConsumption.rows.map(row => [String(row.allocation), Number(row.units) || 0]));
  const quota = quotaRow.rows[0] || { units_used: 0, daily_limit: 0 };
  const dueStage1 = Number(dueStage.rows[0]?.stage1 || 0);
  const dueStage2 = Number(dueStage.rows[0]?.stage2 || 0);
  const protection = calculateEnrichmentQuotaReserve({
    dailyBudget: Number(quota.daily_limit) || 0,
    actualUsed: Number(quota.units_used) || 0,
    reservedTotal: 0,
    dueStage1,
    dueStage2,
    recentAutonomousUnits: recentByAllocation.get('AUTONOMOUS') || 0,
    recentEnrichmentUnits: recentByAllocation.get('ENRICHMENT') || 0,
  });
  const oldestDueHours = Math.max(0, ...enrichmentJobs.rows.map(row => Number(row.oldest_due_hours) || 0));
  const channelTrading = countMap(channelStatus.rows);
  const channelScan = countMap(scanStatus.rows);
  const totalChannels = Object.values(channelTrading).reduce((sum, value) => sum + value, 0);
  const semanticUsed = Number(
    (await db.query(`SELECT count(*)::int AS count FROM (SELECT DISTINCT ON (channel_id) decision FROM production_classification_diagnostics ORDER BY channel_id,created_at DESC,id DESC) latest WHERE latest.decision->'deterministicRouting'->>'semanticUsed'='true'`)).rows[0]?.count || 0,
  );
  const semanticAttempted = Number(
    (await db.query(`SELECT count(*)::int AS count FROM (SELECT DISTINCT ON (channel_id) decision FROM production_classification_diagnostics ORDER BY channel_id,created_at DESC,id DESC) latest WHERE latest.decision->'deterministicRouting'->>'semanticAttempted'='true'`)).rows[0]?.count || 0,
  );
  const recognitionRows = await db.query(
    `SELECT COALESCE(latest.decision->>'recognitionState',latest.decision->'recognition'->>'state','UNKNOWN') AS key,count(*)::int AS count
       FROM (SELECT DISTINCT ON (channel_id) decision FROM production_classification_diagnostics ORDER BY channel_id,created_at DESC,id DESC) latest GROUP BY 1`,
  );
  const byRoute = countMap(routes.rows);
  const unresolvedCompleted = Number(unresolvedCompletedRows.rows[0]?.count || 0);
  const pendingReviews = Number(reviewsByState.PENDING || 0);
  const oldestReviewDays = Math.max(0, ...reviewStates.rows.map(row => Number(row.oldest_days) || 0));
  const alerts = buildResolutionAlerts({
    dueEnrichment: Number(jobsByStatus.PENDING || 0),
    oldestDueHours,
    orphanPending: Number(orphanPending.rows[0]?.count || 0),
    genericFailures: Number(genericFailures.rows[0]?.count || 0),
    unresolvedCompleted,
    eligibleWithoutPendingReview: Number(eligibleWithoutPending.rows[0]?.count || 0),
    pendingReviews,
    oldestReviewDays,
    semanticRateLimitCalls15m: Number(recentProviderCalls.rows[0]?.count || 0),
    youtubeKeysAtCap: Number(keysAtCap.rows[0]?.count || 0),
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
      due: Number(dueStage.rows[0]?.total || 0),
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
      byRecognition: countMap(recognitionRows.rows),
      semanticUsed,
      semanticAttempted,
      unclassified: Number(byRoute.UNROUTED || 0),
    },
    quota: {
      dailyLimit: Number(quota.daily_limit) || 0,
      used: Number(quota.units_used) || 0,
      remaining: protection.remainingUnits,
      dueStage1,
      dueStage2,
      reserveUnits: protection.reserveUnits,
      protectedShare: protection.protectedShare,
      discoveryAvailable: protection.discoveryAvailableUnits,
      recentAutonomousUnits: recentByAllocation.get('AUTONOMOUS') || 0,
      recentEnrichmentUnits: recentByAllocation.get('ENRICHMENT') || 0,
    },
    alerts,
  };
}
