import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDb,
  getQueryIntelligenceSummary,
  getQueryLibraryPage,
  getVocabularyPage,
  getQueryTerminologyCurrentStatuses,
  persistQueryTerminologyDigest,
  persistExtractedQueryCandidates,
  getStandaloneExtractedQueryCandidates,
  getExtractedQueryCandidates,
  markExtractedQueryCandidatesAttempted,
  reconcileExtractedQueryCandidates,
  resetQueryIntelligenceSummaryCacheForTests,
} from './db';
import { getTerminologyDashboardPage } from './terminologyIntelligence';

const databaseUrl = process.env.PHASE4_POSTGRES_URL;

test('Stage 4 PostgreSQL: dashboard library/vocabulary filters and pagination are applied before the bound', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `dashboard-page-${Date.now()}-${process.pid}`;
  const queryIds: number[] = [];
  const termIds: number[] = [];
  const canonicalIds: string[] = [];
  try {
    const insertQuery = async (country: string, collection: string, score: number) => {
      const id = (await db.query(
        `INSERT INTO query_library(query,country,collection,intent,normalized_query,performance_score,times_executed)
         VALUES($1,$2,$3,'GENERAL',$1,$4,0) RETURNING id`,
        [`${suffix}-${country}-${collection}-${score}`, country, collection, score]
      )).rows[0].id as number;
      queryIds.push(id);
      return id;
    };
    const frExpA = await insertQuery('France', 'EXPERIMENTAL', 30);
    const frExpB = await insertQuery('France', 'EXPERIMENTAL', 20);
    const frRejected = await insertQuery('France', 'REJECTED', 10);
    await insertQuery('Germany', 'EXPERIMENTAL', 5);

    assert.equal((await getQueryLibraryPage('France', 'EXPERIMENTAL', 1, 0))[0]?.id, frExpA);
    assert.equal((await getQueryLibraryPage('France', 'EXPERIMENTAL', 1, 1))[0]?.id, frExpB);
    assert.equal((await getQueryLibraryPage(undefined, 'REJECTED', 10, 0)).some(row => row.id === frRejected), true);
    assert.equal((await getQueryLibraryPage('France', 'REJECTED', 10, 0)).every(row => row.country === 'France' && row.collection === 'REJECTED'), true);

    const insertTerm = async (country: string, term: string, occurrences: number) => {
      const id = (await db.query(
        `INSERT INTO extracted_trading_vocabulary(country,term,category,occurrences,first_extracted,last_extracted,trust_tier,validation_count)
         VALUES($1,$2,'terminology',$3,now(),now(),3,1) RETURNING id`,
        [country, term, occurrences]
      )).rows[0].id as number;
      termIds.push(id);
      return id;
    };
    await insertTerm('France', `${suffix}-fr-a`, 3);
    await insertTerm('France', `${suffix}-fr-b`, 2);
    await insertTerm('Germany', `${suffix}-de-a`, 1);
    const frPage = await getVocabularyPage('France', 1, 1);
    assert.equal(frPage.length, 1);
    assert.equal(frPage[0].term, `${suffix}-fr-b`, 'the second French term must be reachable through offset');

    const insertCanonical = async (term: string, observedAt: string) => {
      const id = (await db.query(
        `INSERT INTO canonical_trading_terms(canonical_term,normalized_term,country,language,script,term_type,trust_tier,search_eligible,lifecycle_status,first_observed_at,last_observed_at)
         VALUES($1,$2,'France','fr','Latn','TERMINOLOGY',3,false,'OBSERVED',$3,$3) RETURNING id`,
        [term, term.toLocaleLowerCase('en'), observedAt]
      )).rows[0].id;
      // Keep the exact bigint text for cleanup; Number() can lose precision
      // once the BIGSERIAL sequence exceeds 2^53.
      const exactId = String(id);
      canonicalIds.push(exactId);
      return exactId;
    };
    const olderCanonical = await insertCanonical(`${suffix}-canonical-older`, new Date(Date.now() - 120_000).toISOString());
    const newerCanonical = await insertCanonical(`${suffix}-canonical-newer`, new Date(Date.now() - 60_000).toISOString());
    const firstCanonicalPage = await getTerminologyDashboardPage('France', 1, 0);
    const secondCanonicalPage = await getTerminologyDashboardPage('France', 1, 1);
    assert.equal(String((firstCanonicalPage[0] as { id: unknown }).id), newerCanonical);
    assert.equal(String((secondCanonicalPage[0] as { id: unknown }).id), olderCanonical);

    resetQueryIntelligenceSummaryCacheForTests();
    const first = await getQueryIntelligenceSummary({ now: 1_000, force: true });
    const extraId = await insertQuery('France', 'EXPERIMENTAL', 1);
    const cached = await getQueryIntelligenceSummary({ now: 2_000 });
    const refreshed = await getQueryIntelligenceSummary({ now: 2_000, force: true });
    assert.equal(cached.queryCount, first.queryCount, 'a fresh cache must not recount');
    assert.equal(refreshed.queryCount, first.queryCount + 1, 'force must bypass the cache');
    await db.query('DELETE FROM query_library WHERE id=$1', [extraId]).catch(() => undefined);
    queryIds.splice(queryIds.indexOf(extraId), 1);
  } finally {
    resetQueryIntelligenceSummaryCacheForTests();
    if (queryIds.length) await db.query('DELETE FROM query_library WHERE id=ANY($1::int[])', [queryIds]).catch(() => undefined);
    if (termIds.length) await db.query('DELETE FROM extracted_trading_vocabulary WHERE id=ANY($1::int[])', [termIds]).catch(() => undefined);
    if (canonicalIds.length) await db.query('DELETE FROM canonical_trading_terms WHERE id=ANY($1::bigint[])', [canonicalIds]).catch(() => undefined);
  }
});


test('Stage 4 PostgreSQL: saved query terminology status and digest persistence', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `terminology-reval-${Date.now()}-${process.pid}`;
  let termId: string | null = null;
  let queryId: number | null = null;
  try {
    termId = String((await db.query(
      `INSERT INTO canonical_trading_terms(canonical_term,normalized_term,country,language,script,term_type,trust_tier,search_eligible,lifecycle_status)
       VALUES($1,$2,'Germany','de','Latn','TERMINOLOGY',2,true,'SEARCH_TRIAL') RETURNING id`,
      [`${suffix}-term`, suffix]
    )).rows[0].id);
    queryId = Number((await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query,performance_score,times_executed,generation_metadata)
       VALUES($1,'Germany','EXPERIMENTAL','GENERAL',$1,10,0,$2::jsonb) RETURNING id`,
      [`${suffix}-query`, JSON.stringify({ terminologyId: termId, terminologyLifecycle: 'SEARCH_TRIAL', learnedTerm: 'DAX' })]
    )).rows[0].id);
    const statuses = await getQueryTerminologyCurrentStatuses([queryId]);
    assert.equal(statuses.get(queryId)?.termId, Number(termId));
    assert.equal(statuses.get(queryId)?.searchEligible, true);
    assert.equal(await persistQueryTerminologyDigest(queryId, termId, {
      queryTemplate: 'ANCHOR_LEARNED',
      terminologyRevalidation: { disposition: 'DIGESTED', previousTermId: termId },
    }), true);
    const stored = (await db.query('SELECT generation_metadata FROM query_library WHERE id=$1', [queryId])).rows[0].generation_metadata;
    assert.equal(stored.terminologyId, undefined);
    assert.equal(stored.terminologyRevalidation.disposition, 'DIGESTED');
  } finally {
    if (queryId !== null) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
    if (termId !== null) await db.query('DELETE FROM canonical_trading_terms WHERE id=$1', [termId]).catch(() => undefined);
  }
});

after(async () => {
  if (!databaseUrl) return;
  const db = await getDb();
  await db.end().catch(() => undefined);
});


test('Stage 4 PostgreSQL: extracted query ledger deduplicates and serves accepted standalone candidates', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `extracted-ledger-${Date.now()}-${process.pid}`;
  const testCountry = `Test ${suffix}`;
  let reconciledQueryId: number | null = null;
  try {
    const candidate = {
      candidateKey: `${suffix}-key`,
      candidateText: 'Weekly trade analysis',
      normalizedText: 'weekly trade analysis',
      country: testCountry,
      language: 'en',
      script: 'Latn',
      sourceKind: 'VIDEO_TITLE',
      sourceChannelId: 'channel-test',
      sourceVideoId: 'video-test',
      sourceTitle: 'Weekly trade analysis - promo suffix',
      intent: 'strategy',
      confidence: 0.8,
      accepted: true,
      standaloneEligible: true,
      reasons: [],
    };
    assert.deepEqual(await persistExtractedQueryCandidates([candidate]), { accepted: 1, rejected: 0, duplicates: 0 });
    assert.deepEqual(await persistExtractedQueryCandidates([{ ...candidate, sourceChannelId: 'channel-test-2' }]), { accepted: 0, rejected: 0, duplicates: 1 });
    // Re-observing the same source is a reprocessing event, not a new sighting.
    await persistExtractedQueryCandidates([candidate]);
    const duplicateCount = (await db.query(
      'SELECT duplicate_count FROM extracted_query_candidates WHERE candidate_key=$1',
      [candidate.candidateKey],
    )).rows[0].duplicate_count;
    assert.equal(Number(duplicateCount), 1);
    for (let index = 0; index < 25; index += 1) {
      await persistExtractedQueryCandidates([{ ...candidate, sourceChannelId: `channel-${index}` }]);
    }
    const capped = (await db.query(
      'SELECT duplicate_count, jsonb_array_length(duplicate_sources) AS sample_size FROM extracted_query_candidates WHERE candidate_key=$1',
      [candidate.candidateKey],
    )).rows[0];
    assert.equal(Number(capped.duplicate_count), 19);
    assert.equal(Number(capped.sample_size), 20);
    const snapshot = (await db.query('SELECT now() AS snapshot')).rows[0].snapshot as Date;
    await persistExtractedQueryCandidates([{
      ...candidate,
      candidateKey: `${suffix}-after-snapshot`,
      candidateText: 'After snapshot analysis',
      normalizedText: 'after snapshot analysis',
    }]);
    const beforeRows = await getExtractedQueryCandidates(testCountry, 100, 0, snapshot.toISOString());
    assert.ok(!beforeRows.some(row => row.candidateKey === `${suffix}-after-snapshot`));
    const standalone = await getStandaloneExtractedQueryCandidates(testCountry, 50);
    assert.ok(standalone.some(row => row.candidateKey === candidate.candidateKey));
    const candidateId = standalone.find(row => row.candidateKey === candidate.candidateKey)!.id;
    // A transient pre-link failure self-heals from existing query text.
    const reconciledQuery = await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query,performance_score,times_executed)
       VALUES($1,$3,'EXPERIMENTAL','GENERAL',$2,0,0) RETURNING id`,
      [`${suffix} reconciled query`, 'matching normalized text', testCountry],
    );
    reconciledQueryId = Number(reconciledQuery.rows[0].id);
    await persistExtractedQueryCandidates([{
      ...candidate,
      candidateKey: `${suffix}-reconciled`,
      candidateText: 'Matching normalized text',
      normalizedText: 'matching normalized text',
    }]);
    assert.ok(await reconcileExtractedQueryCandidates(testCountry) >= 1);
    const reconciledRow = await db.query(
      'SELECT query_id FROM extracted_query_candidates WHERE candidate_key=$1',
      [`${suffix}-reconciled`],
    );
    assert.equal(Number(reconciledRow.rows[0].query_id), reconciledQueryId);
    await markExtractedQueryCandidatesAttempted([candidateId]);
    const rotated = await getStandaloneExtractedQueryCandidates(testCountry, 50);
    assert.ok(!rotated.some(row => row.candidateKey === candidate.candidateKey));
    await db.query('UPDATE extracted_query_candidates SET last_attempted_at=NULL WHERE id=$1', [candidateId]);
    const lcb = await getExtractedQueryCandidates(testCountry, 100, 0);
    assert.ok(lcb.some(row => row.candidateKey === candidate.candidateKey));
  } finally {
    await db.query('DELETE FROM extracted_query_candidates WHERE candidate_key LIKE $1', [`${suffix}%`]).catch(() => undefined);
    if (reconciledQueryId) await db.query('DELETE FROM query_library WHERE id=$1', [reconciledQueryId]).catch(() => undefined);
  }
});
