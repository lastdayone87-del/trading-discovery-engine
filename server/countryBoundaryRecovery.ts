import { getAllChannels, getExcludedCountries, getCountryVocabularies, getDb, enqueueJob, upsertChannel, getChannelById } from './db';
import { canonicalCountry, inferChannelCountry } from './countryInference';
import { creatorLevelCountryEvidence } from './countryValidator';
import type { ChannelRecord, CountryVocabulary } from '../src/types';

export const COUNTRY_BOUNDARY_RECOVERY_VERSION = 'country-boundary-nonexcluded-v3';
export const COUNTRY_BOUNDARY_RECOVERY_JOB = 'COUNTRY_BOUNDARY_REPROCESS';

export type ReconciliationState =
  | 'RECOVERABLE_NON_EXCLUDED'
  | 'RETAIN_EXCLUDED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'LEGITIMATE_REJECTION';

const DISCORD_INSPECTION_STEPS = /BIO|EXTERNAL[_ ]LINKS|VIDEO[_ ]DESCRIPTIONS|CUSTOM[_ ]DOMAINS|SOCIAL[_ ]BIO|LINKED[_ ]WEBSITES|CHANNEL[_ ]LINKS|DISCORD/i;

function trailText(channel: ChannelRecord): string {
  return (channel.inspection_trail || []).map(step => `${step.step || ''}\n${step.details || ''}`).join('\n');
}

export function hasDiscordInspectionStep(channel: ChannelRecord): boolean {
  return (channel.inspection_trail || []).some(step => DISCORD_INSPECTION_STEPS.test(step.step || ''));
}

export function hasPinnedBoundaryRejection(channel: ChannelRecord): boolean {
  return /Target Country Boundary: REJECTED/i.test(trailText(channel));
}

/**
 * Generic predicate identifying candidates for historical country boundary reconciliation.
 * Inspects channels whose country_status = 'REJECTED' or whose trail records target boundary rejection.
 * Candidates are loaded unconditionally for re-evaluation without pre-filtering against excluded_countries,
 * allowing classifyReconciliationState to evaluate active exclusion policy dynamically.
 */
export function isNonExcludedBoundaryCandidate(channel: ChannelRecord, _excludedCountries?: Array<{ country_name: string }>): boolean {
  return channel.country_status === 'REJECTED' || hasPinnedBoundaryRejection(channel);
}

/**
 * Evaluates the authoritative creator-country evidence for a channel record against current policy.
 * Returns one of 4 explicit classification states:
 * - RECOVERABLE_NON_EXCLUDED: Re-evaluation produced a confirmed/likely non-excluded creator country.
 * - RETAIN_EXCLUDED: Re-evaluation produced a genuinely excluded creator country.
 * - INSUFFICIENT_EVIDENCE: No creator-level country evidence exists to resolve the boundary.
 * - LEGITIMATE_REJECTION: The rejection was not a false target boundary mismatch (e.g. explicitly rejected by policy).
 */
export function classifyReconciliationState(
  channel: ChannelRecord,
  excludedCountries: Array<{ country_name: string; reason?: string }>,
  vocabularies: CountryVocabulary[] = []
): {
  state: ReconciliationState;
  detectedCountry: string | null;
  reasoning: string;
  confidence: number;
} {
  const hasBoundaryRejection = hasPinnedBoundaryRejection(channel);
  if (!hasBoundaryRejection && channel.country_status === 'REJECTED') {
    return {
      state: 'LEGITIMATE_REJECTION',
      detectedCountry: channel.country || null,
      reasoning: 'Channel was rejected by policy or explicit country match, not target boundary mismatch.',
      confidence: 100
    };
  }

  // Re-evaluate creator-level evidence using standard production extraction path.
  // Explicitly exclude channel.country location tag to prevent search target contamination.
  const creatorEvidence = creatorLevelCountryEvidence({
    channelName: channel.channel_name,
    description: (channel.inspection_trail || [])
      .filter(t => t.step !== 'COUNTRY_VALIDATION')
      .map(t => t.details || '')
      .join(' ') || channel.channel_name,
    videoTitles: [channel.channel_name],
    externalLinks: channel.discord_invite ? [channel.discord_invite] : [],
    metadataStatus: channel.country_metadata_status
  });

  const formattedExclusions = excludedCountries.map(e => ({ country_name: e.country_name, reason: e.reason || 'Excluded by policy' }));
  const inference = inferChannelCountry(creatorEvidence, formattedExclusions, vocabularies);

  if (inference.status === 'REJECTED') {
    return {
      state: 'RETAIN_EXCLUDED',
      detectedCountry: inference.detectedCountry,
      reasoning: inference.reasoning,
      confidence: inference.confidence
    };
  }

  if (inference.status === 'UNCERTAIN' || !inference.detectedCountry) {
    return {
      state: 'INSUFFICIENT_EVIDENCE',
      detectedCountry: inference.detectedCountry || null,
      reasoning: 'Insufficient creator-level evidence to resolve creator country safely without discovery target assumption.',
      confidence: inference.confidence
    };
  }

  return {
    state: 'RECOVERABLE_NON_EXCLUDED',
    detectedCountry: inference.detectedCountry,
    reasoning: `Creator country '${inference.detectedCountry}' confirmed by creator-level evidence and is not in excluded_countries.`,
    confidence: inference.confidence
  };
}

export function countryBoundaryRecoveryKey(channelId: string): string {
  return `country-boundary-reprocess:${COUNTRY_BOUNDARY_RECOVERY_VERSION}:${channelId}`;
}

/** Reconstruct the durable classification recorded by a prior recovery event. */
export function reconciliationStateFromRecoveryEvent(event: {
  restored_country_status?: string | null;
  evidence_details?: string | null;
}): ReconciliationState {
  const details = String(event.evidence_details || '');
  if (/RETAIN_EXCLUDED/.test(details)) return 'RETAIN_EXCLUDED';
  if (/LEGITIMATE_REJECTION/.test(details)) return 'LEGITIMATE_REJECTION';
  if (/INSUFFICIENT_EVIDENCE/.test(details)) return 'INSUFFICIENT_EVIDENCE';
  if (event.restored_country_status && event.restored_country_status !== 'REJECTED') {
    return 'RECOVERABLE_NON_EXCLUDED';
  }
  return 'INSUFFICIENT_EVIDENCE';
}

type CohortRow = ChannelRecord & {
  executionEligible: boolean;
  reconciliation: ReturnType<typeof classifyReconciliationState>;
};

export type CountryBoundaryDryRun = {
  version: string;
  rule: string;
  totalCandidates: number;
  recoverableNonExcludedCount: number;
  retainExcludedCount: number;
  insufficientEvidenceCount: number;
  legitimateRejectionCount: number;
  skippedHumanRejected: number;
  representativeExamples: Record<ReconciliationState, Array<{ channelId: string; channelName: string; detectedCountry: string | null; reasoning: string }>>;
  byCountry: Array<{ country: string; count: number }>;
};

export async function loadCohort(): Promise<CohortRow[]> {
  const [channels, excludedCountries, vocabularies, db] = await Promise.all([
    getAllChannels(),
    getExcludedCountries(),
    getCountryVocabularies(),
    getDb().catch(() => null)
  ]);

  const allMap = new Map<string, ChannelRecord>();

  // 1. Load candidates from channels table
  for (const channel of channels) {
    if (isNonExcludedBoundaryCandidate(channel, excludedCountries)) {
      allMap.set(channel.channel_id, channel);
    }
  }

  // 2. Discover historical channel_sightings with COUNTRY_REJECTED funnel_outcome or country_outcome,
  // including cases where channel.country_status was transient or where channels row is missing
  if (db) {
    try {
      const sightingsRes = await db.query(`
        SELECT DISTINCT ON (s.channel_id)
          s.channel_id,
          COALESCE(c.channel_name, s.metadata->>'channelName', s.channel_id) AS channel_name,
          COALESCE(c.youtube_url, 'https://youtube.com/channel/' || s.channel_id) AS youtube_url,
          COALESCE(c.country, s.metadata->>'country', 'UNKNOWN') AS country,
          COALESCE(c.country_status, 'REJECTED') AS country_status,
          COALESCE(c.confidence_score, 0) AS confidence_score,
          COALESCE(c.discord_status, 'NOT_FOUND') AS discord_status,
          c.discord_invite,
          COALESCE(c.scan_status, 'COMPLETED') AS scan_status,
          COALESCE(c.scan_attempts, 0) AS scan_attempts,
          COALESCE(c.discovery_source, (s.metadata->>'source')::text, 'recovery') AS discovery_source,
          COALESCE(c.first_seen, s.observed_at::text, now()::text) AS first_seen,
          COALESCE(c.last_checked, s.observed_at::text, now()::text) AS last_checked,
          COALESCE(c.inspection_trail, jsonb_build_array(jsonb_build_object(
            'step', 'COUNTRY_VALIDATION',
            'title', 'Historical Sighting Boundary Rejection',
            'status', 'REJECTED',
            'details', 'Target Country Boundary: REJECTED — historical sighting recorded country_outcome REJECTED',
            'timestamp', s.observed_at
          ))) AS inspection_trail,
          c.subscriber_count,
          c.channel_thumbnail_url,
          COALESCE(c.trading_status, 'UNCERTAIN') AS trading_status
        FROM channel_sightings s
        LEFT JOIN channels c ON c.channel_id = s.channel_id
        WHERE s.country_outcome = 'REJECTED' OR s.funnel_outcome = 'COUNTRY_REJECTED'
      `);
      for (const row of sightingsRes.rows) {
        const item: ChannelRecord = {
          ...row,
          inspection_trail: typeof row.inspection_trail === 'string' ? JSON.parse(row.inspection_trail) : row.inspection_trail
        };
        if (!allMap.has(item.channel_id) && isNonExcludedBoundaryCandidate(item, excludedCountries)) {
          allMap.set(item.channel_id, item);
        }
      }
    } catch {
      // Ignore database query errors in non-postgres test environments
    }
  }

  const combined = [...allMap.values()];
  return combined.map(channel => {
    const reconciliation = classifyReconciliationState(channel, excludedCountries, vocabularies);
    return {
      ...channel,
      reconciliation,
      executionEligible: channel.trading_status !== 'HUMAN_REJECTED' && reconciliation.state === 'RECOVERABLE_NON_EXCLUDED'
    };
  });
}

function aggregateCohort(rows: CohortRow[]): CountryBoundaryDryRun {
  const examples: Record<ReconciliationState, Array<{ channelId: string; channelName: string; detectedCountry: string | null; reasoning: string }>> = {
    RECOVERABLE_NON_EXCLUDED: [],
    RETAIN_EXCLUDED: [],
    INSUFFICIENT_EVIDENCE: [],
    LEGITIMATE_REJECTION: []
  };

  const counts: Record<ReconciliationState, number> = {
    RECOVERABLE_NON_EXCLUDED: 0,
    RETAIN_EXCLUDED: 0,
    INSUFFICIENT_EVIDENCE: 0,
    LEGITIMATE_REJECTION: 0
  };

  const countryCounts = new Map<string, number>();

  for (const row of rows) {
    const state = row.reconciliation.state;
    counts[state]++;
    if (examples[state].length < 3) {
      examples[state].push({
        channelId: row.channel_id,
        channelName: row.channel_name,
        detectedCountry: row.reconciliation.detectedCountry,
        reasoning: row.reconciliation.reasoning
      });
    }
    const country = canonicalCountry(row.reconciliation.detectedCountry || row.country || 'UNKNOWN');
    countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
  }

  return {
    version: COUNTRY_BOUNDARY_RECOVERY_VERSION,
    rule: 'Evidence-bound classification of historical false target-boundary rejections',
    totalCandidates: rows.length,
    recoverableNonExcludedCount: counts.RECOVERABLE_NON_EXCLUDED,
    retainExcludedCount: counts.RETAIN_EXCLUDED,
    insufficientEvidenceCount: counts.INSUFFICIENT_EVIDENCE,
    legitimateRejectionCount: counts.LEGITIMATE_REJECTION,
    skippedHumanRejected: rows.filter(row => row.trading_status === 'HUMAN_REJECTED').length,
    representativeExamples: examples,
    byCountry: [...countryCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([country, count]) => ({ country, count }))
  };
}

export async function dryRunCountryBoundaryCohort(): Promise<CountryBoundaryDryRun> {
  return aggregateCohort(await loadCohort());
}

export async function enqueueCountryBoundaryCohort(): Promise<CountryBoundaryDryRun & { enqueuedCount: number; alreadyPresentCount: number }> {
  const rows = await loadCohort();
  let enqueuedCount = 0;
  let alreadyPresentCount = 0;
  for (const row of rows) {
    if (!row.executionEligible) continue;
    const key = countryBoundaryRecoveryKey(row.channel_id);
    const existing = await (await getDb()).query('SELECT 1 FROM jobs WHERE idempotency_key=$1', [key]);
    await enqueueJob(COUNTRY_BOUNDARY_RECOVERY_JOB, {
      channelId: row.channel_id,
      correctionVersion: COUNTRY_BOUNDARY_RECOVERY_VERSION,
      source: 'COUNTRY_BOUNDARY_RECONSIDERATION'
    }, { idempotencyKey: key, priority: 10, maxAttempts: 4, preventReopen: true });
    if (existing.rowCount) alreadyPresentCount += 1;
    else enqueuedCount += 1;
  }
  return { ...aggregateCohort(rows), enqueuedCount, alreadyPresentCount };
}

/**
 * Generic, idempotent worker task that processes a single channel recovery job.
 * Evaluates creator-level evidence and updates state + audit ledger atomically.
 */
export async function processCountryBoundaryReprocessJob(
  job: { payload: { channelId: string } }
): Promise<{ channelId: string; recovered: boolean; reconciliationState: ReconciliationState; newCountryStatus: string }> {
  const channelId = String(job.payload.channelId || '');
  let channel = await getChannelById(channelId);

  const [excludedCountries, vocabularies, db] = await Promise.all([
    getExcludedCountries(),
    getCountryVocabularies(),
    getDb()
  ]);

  // If no channel record exists in `channels` table, check `channel_sightings` for historical sighting evidence
  let isSightingOnlyCandidate = false;
  if (!channel && db) {
    const sightingRes = await db.query(`
      SELECT DISTINCT ON (s.channel_id)
        s.channel_id,
        COALESCE(s.metadata->>'channelName', s.channel_id) AS channel_name,
        'https://youtube.com/channel/' || s.channel_id AS youtube_url,
        COALESCE(s.metadata->>'country', 'UNKNOWN') AS country,
        'REJECTED' AS country_status,
        0 AS confidence_score,
        'NOT_FOUND' AS discord_status,
        NULL AS discord_invite,
        'COMPLETED' AS scan_status,
        0 AS scan_attempts,
        COALESCE((s.metadata->>'source')::text, 'recovery') AS discovery_source,
        s.observed_at::text AS first_seen,
        s.observed_at::text AS last_checked,
        jsonb_build_array(jsonb_build_object(
          'step', 'COUNTRY_VALIDATION',
          'title', 'Historical Sighting Boundary Rejection',
          'status', 'REJECTED',
          'details', 'Target Country Boundary: REJECTED — historical sighting recorded country_outcome REJECTED',
          'timestamp', s.observed_at
        )) AS inspection_trail,
        'UNCERTAIN' AS trading_status
      FROM channel_sightings s
      WHERE s.channel_id = $1 AND (s.country_outcome = 'REJECTED' OR s.funnel_outcome = 'COUNTRY_REJECTED')
      ORDER BY s.channel_id, s.observed_at DESC
    `, [channelId]);

    if (sightingRes.rowCount) {
      const row = sightingRes.rows[0];
      channel = {
        ...row,
        inspection_trail: typeof row.inspection_trail === 'string' ? JSON.parse(row.inspection_trail) : row.inspection_trail
      };
      isSightingOnlyCandidate = true;
    }
  }

  if (!channel) return { channelId, recovered: false, reconciliationState: 'INSUFFICIENT_EVIDENCE', newCountryStatus: 'MISSING' };

  const now = new Date().toISOString();
  const eventKey = `recovery:${COUNTRY_BOUNDARY_RECOVERY_VERSION}:${channelId}`;

  // Idempotency check: do not mutate again, but return the durable prior classification.
  const priorEvent = await db.query(
    'SELECT restored_country_status, evidence_details FROM historical_country_boundary_recovery_events WHERE event_key=$1',
    [eventKey]
  );
  if (priorEvent.rowCount) {
    const reconciliationState = reconciliationStateFromRecoveryEvent(priorEvent.rows[0]);
    return {
      channelId,
      recovered: reconciliationState === 'RECOVERABLE_NON_EXCLUDED',
      reconciliationState,
      newCountryStatus: channel.country_status
    };
  }

  const classification = classifyReconciliationState(channel, excludedCountries, vocabularies);

  if (classification.state === 'RETAIN_EXCLUDED' || classification.state === 'LEGITIMATE_REJECTION') {
    // Record auditable retention event for retained rejections
    await db.query(
      `INSERT INTO historical_country_boundary_recovery_events(
        event_key, channel_id, prior_country_status, restored_country_status,
        prior_scan_status, resulting_scan_status, evidence_details, policy_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_key) DO NOTHING`,
      [
        eventKey,
        channelId,
        'REJECTED',
        'REJECTED',
        channel.scan_status,
        channel.scan_status,
        `Retained as REJECTED (${classification.state}): ${classification.reasoning}`,
        COUNTRY_BOUNDARY_RECOVERY_VERSION
      ]
    );
    return { channelId, recovered: false, reconciliationState: classification.state, newCountryStatus: 'REJECTED' };
  }

  if (classification.state === 'INSUFFICIENT_EVIDENCE') {
    // Insufficient creator evidence: do NOT guess and do NOT recover. Leave channel untouched as unresolved.
    await db.query(
      `INSERT INTO historical_country_boundary_recovery_events(
        event_key, channel_id, prior_country_status, restored_country_status,
        prior_scan_status, resulting_scan_status, evidence_details, policy_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_key) DO NOTHING`,
      [
        eventKey,
        channelId,
        channel.country_status,
        channel.country_status,
        channel.scan_status,
        channel.scan_status,
        `Untouched (${classification.state}): ${classification.reasoning}`,
        COUNTRY_BOUNDARY_RECOVERY_VERSION
      ]
    );
    return { channelId, recovered: false, reconciliationState: classification.state, newCountryStatus: channel.country_status };
  }

  // RECOVERABLE_NON_EXCLUDED: Restore machine-owned state safely
  const priorCountryStatus = channel.country_status;
  const priorScanStatus = channel.scan_status;
  channel.country_status = 'CONFIRMED';
  channel.confidence_score = classification.confidence;
  if (classification.detectedCountry) {
    channel.country = classification.detectedCountry;
  }
  channel.scan_status = 'PENDING';
  channel.last_checked = now;
  channel.inspection_trail = [
    ...(channel.inspection_trail || []),
    {
      step: 'COUNTRY_VALIDATION',
      title: 'Historical Country Boundary Reconciliation',
      status: 'FOUND',
      details: `Reconciled stale target-country boundary rejection under policy ${COUNTRY_BOUNDARY_RECOVERY_VERSION}. ${classification.reasoning}`,
      timestamp: now
    }
  ];

  // Perform atomic transaction for state transition & recovery event ledger
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock recovery event row if existing to guarantee idempotency across workers
    const lockCheck = await client.query(
      'SELECT restored_country_status, evidence_details FROM historical_country_boundary_recovery_events WHERE event_key=$1 FOR UPDATE',
      [eventKey]
    );
    if (lockCheck.rowCount) {
      const reconciliationState = reconciliationStateFromRecoveryEvent(lockCheck.rows[0]);
      await client.query('ROLLBACK');
      return {
        channelId,
        recovered: reconciliationState === 'RECOVERABLE_NON_EXCLUDED',
        reconciliationState,
        newCountryStatus: channel.country_status
      };
    }

    if (isSightingOnlyCandidate) {
      // Materialize sighting-only candidate into channels table safely
      await client.query(
        `INSERT INTO channels (
          channel_id, channel_name, youtube_url, country, country_status, confidence_score,
          discord_status, scan_status, scan_attempts, discovery_source, first_seen, last_checked,
          inspection_trail, trading_status, country_metadata_status, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
        ON CONFLICT (channel_id) DO UPDATE SET
          country_status=excluded.country_status, country=excluded.country, confidence_score=excluded.confidence_score,
          scan_status=excluded.scan_status, last_checked=excluded.last_checked, inspection_trail=excluded.inspection_trail, updated_at=now()`,
        [
          channel.channel_id, channel.channel_name, channel.youtube_url, channel.country, channel.country_status,
          channel.confidence_score, channel.discord_status, channel.scan_status, channel.scan_attempts,
          channel.discovery_source, channel.first_seen, channel.last_checked, JSON.stringify(channel.inspection_trail),
          channel.trading_status, 'NOT_REQUESTED'
        ]
      );
    } else {
      await client.query(
        `UPDATE channels SET country_status=$1, country=$2, confidence_score=$3, scan_status=$4, last_checked=$5, inspection_trail=$6 WHERE channel_id=$7`,
        [channel.country_status, channel.country, channel.confidence_score, channel.scan_status, channel.last_checked, JSON.stringify(channel.inspection_trail), channelId]
      );
    }

    await client.query(
      `INSERT INTO historical_country_boundary_recovery_events(
        event_key, channel_id, prior_country_status, restored_country_status,
        prior_scan_status, resulting_scan_status, evidence_details, policy_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_key) DO NOTHING`,
      [
        eventKey,
        channelId,
        priorCountryStatus,
        channel.country_status,
        priorScanStatus,
        'PENDING',
        classification.reasoning,
        COUNTRY_BOUNDARY_RECOVERY_VERSION
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return { channelId, recovered: true, reconciliationState: classification.state, newCountryStatus: channel.country_status };
}
