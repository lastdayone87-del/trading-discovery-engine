import { getAllChannels, getExcludedCountries, getDb, enqueueJob, upsertChannel, getChannelById } from './db';
import { canonicalCountry, inferChannelCountry } from './countryInference';
import { validateChannelCountry, creatorLevelCountryEvidence } from './countryValidator';
import type { ChannelRecord } from '../src/types';

export const COUNTRY_BOUNDARY_RECOVERY_VERSION = 'country-boundary-nonexcluded-v2';
export const COUNTRY_BOUNDARY_RECOVERY_JOB = 'COUNTRY_BOUNDARY_REPROCESS';

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
 * Generic predicate identifying channels rejected under the legacy target-country boundary bug.
 * A channel is a recovery candidate if:
 * 1. Its country_status is currently 'REJECTED'.
 * 2. Its stored country (or detected country) is NOT in the current excluded_countries list.
 * 3. It was rejected by the target-country boundary rule (recorded in inspection_trail).
 */
export function isNonExcludedBoundaryCandidate(channel: ChannelRecord, excludedCountries: Array<{ country_name: string }>): boolean {
  const excluded = new Set(excludedCountries.map(item => canonicalCountry(item.country_name).toLocaleLowerCase('en')));
  return channel.country_status === 'REJECTED'
    && !excluded.has(canonicalCountry(channel.country || '').toLocaleLowerCase('en'))
    && hasPinnedBoundaryRejection(channel);
}

export function countryBoundaryRecoveryKey(channelId: string): string {
  return `country-boundary-reprocess:${COUNTRY_BOUNDARY_RECOVERY_VERSION}:${channelId}`;
}

type CohortRow = ChannelRecord & { executionEligible: boolean };

export type CountryBoundaryDryRun = {
  version: string;
  rule: string;
  candidateCount: number;
  executionEligibleCount: number;
  skippedHumanRejected: number;
  byDiscordState: Array<{ discordStatus: string; validationStatus: string; scanStatus: string; tradingStatus: string; count: number }>;
  byCountry: Array<{ country: string; count: number }>;
};

async function loadCohort(): Promise<CohortRow[]> {
  const [channels, excludedCountries] = await Promise.all([getAllChannels(), getExcludedCountries()]);
  return channels
    .filter(channel => isNonExcludedBoundaryCandidate(channel, excludedCountries))
    .map(channel => ({ ...channel, executionEligible: channel.trading_status !== 'HUMAN_REJECTED' }));
}

function aggregateCohort(rows: CohortRow[]): CountryBoundaryDryRun {
  const group = <T>(values: T[], key: (value: T) => string) => {
    const counts = new Map<string, number>();
    values.forEach(value => counts.set(key(value), (counts.get(key(value)) || 0) + 1));
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, count]) => ({ value, count }));
  };
  const byState = group(rows, row => [row.discord_status, row.discord_validation_status, row.scan_status, row.trading_status].join('\u0000'))
    .map(item => {
      const [discordStatus, validationStatus, scanStatus, tradingStatus] = item.value.split('\u0000');
      return { discordStatus, validationStatus, scanStatus, tradingStatus, count: item.count };
    });
  return {
    version: COUNTRY_BOUNDARY_RECOVERY_VERSION,
    rule: 'country_status=REJECTED; final country not excluded; pinned boundary rejection; no Discord inspection step',
    candidateCount: rows.length,
    executionEligibleCount: rows.filter(row => row.executionEligible).length,
    skippedHumanRejected: rows.filter(row => !row.executionEligible).length,
    byDiscordState: byState,
    byCountry: group(rows, row => canonicalCountry(row.country || 'UNKNOWN')).map(item => ({ country: item.value, count: item.count }))
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
 * Re-evaluates country validation using current excluded_countries policy.
 */
export async function processCountryBoundaryReprocessJob(job: { payload: { channelId: string } }): Promise<{ channelId: string; recovered: boolean; newCountryStatus: string }> {
  const channelId = String(job.payload.channelId || '');
  const channel = await getChannelById(channelId);
  if (!channel) return { channelId, recovered: false, newCountryStatus: 'MISSING' };

  const [excludedCountries] = await Promise.all([getExcludedCountries()]);
  const now = new Date().toISOString();

  // Re-evaluate country validation against current policy
  const valRes = await validateChannelCountry(
    {
      channelName: channel.channel_name,
      description: channel.inspection_trail?.map(t => t.details || '').join(' ') || channel.channel_name,
      videoTitles: [channel.channel_name],
      locationTag: channel.country,
      externalLinks: channel.discord_invite ? [channel.discord_invite] : []
    },
    channel.country
  );

  if (valRes.status === 'REJECTED') {
    // Creator country IS genuinely excluded under current policy. Retain rejection.
    return { channelId, recovered: false, newCountryStatus: 'REJECTED' };
  }

  // Creator country is NOT excluded. Clear stale rejection and restore machine-owned state.
  channel.country_status = valRes.status === 'CONFIRMED' ? 'CONFIRMED' : 'UNCERTAIN';
  channel.confidence_score = valRes.score;
  channel.scan_status = 'PENDING';
  channel.last_checked = now;
  channel.inspection_trail = [
    ...(channel.inspection_trail || []),
    {
      step: 'COUNTRY_VALIDATION',
      title: 'Historical Country Boundary Reconciliation',
      status: 'FOUND',
      details: `Reconciled stale target-country boundary rejection under policy ${COUNTRY_BOUNDARY_RECOVERY_VERSION}. Detected country '${valRes.detectedCountry || channel.country}' is not excluded. Restored to normal processing.`,
      timestamp: now
    }
  ];

  await upsertChannel(channel);

  // Record auditable recovery event
  const db = await getDb();
  await db.query(
    `INSERT INTO historical_country_boundary_recovery_events(
      event_key, channel_id, prior_country_status, restored_country_status,
      prior_scan_status, resulting_scan_status, evidence_details, policy_version
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (event_key) DO NOTHING`,
    [
      `recovery:${COUNTRY_BOUNDARY_RECOVERY_VERSION}:${channelId}`,
      channelId,
      'REJECTED',
      channel.country_status,
      'COMPLETED',
      'PENDING',
      valRes.decisionLogs,
      COUNTRY_BOUNDARY_RECOVERY_VERSION
    ]
  );

  return { channelId, recovered: true, newCountryStatus: channel.country_status };
}
