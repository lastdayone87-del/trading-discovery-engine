/**
 * One-time release of legacy INTAKE_DEFERRED rows into normal enrichment.
 *
 * The trading-focus intake gate is being removed. Existing rows must not wait
 * for rediscovery. This script is bounded, idempotent, and defaults to a
 * dry-run.
 *
 * Usage:
 *   npx tsx scripts/releaseIntakeDeferredChannels.ts                 # dry-run
 *   npx tsx scripts/releaseIntakeDeferredChannels.ts --apply         # release
 *   npx tsx scripts/releaseIntakeDeferredChannels.ts --limit=50      # bound batch
 *   npx tsx scripts/releaseIntakeDeferredChannels.ts --country=India
 */
import { getDb, enqueueJob } from '../server/db';
import { findCountryExclusion } from '../server/countryExclusion';

export type ReleaseDisposition = 'RELEASE' | 'EXCLUDED' | 'REVIEW' | 'SKIP';

export interface DeferredChannelRow {
  channel_id: string;
  channel_name: string;
  youtube_url: string;
  country: string | null;
  country_status: string | null;
  scan_status: string;
  trading_status: string | null;
  inspection_trail: unknown;
  enrich_payload?: Record<string, any> | null;
  nomination_raw_observation?: Record<string, any> | null;
  nomination_matched_document?: Record<string, any> | null;
  nomination_country?: string | null;
  nomination_source_type?: string | null;
  nomination_language?: string | null;
}

export interface ReleaseCandidate {
  channelId: string;
  channelName: string;
  youtubeUrl: string;
  description: string;
  videoTitles: string[];
  videoDescriptions: string[];
  matchedDocument?: Record<string, unknown>;
  channelLinks: string[];
  subscriberCount?: number;
  locationTag?: string;
}

export interface ReleasePlan {
  disposition: ReleaseDisposition;
  reason: string;
  candidate: ReleaseCandidate;
  targetCountry: string;
  source: string;
  evidenceSource: 'JOB' | 'NOMINATION' | 'CHANNEL_ROW';
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item || '').trim()).filter(Boolean)
    : [];
}

export function releaseIdempotencyKey(channelId: string): string {
  return `intake-release:${channelId}:v1`;
}

export function buildReleaseCandidate(row: DeferredChannelRow): ReleasePlan {
  const job = objectValue(row.enrich_payload);
  const jobCandidate = objectValue(job.candidate);
  const nominationRaw = objectValue(row.nomination_raw_observation);
  const nominationDocument = objectValue(row.nomination_matched_document);
  const jobHasCandidate = Object.keys(jobCandidate).length > 0;
  const nominationHasCandidate = Object.keys(nominationRaw).length > 0 || Object.keys(nominationDocument).length > 0;
  const evidenceSource: ReleasePlan['evidenceSource'] = jobHasCandidate
    ? 'JOB'
    : nominationHasCandidate ? 'NOMINATION' : 'CHANNEL_ROW';
  const chosen = jobHasCandidate ? jobCandidate : nominationHasCandidate ? nominationRaw : {};

  const candidate: ReleaseCandidate = {
    channelId: row.channel_id,
    channelName: String(chosen.channelName || row.channel_name || ''),
    youtubeUrl: String(chosen.youtubeUrl || row.youtube_url || ''),
    description: String(chosen.description || ''),
    videoTitles: stringList(chosen.videoTitles),
    videoDescriptions: stringList(chosen.videoDescriptions),
    matchedDocument: Object.keys(objectValue(chosen.matchedDocument)).length
      ? objectValue(chosen.matchedDocument)
      : Object.keys(nominationDocument).length ? nominationDocument : undefined,
    channelLinks: stringList(chosen.channelLinks || chosen.externalLinks),
    subscriberCount: Number.isFinite(Number(chosen.subscriberCount)) ? Number(chosen.subscriberCount) : undefined,
    locationTag: typeof chosen.locationTag === 'string' && chosen.locationTag.trim()
      ? chosen.locationTag.trim()
      : undefined,
  };
  return {
    disposition: 'RELEASE',
    reason: 'ELIGIBLE',
    candidate,
    targetCountry: String(job.targetCountry || row.nomination_country || 'GLOBAL'),
    source: String(job.source || row.nomination_source_type || 'automated_query'),
    evidenceSource,
  };
}

export function classifyDeferredRelease(
  row: DeferredChannelRow,
  exclusions: Array<{ country_name: string; reason: string }>,
): ReleasePlan {
  const plan = buildReleaseCandidate(row);
  if (row.scan_status !== 'INTAKE_DEFERRED') {
    return { ...plan, disposition: 'SKIP', reason: 'NO_LONGER_DEFERRED' };
  }
  if (row.country_status === 'REJECTED') {
    return { ...plan, disposition: 'EXCLUDED', reason: 'STORED_COUNTRY_REJECTED' };
  }
  const exclusion = row.country ? findCountryExclusion(row.country, exclusions as any) : null;
  if (exclusion) {
    if (row.country_status === 'CONFIRMED') {
      return { ...plan, disposition: 'EXCLUDED', reason: `CONFIRMED_EXCLUDED:${exclusion.reason}` };
    }
    return { ...plan, disposition: 'REVIEW', reason: `LIKELY_OR_UNCERTAIN_EXCLUDED:${exclusion.reason}` };
  }
  return plan;
}

interface ReleaseCounts {
  released: number;
  skipped: number;
  excluded: number;
  review: number;
  failed: number;
}

async function loadRows(limit: number, country?: string): Promise<DeferredChannelRow[]> {
  const db = await getDb();
  const res = await db.query(
    `SELECT c.channel_id,c.channel_name,c.youtube_url,c.country,c.country_status,
            c.scan_status,c.trading_status,c.inspection_trail,
            j.payload AS enrich_payload,
            n.raw_observation AS nomination_raw_observation,
            n.matched_document_locator AS nomination_matched_document,
            n.country AS nomination_country,n.source_type AS nomination_source_type,
            n.declared_language AS nomination_language
     FROM channels c
     LEFT JOIN LATERAL (
       SELECT payload FROM jobs
       WHERE type='ENRICH_CHANNEL' AND payload->>'channelId'=c.channel_id
       ORDER BY created_at DESC LIMIT 1
     ) j ON true
     LEFT JOIN LATERAL (
       SELECT raw_observation,matched_document_locator,country,source_type,declared_language
       FROM discovery_nominations
       WHERE channel_id=c.channel_id
       ORDER BY observed_at DESC,id DESC LIMIT 1
     ) n ON true
     WHERE c.scan_status='INTAKE_DEFERRED'
       AND ($2::text IS NULL OR LOWER(c.country)=LOWER($2))
     ORDER BY c.channel_id
     LIMIT $1`,
    [limit, country || null],
  );
  return res.rows as DeferredChannelRow[];
}

async function loadExclusions(): Promise<Array<{ country_name: string; reason: string }>> {
  const db = await getDb();
  const res = await db.query(`SELECT country_name,reason FROM excluded_countries`);
  return res.rows as Array<{ country_name: string; reason: string }>;
}

function report(counts: ReleaseCounts, item: {
  channelId: string;
  disposition: ReleaseDisposition | 'FAILED';
  reason: string;
  evidenceSource?: string;
  error?: string;
}) {
  console.log(JSON.stringify({
    event: 'intake_deferred_release',
    channelId: item.channelId,
    disposition: item.disposition,
    reason: item.reason,
    evidenceSource: item.evidenceSource || null,
    error: item.error || null,
    counts,
    timestamp: new Date().toISOString(),
  }));
}

async function applyRelease(row: DeferredChannelRow, plan: ReleasePlan): Promise<ReleaseDisposition | 'FAILED'> {
  const db = await getDb();
  const client = await db.connect();
  let inTransaction = false;
  try {
    await client.query('BEGIN');
    inTransaction = true;
    const locked = await client.query(
      `SELECT scan_status FROM channels WHERE channel_id=$1 FOR UPDATE`,
      [row.channel_id],
    );
    if (!locked.rowCount || locked.rows[0].scan_status !== 'INTAKE_DEFERRED') {
      await client.query('COMMIT');
      inTransaction = false;
      return 'SKIP';
    }
    const active = await client.query(
      `SELECT 1 FROM jobs
       WHERE type='ENRICH_CHANNEL' AND status IN ('PENDING','PROCESSING')
         AND payload->>'channelId'=$1 LIMIT 1`,
      [row.channel_id],
    );
    if (active.rowCount) {
      await client.query('COMMIT');
      inTransaction = false;
      return 'SKIP';
    }
    const trail = Array.isArray(row.inspection_trail) ? row.inspection_trail : [];
    await client.query(
      `UPDATE channels
       SET scan_status='ENRICHMENT_PENDING',trading_status='UNCERTAIN',
           inspection_trail=$2::jsonb,last_checked=now(),updated_at=now()
       WHERE channel_id=$1 AND scan_status='INTAKE_DEFERRED'`,
      [row.channel_id, JSON.stringify([...trail, {
        step: 'BIO',
        title: 'Intake gate removed: released to normal enrichment',
        status: 'FOUND',
        details: `Released from INTAKE_DEFERRED using ${plan.evidenceSource} evidence. The normal country and classification pipeline will decide the outcome.`,
        timestamp: new Date().toISOString(),
      }])],
    );
    const job = await enqueueJob('ENRICH_CHANNEL', {
      channelId: row.channel_id,
      targetCountry: plan.targetCountry,
      source: plan.source,
      candidate: plan.candidate,
      enrichmentStage: 1,
      intakeRelease: true,
      releaseVersion: 'intake-release-v1',
    }, {
      priority: 10,
      maxAttempts: 4,
      idempotencyKey: releaseIdempotencyKey(row.channel_id),
      clientOverride: client,
    });
    if (job.status !== 'PENDING' && job.status !== 'PROCESSING') {
      await client.query('ROLLBACK');
      inTransaction = false;
      return 'FAILED';
    }
    await client.query('COMMIT');
    inTransaction = false;
    return 'RELEASE';
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => undefined);
    console.error(JSON.stringify({
      event: 'intake_deferred_release_failed',
      channelId: row.channel_id,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }));
    return 'FAILED';
  } finally {
    client.release();
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const countryArg = process.argv.find(arg => arg.startsWith('--country='));
  const limit = Math.min(500, Math.max(1, Number(limitArg?.split('=')[1] || 100)));
  const country = countryArg?.split('=')[1]?.trim() || undefined;
  const rows = await loadRows(limit, country);
  const exclusions = await loadExclusions();
  const counts: ReleaseCounts = { released: 0, skipped: 0, excluded: 0, review: 0, failed: 0 };
  for (const row of rows) {
    const plan = classifyDeferredRelease(row, exclusions);
    if (!apply || plan.disposition !== 'RELEASE') {
      if (plan.disposition === 'RELEASE') counts.released += 1;
      else if (plan.disposition === 'EXCLUDED') counts.excluded += 1;
      else if (plan.disposition === 'REVIEW') counts.review += 1;
      else counts.skipped += 1;
      report(counts, {
        channelId: row.channel_id,
        disposition: plan.disposition,
        reason: plan.reason,
        evidenceSource: plan.evidenceSource,
      });
      continue;
    }
    const result = await applyRelease(row, plan);
    if (result === 'RELEASE') counts.released += 1;
    else if (result === 'FAILED') counts.failed += 1;
    else counts.skipped += 1;
    report(counts, {
      channelId: row.channel_id,
      disposition: result,
      reason: result === 'FAILED' ? 'APPLY_FAILED' : plan.reason,
      evidenceSource: plan.evidenceSource,
    });
  }
  console.log(JSON.stringify({
    event: 'intake_deferred_release_summary',
    apply,
    limit,
    country: country || null,
    counts,
    timestamp: new Date().toISOString(),
  }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('releaseIntakeDeferredChannels.ts')) {
  main().catch(error => {
    console.error('Intake deferred release failed:', error);
    process.exit(1);
  });
}
