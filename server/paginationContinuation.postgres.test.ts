import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';
import {
  getAutonomousContinuationState,
  markAutonomousPageDeferredForAdmissionReview,
  settleAutonomousPageAdmissionDeferral,
} from './autonomousPageStore';

const databaseUrl = process.env.PHASE4_POSTGRES_URL;
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PGSSL = 'disable';
}
const skip = databaseUrl ? false : 'PHASE4_POSTGRES_URL is required';
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip }, fn);

const v2 = (primaryReason: string, codes: string[], lowValue: number) => JSON.stringify({
  defer: false,
  deferReason: null,
  lowValue: lowValue > 0,
  duplicateHeavy: false,
  wrongCountry: false,
  productive: primaryReason === 'CONTINUE_GRACE',
  marginalUtility: 0.1,
  primaryReason,
  reasonCodes: codes,
  streaks: { lowValue, duplicateHeavy: 0, wrongCountry: 0 },
  explorationPagesRemaining: 1,
  effectiveMaxPages: 50,
  shouldContinue: primaryReason !== 'MARGINAL_VALUE_LOW',
});

maybe('linked continuation children inherit the parent trailing low-value streak', async () => {
  const db = await getDb();
  const suffix = `lineage-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let parentId: string | undefined;
  let childId: string | undefined;
  try {
    queryId = Number((await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'FR','EXPERIMENTAL','GENERAL',$1) RETURNING id`,
      [suffix],
    )).rows[0].id);
    parentId = String((await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,
         retrieval_lane,search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,
         provider_allocation_snapshot,continuation_segment,pages_completed)
       VALUES($1,'FR','automated_query','COMPLETED','BASELINE','lineage','VIDEO','RELEVANCE',
         'youtube-search','YOUTUBE_NATIVE','SEARCH_YOUTUBE','YOUTUBE_DATA_API',$2::jsonb,0,2)
       RETURNING id`,
      [queryId, JSON.stringify({ providerKey: 'youtube-search', retrievalSurface: 'YOUTUBE_NATIVE', capability: 'SEARCH_YOUTUBE', costDomain: 'YOUTUBE_DATA_API', continuationOwner: 'PHASE_9' })],
    )).rows[0].id);
    childId = String((await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,
         retrieval_lane,search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,
         provider_allocation_snapshot,continuation_segment,pages_completed,continued_from_run_id)
       VALUES($1,'FR','automated_query','RUNNING','BASELINE','lineage child','VIDEO','RELEVANCE',
         'youtube-search','YOUTUBE_NATIVE','SEARCH_YOUTUBE','YOUTUBE_DATA_API',$2::jsonb,1,0,$3)
       RETURNING id`,
      [queryId, JSON.stringify({ providerKey: 'youtube-search', retrievalSurface: 'YOUTUBE_NATIVE', capability: 'SEARCH_YOUTUBE', costDomain: 'YOUTUBE_DATA_API', continuationOwner: 'PHASE_9' }), parentId],
    )).rows[0].id);
    await db.query(
      `INSERT INTO autonomous_query_page_observations(
         query_run_id,page_number,retrieval_lane,distinct_creator_count,marginal_utility,
         decision_reason_codes,primary_reason,should_continue,page_metrics,continuation_decision_v2
       ) VALUES
         ($1,1,'VIDEO',10,0.1,'["ZERO_CONFIRMED_VALUE","CONTINUE_GRACE"]'::jsonb,'CONTINUE_GRACE',true,'{}'::jsonb,$2::jsonb),
         ($1,2,'VIDEO',10,0.05,'["ZERO_CONFIRMED_VALUE","MARGINAL_VALUE_LOW"]'::jsonb,'MARGINAL_VALUE_LOW',false,'{}'::jsonb,$3::jsonb)`,
      [parentId, v2('CONTINUE_GRACE', ['ZERO_CONFIRMED_VALUE', 'CONTINUE_GRACE'], 1), v2('MARGINAL_VALUE_LOW', ['ZERO_CONFIRMED_VALUE', 'MARGINAL_VALUE_LOW'], 2)],
    );
    const state = await getAutonomousContinuationState(childId, 1);
    assert.ok(state.v2Streaks.lowValue >= 2, 'child page 1 must see the parent trailing low-value streak');
  } finally {
    if (parentId) await db.query('DELETE FROM autonomous_query_page_observations WHERE query_run_id=ANY($1::uuid[])', [[parentId, childId].filter(Boolean)]).catch(() => undefined);
    if (childId) await db.query('DELETE FROM query_runs WHERE id=$1', [childId]).catch(() => undefined);
    if (parentId) await db.query('DELETE FROM query_runs WHERE id=$1', [parentId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});

maybe('admission review keeps a provisional low-value stop non-terminal before settlement', async () => {
  const db = await getDb();
  const suffix = `review-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let runId: string | undefined;
  try {
    queryId = Number((await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'FR','EXPERIMENTAL','GENERAL',$1) RETURNING id`,
      [suffix],
    )).rows[0].id);
    runId = String((await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,
         retrieval_lane,search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,
         provider_allocation_snapshot,continuation_segment,pages_completed)
       VALUES($1,'FR','automated_query','RUNNING','BASELINE','review','VIDEO','RELEVANCE',
         'youtube-search','YOUTUBE_NATIVE','SEARCH_YOUTUBE','YOUTUBE_DATA_API',$2::jsonb,0,1)
       RETURNING id`,
      [queryId, JSON.stringify({ providerKey: 'youtube-search', retrievalSurface: 'YOUTUBE_NATIVE', capability: 'SEARCH_YOUTUBE', costDomain: 'YOUTUBE_DATA_API', continuationOwner: 'PHASE_9' })],
    )).rows[0].id);
    await db.query(
      `INSERT INTO autonomous_query_page_observations(
         query_run_id,page_number,retrieval_lane,should_continue,primary_reason,stopping_reason,
         decision_reason_codes,page_metrics,continuation_decision_v2
       ) VALUES($1,1,'VIDEO',false,'MARGINAL_VALUE_LOW','MARGINAL_VALUE_LOW',
         '["ZERO_CONFIRMED_VALUE","MARGINAL_VALUE_LOW"]'::jsonb,'{}'::jsonb,$2::jsonb)`,
      [runId, v2('MARGINAL_VALUE_LOW', ['ZERO_CONFIRMED_VALUE', 'MARGINAL_VALUE_LOW'], 2)],
    );
    assert.equal(await markAutonomousPageDeferredForAdmissionReview(runId, 1), true);
    const row = (await db.query(
      `SELECT should_continue,stopping_reason,deferred_reason,decision_reason_codes
         FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=1`,
      [runId],
    )).rows[0];
    assert.equal(row.should_continue, false);
    assert.equal(row.stopping_reason, 'MARGINAL_VALUE_LOW');
    assert.equal(row.deferred_reason, 'ADMISSION');
    assert.ok(row.decision_reason_codes.includes('ADMISSION_PENDING_WAIT'));
  } finally {
    if (runId) await db.query('DELETE FROM autonomous_query_page_observations WHERE query_run_id=$1', [runId]).catch(() => undefined);
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});

maybe('settled productive review clears the provisional low-value streak', async () => {
  const db = await getDb();
  const suffix = `settle-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let runId: string | undefined;
  try {
    queryId = Number((await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'FR','EXPERIMENTAL','GENERAL',$1) RETURNING id`,
      [suffix],
    )).rows[0].id);
    runId = String((await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,
         retrieval_lane,search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,
         provider_allocation_snapshot,continuation_segment,pages_completed)
       VALUES($1,'FR','automated_query','RUNNING','BASELINE','settle','VIDEO','RELEVANCE',
         'youtube-search','YOUTUBE_NATIVE','SEARCH_YOUTUBE','YOUTUBE_DATA_API',$2::jsonb,0,1)
       RETURNING id`,
      [queryId, JSON.stringify({ providerKey: 'youtube-search', retrievalSurface: 'YOUTUBE_NATIVE', capability: 'SEARCH_YOUTUBE', costDomain: 'YOUTUBE_DATA_API', continuationOwner: 'PHASE_9' })],
    )).rows[0].id);
    await db.query(
      `INSERT INTO autonomous_query_page_observations(
         query_run_id,page_number,retrieval_lane,should_continue,primary_reason,stopping_reason,
         decision_reason_codes,page_metrics,continuation_decision_v2,deferred_reason
       ) VALUES($1,1,'VIDEO',false,'LOW_NOVELTY_PROBE','LOW_NOVELTY_PROBE',
         '["LOW_NOVELTY_PROBE"]'::jsonb,'{}'::jsonb,$2::jsonb,'ADMISSION')`,
      [runId, v2('LOW_NOVELTY_PROBE', ['LOW_NOVELTY_PROBE'], 1)],
    );
    assert.equal(await settleAutonomousPageAdmissionDeferral(runId, 1, true, null, [], true), true);
    const row = (await db.query(
      `SELECT should_continue,stopping_reason,deferred_reason,decision_reason_codes,continuation_decision_v2
         FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=1`,
      [runId],
    )).rows[0];
    assert.equal(row.should_continue, true);
    assert.equal(row.stopping_reason, null);
    assert.equal(row.deferred_reason, null);
    assert.ok(row.decision_reason_codes.includes('CONTINUE_PRODUCTIVE'));
    assert.equal(row.continuation_decision_v2.lowValue, false);
    assert.equal(row.continuation_decision_v2.streaks.lowValue, 0);
    const state = await getAutonomousContinuationState(runId, 2);
    assert.equal(state.v2Streaks.lowValue, 0, 'the next page must not inherit the provisional streak');
  } finally {
    if (runId) await db.query('DELETE FROM autonomous_query_page_observations WHERE query_run_id=$1', [runId]).catch(() => undefined);
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});
