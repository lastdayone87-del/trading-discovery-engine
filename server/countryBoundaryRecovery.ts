import { getAllChannels, getExcludedCountries, getDb, enqueueJob, upsertChannel, getChannelById } from './db';
import { canonicalCountry, inferChannelCountry } from './countryInference';
import { creatorLevelCountryEvidence } from './countryValidator';
import type { ChannelRecord } from '../src/types';

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
 */
export function isNonExcludedBoundaryCandidate(channel: ChannelRecord, excludedCountries: Array<{ country_name: string }>): boolean {
  const excluded = new Set(excludedCountries.map(item => canonicalCountry(item.country_name).toLocaleLowerCase('en')));
  const isStoredCountryExcluded = excluded.has(canonicalCountry(channel.country || '').toLocaleLowerCase('en'));

  // A candidate must be currently REJECTED or carry a recorded target boundary rejection in its trail.
  // Crucially, if the stored country is currently in excluded_countries, it is NOT an automatic candidate
  // unless we explicitly re-evaluate creator evidence.
  return (channel.country_status === 'REJECTED' || hasPinnedBoundaryRejection(channel))
    && !isStoredCountryExcluded;
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
  excludedCountries: Array<{ country_name: string }>
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

  // Re-evaluate creator-level evidence explicitly excluding discovery search target location tag
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

  const inference = inferChannelCountry(creatorEvidence, excludedCountries);

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

async function loadCohort(): Promise<CohortRow[]> {
  const [channels, excludedCountries] = await Promise.all([getAllChannels(), getExcludedCountries()]);
  return channels
    .filter(channel => isNonExcludedBoundaryCandidate(channel, excludedCountries))
    .map(channel => {
      const reconciliation = classifyReconciliationState(channel, excludedCountries);
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
  const channel = await getChannelById(channelId);
  if (!channel) return { channelId, recovered: false, reconciliationState: 'INSUFFICIENT_EVIDENCE', newCountryStatus: 'MISSING' };

  const [excludedCountries, db] = await Promise.all([getExcludedCountries(), getDb()]);
  const now = new Date().toISOString();
  const eventKey = `recovery:${COUNTRY_BOUNDARY_RECOVERY_VERSION}:${channelId}`;

  // Idempotency check: if this recovery event was already committed, do not mutate state again
  const priorEvent = await db.query('SELECT 1 FROM historical_country_boundary_recovery_events WHERE event_key=$1', [eventKey]);
  if (priorEvent.rowCount) {
    return { channelId, recovered: channel.country_status !== 'REJECTED', reconciliationState: 'RECOVERABLE_NON_EXCLUDED', newCountryStatus: channel.country_status };
  }

  const classification = classifyReconciliationState(channel, excludedCountries);

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
      'SELECT 1 FROM historical_country_boundary_recovery_events WHERE event_key=$1 FOR UPDATE',
      [eventKey]
    );
    if (lockCheck.rowCount) {
      await client.query('ROLLBACK');
      return { channelId, recovered: true, reconciliationState: classification.state, newCountryStatus: channel.country_status };
    }

    await client.query(
      `UPDATE channels SET country_status=$1, country=$2, confidence_score=$3, scan_status=$4, last_checked=$5, inspection_trail=$6 WHERE channel_id=$7`,
      [channel.country_status, channel.country, channel.confidence_score, channel.scan_status, channel.last_checked, JSON.stringify(channel.inspection_trail), channelId]
    );

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
