import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVIDENCE_RESOLUTION_STATUS,
  evidenceObservationKey,
  stageEvidenceCandidates,
  type EvidenceStagingClient,
  type EvidenceStagingQueryable,
} from './evidenceStaging';
import { extractEvidenceCandidates, type EvidenceProvenance } from './evidenceExtraction';

class FakeStagingDb implements EvidenceStagingQueryable {
  staging = new Map<string, { id: string }>();
  observations = new Set<string>();
  statements: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []) {
    this.statements.push({ sql, params });
    if (sql.includes('INSERT INTO discovery_candidate_staging')) {
      const key = String(params[0]);
      const existing = this.staging.get(key);
      if (existing) return { rows: [{ id: existing.id, inserted: false }] };
      const id = `staging-${this.staging.size + 1}`;
      this.staging.set(key, { id });
      return { rows: [{ id, inserted: true }] };
    }
    if (sql.includes('INSERT INTO discovery_candidate_observations')) {
      const key = String(params[0]);
      if (this.observations.has(key)) return { rows: [] };
      this.observations.add(key);
      return { rows: [{ observation_key: key }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function fixtures() {
  return extractEvidenceCandidates({
    channelId: 'UCstage000000000000000000',
    channelHandle: '@boerse_berlin',
    description: 'Flux Orderflow live #devisen',
  });
}

test('staging writer follows Brave conventions with distinct evidence values', async () => {
  const db = new FakeStagingDb();
  const candidates = fixtures();
  assert.ok(candidates.length >= 2);
  const result = await stageEvidenceCandidates(
    candidates,
    { channelId: 'UCstage000000000000000000', country: 'Germany', language: 'de' },
    db
  );
  assert.equal(result.stagedCount, candidates.length);
  assert.equal(result.duplicateCount, 0);
  const expectedObservations = new Set(
    candidates.flatMap(candidate => candidate.provenance.map(provenance =>
      evidenceObservationKey(candidate.canonicalCandidateKey, 'UCstage000000000000000000', provenance)
    ))
  ).size;
  assert.equal(result.observationCount, expectedObservations);

  const staging = db.statements.find(statement => statement.sql.includes('INSERT INTO discovery_candidate_staging'));
  assert.ok(staging);
  assert.match(staging!.sql, /ON CONFLICT \(staging_key\) DO UPDATE SET\s+updated_at=now\(\)/);
  assert.match(staging!.sql, /RETURNING id, \(xmax=0\) AS inserted/);
  const params = staging!.params;
  assert.equal(params[0], params[1]); // staging_key = canonical_candidate_key
  assert.equal(params[2], 'evidence_extraction');
  assert.equal(params[3], 'INGESTION_METADATA');
  assert.equal(params[5], 'SEARCH_TERM');
  assert.equal(params[13], 'EVIDENCE_EXTRACTION');
  assert.equal(params[15], 'EVIDENCE_ONLY');
  assert.equal(params[16], 'UNVALIDATED');
  assert.ok(!params.includes('PENDING'));

  const observation = db.statements.find(statement => statement.sql.includes('INSERT INTO discovery_candidate_observations'));
  assert.ok(observation);
  assert.match(observation!.sql, /ON CONFLICT\(observation_key\) DO NOTHING/);
  assert.equal(observation!.params[3], 'evidence_extraction');
  assert.equal(observation!.params[14], 'EVIDENCE_EXTRACTION');
});

test('staging is idempotent: identical re-runs duplicate without new rows', async () => {
  const db = new FakeStagingDb();
  const candidates = fixtures();
  const context = { channelId: 'UCstage000000000000000000', country: 'Germany', language: 'de' };
  const first = await stageEvidenceCandidates(candidates, context, db);
  const stagingRows = db.staging.size;
  const observationRows = db.observations.size;
  const second = await stageEvidenceCandidates(candidates, context, db);

  assert.equal(first.stagedCount, candidates.length);
  assert.equal(first.duplicateCount, 0);
  assert.equal(second.stagedCount, 0);
  assert.equal(second.duplicateCount, candidates.length);
  assert.equal(second.observationCount, 0);
  assert.equal(db.staging.size, stagingRows);
  assert.equal(db.observations.size, observationRows);
});

test('observation keys are deterministic per channel/source occurrence', () => {
  const [candidate] = fixtures();
  const provenance = candidate.provenance[0] as EvidenceProvenance;
  const a = evidenceObservationKey(candidate.canonicalCandidateKey, 'UCone', provenance);
  const b = evidenceObservationKey(candidate.canonicalCandidateKey, 'UCone', provenance);
  const otherChannel = evidenceObservationKey(candidate.canonicalCandidateKey, 'UCtwo', provenance);
  assert.equal(a, b);
  assert.notEqual(a, otherChannel);
  if (candidate.provenance.length > 1) {
    const other = evidenceObservationKey(candidate.canonicalCandidateKey, 'UCone', candidate.provenance[1]);
    assert.notEqual(a, other);
  }
});

test('the evidence resolution status is the dedicated non-colliding value', () => {
  assert.equal(EVIDENCE_RESOLUTION_STATUS, 'EVIDENCE_ONLY');
});

test('empty candidate lists are a zero-cost no-op', async () => {
  const db = new FakeStagingDb();
  const result = await stageEvidenceCandidates([], { channelId: 'UCnone', country: 'Germany' }, db);
  assert.deepEqual(result, { stagedCount: 0, duplicateCount: 0, observationCount: 0 });
  assert.equal(db.statements.length, 0);
});

test('staging without a country fails loudly instead of writing an invalid row', async () => {
  const db = new FakeStagingDb();
  await assert.rejects(
    stageEvidenceCandidates(fixtures(), { channelId: 'UCx', country: '  ' }, db),
    /EVIDENCE_STAGING_COUNTRY_REQUIRED/
  );
});


test('a mid-batch failure rolls the entire staging batch back', async () => {
  class FailingTxPool implements EvidenceStagingClient {
    totalCount = 1;
    statements: string[] = [];
    constructor(private readonly inner: FakeStagingDb) {}

    async query(sql: string, params: unknown[] = []) {
      return this.inner.query(sql, params);
    }

    async connect() {
      let observationAttempts = 0;
      return {
        query: async (sql: string, params: unknown[] = []) => {
          this.statements.push(sql);
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('INSERT INTO discovery_candidate_observations')) {
            observationAttempts += 1;
            if (observationAttempts === 2) throw new Error('injected observation failure');
          }
          return this.inner.query(sql, params);
        },
        release: () => undefined,
      };
    }
  }

  const pool = new FailingTxPool(new FakeStagingDb());
  await assert.rejects(
    stageEvidenceCandidates(
      fixtures(),
      { channelId: 'UCrollback', country: 'Germany', language: 'de' },
      pool
    ),
    /injected observation failure/
  );
  assert.ok(pool.statements.includes('BEGIN'));
  assert.ok(pool.statements.includes('ROLLBACK'));
  assert.ok(!pool.statements.includes('COMMIT'));
});
