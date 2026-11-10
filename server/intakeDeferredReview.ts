import { createHash } from 'node:crypto';
import { getDb, enqueueJob } from './db';
import type { ChannelRecord } from '../src/types';
import type { IntakeTradingFocusAssessment } from './intakeTradingFocus';

export type IntakeDeferredDecision = 'TRADING' | 'NON_TRADING' | 'AMBIGUOUS';
export type IntakeDeferredState = 'PENDING' | 'DECIDED' | 'SUPERSEDED';

export interface IntakeDeferredReview {
  channelId: string;
  channelName: string;
  youtubeUrl: string;
  country: string | null;
  countryStatus: string | null;
  confidenceScore: number;
  tradingStatus: string | null;
  scanStatus: string | null;
  language: string | null;
  metadataQuality: string | null;
  reviewVersion: number;
  state: IntakeDeferredState;
  decision: IntakeDeferredDecision | null;
  reviewer: string | null;
  reason: string | null;
  notes: string | null;
  corrections: Record<string, unknown>;
  systemSnapshot: Record<string, unknown>;
  evidenceSnapshot: Record<string, unknown>;
  recheckAttempts: number;
  lastCheckedAt: string | null;
  nextRecheckAt: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface IntakeDeferredReviewInput {
  channelId: string;
  targetCountry: string;
  source: string;
  candidate: Record<string, unknown>;
  focus: IntakeTradingFocusAssessment;
  countryStatus?: string | null;
  country?: string | null;
  language?: string | null;
  metadataQuality?: string | null;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mapReview(row: any): IntakeDeferredReview {
  return {
    channelId: String(row.channel_id),
    channelName: String(row.channel_name || ''),
    youtubeUrl: String(row.youtube_url || ''),
    country: row.country ? String(row.country) : null,
    countryStatus: row.country_status ? String(row.country_status) : null,
    confidenceScore: Number(row.confidence_score || 0),
    tradingStatus: row.trading_status ? String(row.trading_status) : null,
    scanStatus: row.scan_status ? String(row.scan_status) : null,
    language: row.language ? String(row.language) : null,
    metadataQuality: row.metadata_quality ? String(row.metadata_quality) : null,
    reviewVersion: Number(row.review_version || 1),
    state: String(row.state || 'PENDING') as IntakeDeferredState,
    decision: row.decision ? String(row.decision) as IntakeDeferredDecision : null,
    reviewer: row.reviewer ? String(row.reviewer) : null,
    reason: row.reason ? String(row.reason) : null,
    notes: row.notes ? String(row.notes) : null,
    corrections: (row.corrections || {}) as Record<string, unknown>,
    systemSnapshot: (row.system_snapshot || {}) as Record<string, unknown>,
    evidenceSnapshot: (row.evidence_snapshot || {}) as Record<string, unknown>,
    recheckAttempts: Number(row.recheck_attempts || 0),
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    nextRecheckAt: row.next_recheck_at ? new Date(row.next_recheck_at).toISOString() : null,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Record/refresh the evidence for a channel that was deferred at intake.
 * Human decisions are never overwritten: only PENDING rows refresh.
 */
export async function recordIntakeDeferredReview(input: IntakeDeferredReviewInput): Promise<void> {
  const db = await getDb();
  const evidence = {
    targetCountry: input.targetCountry,
    source: input.source,
    candidate: input.candidate,
    focus: input.focus,
  };
  const system = {
    reasonCodes: input.focus.reasonCodes,
    matchedSignals: input.focus.matchedSignals,
    positiveFamilies: input.focus.positiveFamilies,
    negativeFamilies: input.focus.negativeFamilies,
    policyVersion: input.focus.policyVersion,
    countryStatus: input.countryStatus || null,
    country: input.country || null,
  };
  await db.query(
    `INSERT INTO intake_deferred_reviews(
       channel_id,review_version,state,system_snapshot,evidence_snapshot,language,country,
       metadata_quality,recheck_attempts,last_checked_at,next_recheck_at
     ) VALUES($1,1,'PENDING',$2::jsonb,$3::jsonb,$4,$5,$6,0,now(),now()+interval '1 hour')
     ON CONFLICT(channel_id) DO UPDATE SET
       system_snapshot=excluded.system_snapshot,
       evidence_snapshot=excluded.evidence_snapshot,
       language=COALESCE(excluded.language,intake_deferred_reviews.language),
       country=COALESCE(excluded.country,intake_deferred_reviews.country),
       metadata_quality=COALESCE(excluded.metadata_quality,intake_deferred_reviews.metadata_quality),
       last_checked_at=now(),
       updated_at=now()
     WHERE intake_deferred_reviews.state='PENDING'`,
    [
      input.channelId,
      JSON.stringify(system),
      JSON.stringify(evidence),
      input.language || null,
      input.country || null,
      input.metadataQuality || null,
    ],
  );
}

export async function listIntakeDeferredReviews(filters: {
  country?: string;
  language?: string;
  search?: string;
  state?: IntakeDeferredState;
  limit?: number;
  offset?: number;
} = {}): Promise<IntakeDeferredReview[]> {
  const db = await getDb();
  const limit = Math.min(100, Math.max(1, filters.limit || 50));
  const offset = Math.max(0, filters.offset || 0);
  const result = await db.query(
    `SELECT r.*,c.channel_name,c.youtube_url,c.country,c.country_status,c.confidence_score,
            c.trading_status,c.scan_status
     FROM intake_deferred_reviews r
     JOIN channels c USING(channel_id)
     WHERE ($1::text IS NULL OR LOWER(c.country)=LOWER($1))
       AND ($2::text IS NULL OR LOWER(r.language)=LOWER($2))
       AND ($3::text IS NULL OR c.channel_name ILIKE '%'||$3||'%' OR c.channel_id ILIKE '%'||$3||'%')
       AND ($4::text IS NULL OR r.state=$4)
     ORDER BY r.next_recheck_at NULLS FIRST, r.updated_at DESC
     LIMIT $5 OFFSET $6`,
    [filters.country || null, filters.language || null, filters.search || null, filters.state || null, limit, offset],
  );
  return result.rows.map(mapReview);
}

export async function getIntakeDeferredReview(channelId: string): Promise<IntakeDeferredReview & {
  history: unknown[];
  inspectionTrail: unknown[];
  latestJob: unknown;
}> {
  const db = await getDb();
  const [review, history, job] = await Promise.all([
    db.query(
      `SELECT r.*,c.channel_name,c.youtube_url,c.country,c.country_status,c.confidence_score,
              c.trading_status,c.scan_status,c.inspection_trail
       FROM intake_deferred_reviews r JOIN channels c USING(channel_id)
       WHERE r.channel_id=$1`,
      [channelId],
    ),
    db.query(
      `SELECT id,decision,reviewer,reason,notes,corrections,system_snapshot,evidence_snapshot,
              review_version,decided_at
       FROM intake_deferred_review_decisions WHERE channel_id=$1 ORDER BY decided_at DESC`,
      [channelId],
    ),
    db.query(
      `SELECT id,type,status,payload,created_at FROM jobs
       WHERE type='ENRICH_CHANNEL' AND payload->>'channelId'=$1
       ORDER BY created_at DESC LIMIT 1`,
      [channelId],
    ),
  ]);
  if (!review.rowCount) {
    throw Object.assign(new Error('INTAKE_DEFERRED_REVIEW_NOT_FOUND'), { status: 404 });
  }
  const item = mapReview(review.rows[0]);
  return {
    ...item,
    history: history.rows,
    inspectionTrail: review.rows[0].inspection_trail || [],
    latestJob: job.rows[0] || null,
  };
}

export interface DecideIntakeDeferredInput {
  channelId: string;
  expectedVersion: number;
  reviewer: string;
  decision: IntakeDeferredDecision;
  reason: string;
  notes?: string;
  corrections?: Record<string, unknown>;
  idempotencyKey: string;
}

export async function decideIntakeDeferredReview(input: DecideIntakeDeferredInput) {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('reviewVersion must be a positive integer.');
  }
  if (!input.reviewer.trim() || !input.idempotencyKey.trim()) {
    throw new Error('reviewer and idempotencyKey are required.');
  }
  if (!['TRADING', 'NON_TRADING', 'AMBIGUOUS'].includes(input.decision)) {
    throw new Error('decision must be TRADING, NON_TRADING, or AMBIGUOUS.');
  }
  if (!input.reason.trim()) throw new Error('reason is required.');
  const db = await getDb();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const prior = await client.query(
      `SELECT * FROM intake_deferred_review_decisions WHERE idempotency_key=$1`,
      [input.idempotencyKey],
    );
    if (prior.rowCount) {
      await client.query('COMMIT');
      return { decision: prior.rows[0], idempotent: true };
    }
    const locked = await client.query(
      `SELECT r.*,to_jsonb(c) channel_snapshot
       FROM intake_deferred_reviews r JOIN channels c USING(channel_id)
       WHERE r.channel_id=$1 FOR UPDATE OF r,c`,
      [input.channelId],
    );
    if (!locked.rowCount) {
      throw Object.assign(new Error('INTAKE_DEFERRED_REVIEW_NOT_FOUND'), { status: 404 });
    }
    const row = locked.rows[0];
    // A concurrent retry may have committed while this transaction waited on
    // the review lock. Re-check the idempotency key under the lock so the
    // loser returns the committed decision instead of a spurious 409.
    const replay = await client.query(
      `SELECT * FROM intake_deferred_review_decisions WHERE idempotency_key=$1`,
      [input.idempotencyKey],
    );
    if (replay.rowCount) {
      await client.query('COMMIT');
      return { decision: replay.rows[0], idempotent: true };
    }
    if (Number(row.review_version) !== input.expectedVersion) {
      throw Object.assign(new Error(`Review version is ${row.review_version}; received ${input.expectedVersion}.`), { status: 409 });
    }
    if (row.state !== 'PENDING') {
      throw Object.assign(new Error(`Review is already ${row.state}.`), { status: 409 });
    }
    const channel = row.channel_snapshot as ChannelRecord;
    const corrections = input.corrections || {};
    const correctedCountry = typeof corrections.country === 'string' ? corrections.country.trim() : '';
    const correctedLanguage = typeof corrections.language === 'string' ? corrections.language.trim() : '';
    const countryToCheck = correctedCountry || channel.country || '';
    if (input.decision === 'TRADING' && countryToCheck) {
      const exclusion = await client.query(
        `SELECT country_name,reason FROM excluded_countries WHERE LOWER(country_name)=LOWER($1) LIMIT 1`,
        [countryToCheck],
      );
      if (exclusion.rowCount) {
        throw Object.assign(new Error(`Country ${countryToCheck} is excluded by policy: ${exclusion.rows[0].reason}`), { status: 422 });
      }
    }
    const nextVersion = Number(row.review_version) + 1;
    const decisionKey = checksum({
      channelId: input.channelId,
      decision: input.decision,
      reviewer: input.reviewer.trim(),
      reason: input.reason.trim(),
      corrections,
      reviewVersion: nextVersion,
    });
    const inserted = await client.query(
      `INSERT INTO intake_deferred_review_decisions(
         decision_key,channel_id,decision,reviewer,reason,notes,corrections,
         system_snapshot,evidence_snapshot,review_version,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11) RETURNING *`,
      [
        decisionKey,
        input.channelId,
        input.decision,
        input.reviewer.trim(),
        input.reason.trim(),
        input.notes?.trim() || null,
        JSON.stringify(corrections),
        JSON.stringify(row.system_snapshot || {}),
        JSON.stringify(row.evidence_snapshot || {}),
        nextVersion,
        input.idempotencyKey,
      ],
    );
    const evidence = row.evidence_snapshot || {};
    const system = row.system_snapshot || {};
    if (input.decision === 'TRADING') {
      await client.query(
        `UPDATE channels SET trading_status='UNCERTAIN',scan_status='ENRICHMENT_PENDING',
           country=COALESCE(NULLIF($2,''),country),
           country_status=CASE WHEN NULLIF($2,'') IS NULL THEN country_status ELSE 'LIKELY' END,
           updated_at=now() WHERE channel_id=$1`,
        [input.channelId, correctedCountry],
      );
      const candidate = (evidence.candidate || {}) as Record<string, unknown>;
      await enqueueJob('ENRICH_CHANNEL', {
        channelId: input.channelId,
        targetCountry: evidence.targetCountry || system.targetCountry || 'GLOBAL',
        source: evidence.source || system.source || 'automated_query',
        candidate: {
          ...candidate,
          channelId: input.channelId,
          channelName: channel.channel_name,
          youtubeUrl: channel.youtube_url,
        },
        enrichmentStage: 0,
        intakeReviewDecision: 'TRADING',
        intakeReviewVersion: nextVersion,
      }, {
        priority: 1000,
        maxAttempts: 4,
        idempotencyKey: `intake-review-enrich:${input.channelId}:${nextVersion}`,
        clientOverride: client,
      });
    } else if (input.decision === 'NON_TRADING') {
      await client.query(
        `UPDATE jobs SET status='FAILED',last_error='Cancelled by human intake rejection',
           locked_by=NULL,locked_at=NULL,updated_at=now()
         WHERE status IN ('PENDING','PROCESSING') AND payload->>'channelId'=$1`,
        [input.channelId],
      );
      await client.query(
        `UPDATE channels SET trading_status='HUMAN_REJECTED',scan_status='SKIPPED_NON_TRADING',
           country=COALESCE(NULLIF($2,''),country),updated_at=now() WHERE channel_id=$1`,
        [input.channelId, correctedCountry],
      );
    } else {
      await client.query(
        `UPDATE channels SET scan_status='INTAKE_DEFERRED',
           country=COALESCE(NULLIF($2,''),country),updated_at=now() WHERE channel_id=$1`,
        [input.channelId, correctedCountry],
      );
    }
    await client.query(
      `UPDATE intake_deferred_reviews SET state='DECIDED',decision=$2,reviewer=$3,reason=$4,
         notes=$5,corrections=$6::jsonb,review_version=$7,decided_at=now(),
         language=COALESCE(NULLIF($8,''),language),
         next_recheck_at=CASE WHEN $2='AMBIGUOUS' THEN now()+interval '7 days' ELSE NULL END,
         updated_at=now() WHERE channel_id=$1`,
      [
        input.channelId,
        input.decision,
        input.reviewer.trim(),
        input.reason.trim(),
        input.notes?.trim() || null,
        JSON.stringify(corrections),
        nextVersion,
        correctedLanguage,
      ],
    );
    const humanLabel = input.decision === 'TRADING' ? 'TRADING'
      : input.decision === 'NON_TRADING' ? 'NON_TRADING' : 'AMBIGUOUS';
    await client.query(
      `INSERT INTO human_evaluation_samples(
         sample_key,channel_id,stratum,system_status,system_prediction,human_label,
         human_confidence,language,country,metadata_quality,evidence_snapshot,reviewer,notes
       ) VALUES($1,$2,'INTAKE_DEFERRED',$3,$4,$5,'MEDIUM',$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT(sample_key) DO UPDATE SET human_label=excluded.human_label,
         reviewer=excluded.reviewer,notes=excluded.notes,decided_at=now()`,
      [
        `intake-deferred:${input.channelId}:${nextVersion}`,
        input.channelId,
        channel.trading_status || 'UNCERTAIN',
        channel.trading_status === 'TRADING_CONFIRMED' ? 'TRADING'
          : ['NON_TRADING', 'HUMAN_REJECTED'].includes(String(channel.trading_status || '')) ? 'NON_TRADING' : 'ABSTAIN',
        humanLabel,
        correctedLanguage || row.language || null,
        correctedCountry || row.country || channel.country || null,
        row.metadata_quality || null,
        JSON.stringify({
          system_snapshot: system,
          evidence_snapshot: evidence,
          corrections,
        }),
        input.reviewer.trim(),
        input.notes?.trim() || null,
      ],
    );
    await client.query('COMMIT');
    return { decision: inserted.rows[0], idempotent: false, reviewVersion: nextVersion };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface HumanEvaluationSample {
  sampleKey: string;
  channelId: string | null;
  stratum: string;
  systemStatus: string | null;
  systemPrediction: 'TRADING' | 'NON_TRADING' | 'ABSTAIN' | null;
  humanLabel: 'TRADING' | 'NON_TRADING' | 'AMBIGUOUS';
  humanConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
  language: string | null;
  country: string | null;
  metadataQuality: string | null;
  evidenceSnapshot: Record<string, unknown>;
  reviewer: string;
  notes: string | null;
  decidedAt: string;
}

const HUMAN_LABELS = ['TRADING', 'NON_TRADING', 'AMBIGUOUS'] as const;
const SYSTEM_PREDICTIONS = ['TRADING', 'NON_TRADING', 'ABSTAIN'] as const;
const HUMAN_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;

function fixtureError(index: number, field: string, expected: string): never {
  throw new Error(`HUMAN_EVALUATION_FIXTURE_INVALID: sample[${index}].${field} ${expected}`);
}

/**
 * Validate a fixture before it is seeded or scored. A bad enum must fail
 * loudly rather than disappear from one side of the confusion matrix.
 */
export function normalizeHumanEvaluationSamples(input: unknown): HumanEvaluationSample[] {
  if (!Array.isArray(input)) throw new Error('HUMAN_EVALUATION_FIXTURE_INVALID: root must be an array');
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fixtureError(index, 'root', 'must be an object');
    }
    const row = entry as Record<string, unknown>;
    const requiredString = (field: string): string => {
      const value = row[field];
      if (typeof value !== 'string' || !value.trim()) fixtureError(index, field, 'must be a non-empty string');
      return value.trim();
    };
    const optionalString = (field: string): string | null => {
      const value = row[field];
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string') fixtureError(index, field, 'must be a string or null');
      return value.trim() || null;
    };
    const enumValue = <T extends string>(field: string, allowed: readonly T[], nullable = false): T | null => {
      const value = row[field];
      if (nullable && (value === null || value === undefined)) return null;
      if (typeof value !== 'string' || !allowed.includes(value as T)) {
        fixtureError(index, field, `must be one of ${allowed.join(', ')}`);
      }
      return value as T;
    };
    const evidence = row.evidenceSnapshot ?? row.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      fixtureError(index, 'evidence', 'must be an object');
    }
    const evidenceSnapshot = { ...(evidence as Record<string, unknown>) };
    if (typeof row.channelName === 'string' && row.channelName.trim()) evidenceSnapshot.channelName = row.channelName.trim();
    if (typeof row.youtubeUrl === 'string' && row.youtubeUrl.trim()) evidenceSnapshot.youtubeUrl = row.youtubeUrl.trim();
    const decidedAt = requiredString('decidedAt');
    if (Number.isNaN(Date.parse(decidedAt))) fixtureError(index, 'decidedAt', 'must be an ISO timestamp');
    return {
      sampleKey: requiredString('sampleKey'),
      channelId: optionalString('channelId'),
      stratum: requiredString('stratum'),
      systemStatus: optionalString('systemStatus'),
      systemPrediction: enumValue('systemPrediction', SYSTEM_PREDICTIONS, true),
      humanLabel: enumValue('humanLabel', HUMAN_LABELS)!,
      humanConfidence: (enumValue('humanConfidence', HUMAN_CONFIDENCES) || 'MEDIUM') as HumanEvaluationSample['humanConfidence'],
      language: optionalString('language'),
      country: optionalString('country'),
      metadataQuality: optionalString('metadataQuality'),
      evidenceSnapshot,
      reviewer: requiredString('reviewer'),
      notes: optionalString('notes'),
      decidedAt: new Date(decidedAt).toISOString(),
    };
  });
}

export async function listHumanEvaluationSamples(filters: {
  language?: string;
  country?: string;
  label?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<HumanEvaluationSample[]> {
  const db = await getDb();
  const limit = Math.min(5000, Math.max(1, filters.limit || 200));
  const offset = Math.max(0, Math.trunc(filters.offset || 0));
  const result = await db.query(
    `SELECT * FROM human_evaluation_samples
     WHERE ($1::text IS NULL OR LOWER(language)=LOWER($1))
       AND ($2::text IS NULL OR LOWER(country)=LOWER($2))
       AND ($3::text IS NULL OR human_label=$3)
     ORDER BY decided_at DESC, sample_key LIMIT $4 OFFSET $5`,
    [filters.language || null, filters.country || null, filters.label || null, limit, offset],
  );
  return result.rows.map((row: any) => ({
    sampleKey: String(row.sample_key),
    channelId: row.channel_id || null,
    stratum: String(row.stratum),
    systemStatus: row.system_status || null,
    systemPrediction: row.system_prediction || null,
    humanLabel: row.human_label,
    humanConfidence: row.human_confidence,
    language: row.language || null,
    country: row.country || null,
    metadataQuality: row.metadata_quality || null,
    evidenceSnapshot: row.evidence_snapshot || {},
    reviewer: String(row.reviewer),
    notes: row.notes || null,
    decidedAt: new Date(row.decided_at).toISOString(),
  }));
}

export interface EvaluationMetrics {
  samples: number;
  ambiguous: number;
  abstained: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  coverage: number;
}

export function computeEvaluationMetrics(samples: HumanEvaluationSample[]): EvaluationMetrics {
  let tp = 0, fp = 0, tn = 0, fn = 0, ambiguous = 0, abstained = 0;
  for (const sample of samples) {
    if (sample.humanLabel === 'AMBIGUOUS') {
      ambiguous += 1;
      continue;
    }
    const prediction = sample.systemPrediction
      || (sample.systemStatus === 'TRADING_CONFIRMED' ? 'TRADING'
        : ['NON_TRADING', 'HUMAN_REJECTED'].includes(String(sample.systemStatus || '')) ? 'NON_TRADING' : 'ABSTAIN');
    if (prediction === 'ABSTAIN') {
      abstained += 1;
      continue;
    }
    if (prediction === 'TRADING' && sample.humanLabel === 'TRADING') tp += 1;
    else if (prediction === 'TRADING' && sample.humanLabel === 'NON_TRADING') fp += 1;
    else if (prediction === 'NON_TRADING' && sample.humanLabel === 'NON_TRADING') tn += 1;
    else if (prediction === 'NON_TRADING' && sample.humanLabel === 'TRADING') fn += 1;
  }
  const evaluated = tp + fp + tn + fn;
  const ratio = (numerator: number, denominator: number) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
  return {
    samples: samples.length,
    ambiguous,
    abstained,
    tp, fp, tn, fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn),
    falseNegativeRate: ratio(fn, fn + tp),
    coverage: ratio(evaluated, samples.length) || 0,
  };
}

export function computeEvaluationBreakdown(
  samples: HumanEvaluationSample[],
  dimension: 'language' | 'country' | 'metadataQuality',
): Array<EvaluationMetrics & { value: string }> {
  const groups = new Map<string, HumanEvaluationSample[]>();
  for (const sample of samples) {
    const value = String(sample[dimension] || 'UNKNOWN');
    const group = groups.get(value) || [];
    group.push(sample);
    groups.set(value, group);
  }
  return [...groups.entries()]
    .map(([value, group]) => ({ value, ...computeEvaluationMetrics(group) }))
    .sort((a, b) => b.samples - a.samples || a.value.localeCompare(b.value));
}
