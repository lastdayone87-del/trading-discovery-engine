import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDb,
  getQueryIntelligenceSummary,
  getQueryLibraryPage,
  getVocabularyPage,
  getQueryTerminologyCurrentStatuses,
  persistQueryTerminologyDigest,
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
    await db.end();
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
    await db.end();
  }
});
