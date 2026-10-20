import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidenceCandidates } from './evidenceExtraction';
import { stageEvidenceCandidates } from './evidenceStaging';
import {
  DISCOVERY_EXTRACTION_FLAG_KEY,
  maybeRunDiscoveryEvidenceExtraction,
} from './evidencePipeline';
import { normalizeTerm } from '../terminologyIntelligence';

/**
 * Live-database tests for evidence-extraction staging. Run ONLY against an
 * explicitly provided dedicated migrated test database:
 *
 *   DISCOVERY_EXTRACTION_TEST_DATABASE_URL=postgresql://... \
 *     node --import tsx --test server/discovery/evidencePipeline.postgres.test.ts
 *
 * Without that variable every test below skips. The suite refuses to run
 * before proving the required tables and the migrated evidence-extraction
 * constraints/provider row exist, never writes app_settings (the flag is
 * injected), and deletes only its own uniquely-tagged staging rows.
 */
const dedicated = process.env.DISCOVERY_EXTRACTION_TEST_DATABASE_URL;

test('discovery extraction postgres tests require a dedicated database (skipped otherwise)', () => {
  if (!dedicated) {
    console.log(
      'SKIP: set DISCOVERY_EXTRACTION_TEST_DATABASE_URL to a dedicated migrated test database to run evidence-extraction staging tests.'
    );
  }
  assert.ok(true);
});

if (dedicated) process.env.DATABASE_URL = dedicated;
const maybe = dedicated ? test : test.skip;

if (dedicated) {
  after(async () => {
    const { getDb } = await import('../dbCore');
    const pool = (await getDb()) as unknown as { end?: () => Promise<void> };
    await pool.end?.();
  });
}

type Db = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

async function db(): Promise<Db> {
  const { getDb } = await import('../dbCore');
  return (await getDb()) as unknown as Db;
}

async function assertIsolatedTestDb(database: Db) {
  for (const table of [
    'discovery_candidate_staging',
    'discovery_candidate_observations',
    'discovery_provider_registry',
    'canonical_trading_terms',
    'country_vocabularies',
  ]) {
    const exists = await database.query(`SELECT to_regclass($1) AS oid`, [table]);
    assert.ok(exists.rows[0]?.oid, `required table missing: ${table} (is the test DB migrated?)`);
  }
  const provider = await database.query(
    `SELECT provider_key FROM discovery_provider_registry WHERE provider_key='evidence_extraction'`
  );
  assert.equal(provider.rows.length, 1, 'migration 146 must be applied to the dedicated test database');
}

function uniqueFixture(): { term: string; channelId: string; tag: string } {
  const tag = `pgtest${process.pid}${Date.now()}`;
  return { term: `fluxorderflow${tag}`, channelId: `UCpgtest${tag}`, tag };
}

function fixtureCandidate(term: string, channelId: string) {
  const candidates = extractEvidenceCandidates({
    channelId,
    channelName: term,
    videoTags: [term],
    description: `${term} strategie`,
  });
  const candidate = candidates.find(entry => entry.normalizedTerm === normalizeTerm(term));
  assert.ok(candidate, 'fixture term must be extracted');
  return candidate!;
}

maybe('evidence staging is idempotent, restart-safe, and concurrency-safe under real constraints', async () => {
  const database = await db();
  await assertIsolatedTestDb(database);
  const { term, channelId } = uniqueFixture();
  const candidate = fixtureCandidate(term, channelId);
  const context = { channelId, country: 'Germany', language: 'de' };
  try {
    const first = await stageEvidenceCandidates([candidate], context, database);
    assert.equal(first.stagedCount, 1);
    assert.equal(first.observationCount >= 1, true);

    const replay = await stageEvidenceCandidates([candidate], context, database);
    assert.equal(replay.stagedCount, 0);
    assert.equal(replay.duplicateCount, 1);
    assert.equal(replay.observationCount, 0);

    const concurrent = await Promise.all([
      stageEvidenceCandidates([candidate], context, database),
      stageEvidenceCandidates([candidate], context, database),
      stageEvidenceCandidates([candidate], context, database),
    ]);
    assert.ok(concurrent.every(result => result.stagedCount + result.duplicateCount === 1));

    const staging = await database.query(
      `SELECT resolution_status, provider_key, discovery_mode, candidate_type, canonical_candidate_key
       FROM discovery_candidate_staging WHERE canonical_candidate_key=$1`,
      [candidate.canonicalCandidateKey]
    );
    assert.equal(staging.rows.length, 1);
    assert.equal(staging.rows[0].resolution_status, 'EVIDENCE_ONLY');
    assert.equal(staging.rows[0].provider_key, 'evidence_extraction');
    assert.equal(staging.rows[0].discovery_mode, 'EVIDENCE_EXTRACTION');
    assert.equal(staging.rows[0].candidate_type, 'SEARCH_TERM');
    assert.equal(staging.rows[0].canonical_candidate_key, candidate.canonicalCandidateKey);

    const observations = await database.query(
      `SELECT COUNT(*)::int AS count FROM discovery_candidate_observations WHERE canonical_candidate_key=$1`,
      [candidate.canonicalCandidateKey]
    );
    assert.ok(observations.rows[0].count >= 1, 'observation provenance must persist');
  } finally {
    await database.query(
      `DELETE FROM discovery_candidate_staging WHERE provider_key='evidence_extraction' AND canonical_candidate_key=$1`,
      [candidate.canonicalCandidateKey]
    );
  }
});

maybe('flag OFF suppresses writes; extraction never changes eligibility state', async () => {
  const database = await db();
  await assertIsolatedTestDb(database);
  const { term, channelId } = uniqueFixture();
  const candidate = fixtureCandidate(term, channelId);
  const input = {
    channelId,
    videoTags: [term],
    description: term,
    creatorCountry: 'Germany',
    fallbackCountry: 'Germany',
  };
  const eligibilityBefore = await database.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE search_eligible)::int AS eligible FROM canonical_trading_terms`
  );
  try {
    const off = await maybeRunDiscoveryEvidenceExtraction(input, {
      readSetting: async key => (key === DISCOVERY_EXTRACTION_FLAG_KEY ? 'false' : ''),
      client: database,
    });
    assert.equal(off.skipped, true);
    const offRows = await database.query(
      `SELECT COUNT(*)::int AS count FROM discovery_candidate_staging WHERE canonical_candidate_key=$1`,
      [candidate.canonicalCandidateKey]
    );
    assert.equal(offRows.rows[0].count, 0);

    // Flag injected (never written to app_settings); staging stays inert.
    const on = await maybeRunDiscoveryEvidenceExtraction(input, {
      readSetting: async key => (key === DISCOVERY_EXTRACTION_FLAG_KEY ? 'true' : ''),
      client: database,
    });
    assert.equal(on.skipped, false);
    assert.ok(on.stagedCount >= 1);

    const pending = await database.query(
      `SELECT COUNT(*)::int AS count FROM discovery_candidate_staging
       WHERE canonical_candidate_key=$1 AND resolution_status='PENDING'`,
      [candidate.canonicalCandidateKey]
    );
    assert.equal(pending.rows[0].count, 0, 'evidence rows must never enter the Brave pending claim path');

    const eligibilityAfter = await database.query(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE search_eligible)::int AS eligible FROM canonical_trading_terms`
    );
    assert.deepEqual(eligibilityAfter.rows[0], eligibilityBefore.rows[0]);
  } finally {
    await database.query(
      `DELETE FROM discovery_candidate_staging WHERE provider_key='evidence_extraction' AND canonical_candidate_key=$1`,
      [candidate.canonicalCandidateKey]
    );
  }
});
