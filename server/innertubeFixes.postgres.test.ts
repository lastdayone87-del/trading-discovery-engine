import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from './db';
import {
  createContinuationRunSegment,
  isInnertubeQuotaFallbackAvailable,
  retargetQuotaBlockedRunToInnertube,
} from './dbCore';
import { markAutonomousPageDeferredForAdmission } from './autonomousPageStore';
import { reconcileAdmissionSightings } from './channelAdmission/store';
import { YOUTUBE_INNERTUBE_PROVIDER } from './youtubeInnertubeProvider';

const databaseUrl = process.env.INNERTUBE_FIX_POSTGRES_URL || process.env.PHASE4_POSTGRES_URL;
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.PGSSL = 'disable';
}
const maybe = databaseUrl ? test : test.skip;

const OFFICIAL_PROVIDER = {
  providerKey: 'youtube-search',
  retrievalSurface: 'YOUTUBE_NATIVE',
  capability: 'SEARCH_YOUTUBE',
  costDomain: 'YOUTUBE_DATA_API',
  continuationOwner: 'PHASE_9' as const,
};

async function insertQuery(db: Awaited<ReturnType<typeof getDb>>, suffix: string): Promise<number> {
  return Number((await db.query(
    `INSERT INTO query_library(query,country,collection,intent,normalized_query)
     VALUES($1,'FR','EXPERIMENTAL','GENERAL',$1) RETURNING id`,
    [`innertube-fix-${suffix}`],
  )).rows[0].id);
}

async function insertRun(
  db: Awaited<ReturnType<typeof getDb>>,
  queryId: number,
  suffix: string,
  overrides: { pagesCompleted?: number; provider?: typeof OFFICIAL_PROVIDER } = {},
): Promise<string> {
  const provider = overrides.provider || OFFICIAL_PROVIDER;
  return String((await db.query(
    `INSERT INTO query_runs(
       query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,
       search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,
       provider_allocation_snapshot,continuation_segment,pages_completed,quota_reserved,
       allocation_origin,metadata
     ) VALUES($1,'FR','automated_query','SCHEDULED','BASELINE',$2,'VIDEO','RELEVANCE',
       $3,$4,$5,$6,$7::jsonb,0,$8,$9,'LEGACY','{}'::jsonb) RETURNING id`,
    [
      queryId, suffix, provider.providerKey, provider.retrievalSurface,
      provider.capability, provider.costDomain, JSON.stringify(provider),
      overrides.pagesCompleted || 0,
      provider.costDomain === 'YOUTUBE_DATA_API' ? 100 : 0,
    ],
  )).rows[0].id);
}

maybe('admission reconciliation rewrites the original discovery sighting', async () => {
  const db = await getDb();
  const suffix = `reconcile-${Date.now()}-${process.pid}`;
  const channelId = `UC${suffix.replace(/\W/g, '').slice(-22)}`.padEnd(24, 'x').slice(0, 24);
  let queryId: number | undefined;
  let runId: string | undefined;
  let candidateId: string | undefined;
  try {
    queryId = await insertQuery(db, suffix);
    runId = await insertRun(db, queryId, suffix);
    candidateId = String((await db.query(
      `INSERT INTO semantic_admission_candidates(
         candidate_key,channel_id,channel_name,youtube_url,source,query_id,query_run_id,
         page_number,result_rank,target_country,status
       ) VALUES($1,$2,'Trader','https://youtube.com/channel/x','automated_query',$3,$4,1,1,'France','PENDING')
       RETURNING id`,
      [`admission:${channelId}:v1`, channelId, queryId, runId],
    )).rows[0].id);
    await db.query(
      `INSERT INTO semantic_admission_sightings(candidate_id,query_run_id,page_number,result_rank)
       VALUES($1,$2,1,1)`,
      [candidateId, runId],
    );
    await db.query(
      `INSERT INTO channel_sightings(
         query_run_id,query_id,channel_id,result_rank,search_lane,page_number,was_known,
         persisted,country_outcome,trading_outcome,funnel_outcome,metadata
       ) VALUES($1,$2,$3,1,'VIDEO',1,false,false,'UNCERTAIN','UNCERTAIN','UNCERTAIN','{}'::jsonb)`,
      [runId, queryId, channelId],
    );

    const updated = await reconcileAdmissionSightings({ candidateId, channelId, status: 'ADMITTED' });
    assert.equal(updated, 1);
    const row = (await db.query(
      `SELECT persisted,funnel_outcome,metadata FROM channel_sightings WHERE query_run_id=$1 AND channel_id=$2`,
      [runId, channelId],
    )).rows[0];
    assert.equal(row.persisted, true);
    assert.equal(row.funnel_outcome, 'CLASSIFICATION_PENDING');
    assert.equal(row.metadata.admissionStatus, 'ADMITTED');

    const rejected = await reconcileAdmissionSightings({ candidateId, channelId, status: 'REJECTED_COUNTRY' });
    assert.equal(rejected, 1);
    const rejectedRow = (await db.query(
      `SELECT persisted,funnel_outcome,country_outcome FROM channel_sightings WHERE query_run_id=$1 AND channel_id=$2`,
      [runId, channelId],
    )).rows[0];
    assert.equal(rejectedRow.persisted, false);
    assert.equal(rejectedRow.funnel_outcome, 'COUNTRY_REJECTED');
    assert.equal(rejectedRow.country_outcome, 'REJECTED');
  } finally {
    if (runId) await db.query('DELETE FROM channel_sightings WHERE query_run_id=$1', [runId]).catch(() => undefined);
    if (candidateId) {
      await db.query('DELETE FROM semantic_admission_sightings WHERE candidate_id=$1', [candidateId]).catch(() => undefined);
      await db.query('DELETE FROM semantic_admission_candidates WHERE id=$1', [candidateId]).catch(() => undefined);
    }
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});

maybe('a review-held sighting becomes persisted when the operator later admits', async () => {
  const db = await getDb();
  const suffix = `review-admit-${Date.now()}-${process.pid}`;
  const channelId = `UC${suffix.replace(/\W/g, '').slice(-22)}`.padEnd(24, 'x').slice(0, 24);
  let queryId: number | undefined;
  let runId: string | undefined;
  let candidateId: string | undefined;
  try {
    queryId = await insertQuery(db, suffix);
    runId = await insertRun(db, queryId, suffix);
    candidateId = String((await db.query(
      `INSERT INTO semantic_admission_candidates(
         candidate_key,channel_id,channel_name,youtube_url,source,query_id,query_run_id,
         page_number,result_rank,target_country,status
       ) VALUES($1,$2,'Trader','https://youtube.com/channel/x','automated_query',$3,$4,1,1,'France','NEEDS_REVIEW')
       RETURNING id`,
      [`admission:${channelId}:v1`, channelId, queryId, runId],
    )).rows[0].id);
    await db.query(
      `INSERT INTO semantic_admission_sightings(candidate_id,query_run_id,page_number,result_rank)
       VALUES($1,$2,1,1)`,
      [candidateId, runId],
    );
    await db.query(
      `INSERT INTO channel_sightings(
         query_run_id,query_id,channel_id,result_rank,search_lane,page_number,was_known,
         persisted,country_outcome,trading_outcome,funnel_outcome,metadata
       ) VALUES($1,$2,$3,1,'VIDEO',1,false,false,'UNCERTAIN','UNCERTAIN','UNCERTAIN','{}'::jsonb)`,
      [runId, queryId, channelId],
    );
    const { reconcileAdmissionSightings } = await import('./channelAdmission/store');
    assert.equal(await reconcileAdmissionSightings({ candidateId, channelId, status: 'NEEDS_REVIEW' }), 1);
    assert.equal(await reconcileAdmissionSightings({ candidateId, channelId, status: 'ADMITTED' }), 1);
    const row = (await db.query(
      `SELECT persisted,funnel_outcome,metadata FROM channel_sightings WHERE query_run_id=$1 AND channel_id=$2`,
      [runId, channelId],
    )).rows[0];
    assert.equal(row.persisted, true);
    assert.equal(row.funnel_outcome, 'CLASSIFICATION_PENDING');
    assert.equal(row.metadata.admissionStatus, 'ADMITTED');
  } finally {
    if (runId) await db.query('DELETE FROM channel_sightings WHERE query_run_id=$1', [runId]).catch(() => undefined);
    if (candidateId) {
      await db.query('DELETE FROM semantic_admission_sightings WHERE candidate_id=$1', [candidateId]).catch(() => undefined);
      await db.query('DELETE FROM semantic_admission_candidates WHERE id=$1', [candidateId]).catch(() => undefined);
    }
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});

maybe('early terminal admission verdict is replayed after the sighting insert', async () => {
  const db = await getDb();
  const suffix = `replay-${Date.now()}-${process.pid}`;
  const channelId = `UC${suffix.replace(/\W/g, '').slice(-22)}`.padEnd(24, 'x').slice(0, 24);
  let queryId: number | undefined;
  let runId: string | undefined;
  let candidateId: string | undefined;
  try {
    queryId = await insertQuery(db, suffix);
    runId = await insertRun(db, queryId, suffix);
    candidateId = String((await db.query(
      `INSERT INTO semantic_admission_candidates(
         candidate_key,channel_id,channel_name,youtube_url,source,query_id,query_run_id,
         page_number,result_rank,target_country,status
       ) VALUES($1,$2,'Trader','https://youtube.com/channel/x','automated_query',$3,$4,2,3,'France','ADMITTED')
       RETURNING id`,
      [`admission:${channelId}:v1`, channelId, queryId, runId],
    )).rows[0].id);
    await db.query(
      `INSERT INTO semantic_admission_sightings(candidate_id,query_run_id,page_number,result_rank)
       VALUES($1,$2,2,3)`,
      [candidateId, runId],
    );
    await db.query(
      `INSERT INTO channel_sightings(
         query_run_id,query_id,channel_id,result_rank,search_lane,page_number,was_known,
         persisted,country_outcome,trading_outcome,funnel_outcome,metadata
       ) VALUES($1,$2,$3,3,'VIDEO',2,false,false,'UNCERTAIN','UNCERTAIN','UNCERTAIN','{}'::jsonb)`,
      [runId, queryId, channelId],
    );
    const { replayAdmissionOutcomesForPage } = await import('./channelAdmission/store');
    assert.equal(await replayAdmissionOutcomesForPage({ queryRunId: runId, pageNumber: 2 }), 1);
    const row = (await db.query(
      `SELECT persisted,funnel_outcome,metadata FROM channel_sightings WHERE query_run_id=$1 AND channel_id=$2`,
      [runId, channelId],
    )).rows[0];
    assert.equal(row.persisted, true);
    assert.equal(row.funnel_outcome, 'CLASSIFICATION_PENDING');
    assert.equal(row.metadata.admissionStatus, 'ADMITTED');
  } finally {
    if (runId) await db.query('DELETE FROM channel_sightings WHERE query_run_id=$1', [runId]).catch(() => undefined);
    if (candidateId) {
      await db.query('DELETE FROM semantic_admission_sightings WHERE candidate_id=$1', [candidateId]).catch(() => undefined);
      await db.query('DELETE FROM semantic_admission_candidates WHERE id=$1', [candidateId]).catch(() => undefined);
    }
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});

maybe('admission-pending page is re-opened for continuation, not recorded terminal', async () => {
  const db = await getDb();
  const suffix = `page-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let runId: string | undefined;
  try {
    queryId = await insertQuery(db, suffix);
    runId = await insertRun(db, queryId, suffix);
    await db.query(
      `INSERT INTO autonomous_query_page_observations(
         query_run_id,page_number,retrieval_lane,should_continue,primary_reason,
         stopping_reason,decision_reason_codes,page_metrics,continuation_decision_v2
       ) VALUES($1,1,'VIDEO',true,'ADMISSION_PENDING_WAIT',NULL,
         '["ADMISSION_PENDING_WAIT"]'::jsonb,'{}'::jsonb,'{}'::jsonb)`,
      [runId],
    );

    assert.equal(await markAutonomousPageDeferredForAdmission(runId, 1), true);
    let row = (await db.query(
      `SELECT should_continue,stopping_reason,deferred_reason,decision_reason_codes
         FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=1`,
      [runId],
    )).rows[0];
    assert.equal(row.should_continue, true);
    assert.equal(row.stopping_reason, null);
    assert.equal(row.deferred_reason, 'ADMISSION');
    assert.equal(row.decision_reason_codes.filter((code: string) => code === 'ADMISSION_PENDING_WAIT').length, 1);

    await markAutonomousPageDeferredForAdmission(runId, 1);
    row = (await db.query(
      `SELECT decision_reason_codes FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=1`,
      [runId],
    )).rows[0];
    assert.equal(row.decision_reason_codes.filter((code: string) => code === 'ADMISSION_PENDING_WAIT').length, 1);

    // A real terminal stop must never be reopened by an admission wait.
    await db.query(
      `UPDATE autonomous_query_page_observations
          SET should_continue=false,stopping_reason='PAGE_CEILING',deferred_reason=NULL
        WHERE query_run_id=$1 AND page_number=1`,
      [runId],
    );
    assert.equal(await markAutonomousPageDeferredForAdmission(runId, 1), false);
    row = (await db.query(
      `SELECT should_continue,stopping_reason,deferred_reason
         FROM autonomous_query_page_observations WHERE query_run_id=$1 AND page_number=1`,
      [runId],
    )).rows[0];
    assert.equal(row.should_continue, false);
    assert.equal(row.stopping_reason, 'PAGE_CEILING');
    assert.equal(row.deferred_reason, null);
  } finally {
    if (runId) await db.query('DELETE FROM autonomous_query_page_observations WHERE query_run_id=$1', [runId]).catch(() => undefined);
    if (runId) await db.query('DELETE FROM query_runs WHERE id=$1', [runId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});

maybe('official first-page run retargets to InnerTube while completed runs must hand off', async () => {
  const db = await getDb();
  const suffix = `retarget-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let freshRunId: string | undefined;
  let completedRunId: string | undefined;
  let jobId: string | undefined;
  let pausedRunId: string | undefined;
  let pausedJobId: string | undefined;
  try {
    queryId = await insertQuery(db, suffix);
    freshRunId = await insertRun(db, queryId, `${suffix}-fresh`);
    jobId = String((await db.query(
      `INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key)
       VALUES('SEARCH_YOUTUBE',$1::jsonb,20,3,$2) RETURNING id`,
      [JSON.stringify({ queryRunId: freshRunId, provider: OFFICIAL_PROVIDER, pageNumber: 1, pageToken: null }), `test-retarget-${suffix}`],
    )).rows[0].id);

    assert.equal(await retargetQuotaBlockedRunToInnertube({
      runId: freshRunId,
      jobId,
      provider: YOUTUBE_INNERTUBE_PROVIDER,
    }), true);
    const run = (await db.query(
      `SELECT provider_key,cost_domain,quota_reserved,resume_mode,next_page_token,provider_cursor
         FROM query_runs WHERE id=$1`,
      [freshRunId],
    )).rows[0];
    assert.equal(run.provider_key, 'youtube-innertube');
    assert.equal(run.cost_domain, 'YOUTUBE_INNERTUBE_FREE');
    assert.equal(Number(run.quota_reserved), 0);
    assert.equal(run.resume_mode, 'REWALK');
    assert.equal(run.next_page_token, null);
    assert.equal(run.provider_cursor.quotaFallbackFrom, 'youtube-search');
    const job = (await db.query(`SELECT payload FROM jobs WHERE id=$1`, [jobId])).rows[0];
    assert.equal(job.payload.provider.providerKey, 'youtube-innertube');
    assert.equal(job.payload.pageNumber, 1);
    assert.equal(job.payload.pageToken, null);

    completedRunId = await insertRun(db, queryId, `${suffix}-completed`, { pagesCompleted: 2 });
    const completedJobId = String((await db.query(
      `INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key)
       VALUES('SEARCH_YOUTUBE',$1::jsonb,20,3,$2) RETURNING id`,
      [JSON.stringify({ queryRunId: completedRunId, provider: OFFICIAL_PROVIDER, pageNumber: 3 }), `test-retarget-completed-${suffix}`],
    )).rows[0].id);
    assert.equal(await retargetQuotaBlockedRunToInnertube({
      runId: completedRunId,
      jobId: completedJobId,
      provider: YOUTUBE_INNERTUBE_PROVIDER,
    }), false);
    const completed = (await db.query(`SELECT provider_key FROM query_runs WHERE id=$1`, [completedRunId])).rows[0];
    assert.equal(completed.provider_key, 'youtube-search');
    await db.query('DELETE FROM jobs WHERE id=$1', [completedJobId]).catch(() => undefined);
    await assert.rejects(
      db.query(`UPDATE query_runs SET provider_key='youtube-innertube',cost_domain='YOUTUBE_INNERTUBE_FREE',
                       provider_allocation_snapshot=$2::jsonb WHERE id=$1`,
        [completedRunId, JSON.stringify(YOUTUBE_INNERTUBE_PROVIDER)]),
      /IMMUTABLE_QUERY_RUN_PROVIDER_LINEAGE/,
    );

    // A continuation child already owns a non-page-1 cursor. Retargeting it
    // would clear the cursor and re-walk the parent's results.
    const childRunId = await insertRun(db, queryId, `${suffix}-child`);
    await db.query(`UPDATE query_runs SET continued_from_run_id=$2 WHERE id=$1`, [childRunId, freshRunId]);
    const childJobId = String((await db.query(
      `INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key)
       VALUES('SEARCH_YOUTUBE',$1::jsonb,20,3,$2) RETURNING id`,
      [JSON.stringify({ queryRunId: childRunId, provider: OFFICIAL_PROVIDER, pageNumber: 1 }), `test-retarget-child-${suffix}`],
    )).rows[0].id);
    assert.equal(await retargetQuotaBlockedRunToInnertube({
      runId: childRunId,
      jobId: childJobId,
      provider: YOUTUBE_INNERTUBE_PROVIDER,
    }), false);
    await db.query('DELETE FROM jobs WHERE id=$1', [childJobId]).catch(() => undefined);
    await db.query('DELETE FROM query_runs WHERE id=$1', [childRunId]).catch(() => undefined);

    // A PAUSED/SHADOW/RETIRED registry row must disable the fallback.
    assert.equal(await isInnertubeQuotaFallbackAvailable(), true);
    pausedRunId = await insertRun(db, queryId, `${suffix}-paused`);
    pausedJobId = String((await db.query(
      `INSERT INTO jobs(type,payload,priority,max_attempts,idempotency_key)
       VALUES('SEARCH_YOUTUBE',$1::jsonb,20,3,$2) RETURNING id`,
      [JSON.stringify({ queryRunId: pausedRunId, provider: OFFICIAL_PROVIDER, pageNumber: 1 }), `test-retarget-paused-${suffix}`],
    )).rows[0].id);
    await db.query(`UPDATE discovery_provider_registry SET mode='PAUSED' WHERE provider_key='youtube-innertube'`);
    try {
      assert.equal(await isInnertubeQuotaFallbackAvailable(), false);
      assert.equal(await retargetQuotaBlockedRunToInnertube({
        runId: pausedRunId,
        jobId: pausedJobId,
        provider: YOUTUBE_INNERTUBE_PROVIDER,
      }), false);
    } finally {
      await db.query(`UPDATE discovery_provider_registry SET mode='ACTIVE' WHERE provider_key='youtube-innertube'`);
    }
  } finally {
    if (jobId) await db.query('DELETE FROM jobs WHERE id=$1', [jobId]).catch(() => undefined);
    if (pausedJobId) await db.query('DELETE FROM jobs WHERE id=$1', [pausedJobId]).catch(() => undefined);
    if (freshRunId) await db.query('DELETE FROM query_runs WHERE id=$1', [freshRunId]).catch(() => undefined);
    if (pausedRunId) await db.query('DELETE FROM query_runs WHERE id=$1', [pausedRunId]).catch(() => undefined);
    if (completedRunId) await db.query('DELETE FROM query_runs WHERE id=$1', [completedRunId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});

maybe('completed official run hands off to an InnerTube continuation child with zero quota', async () => {
  const db = await getDb();
  const suffix = `handoff-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let parentId: string | undefined;
  let childId: string | undefined;
  try {
    queryId = await insertQuery(db, suffix);
    parentId = await insertRun(db, queryId, suffix, { pagesCompleted: 2 });
    const segment = await createContinuationRunSegment({
      parentRunId: parentId,
      nextPageToken: '3',
      resumeMode: 'REWALK',
      explorationPagesRemaining: 1,
      providerOverride: YOUTUBE_INNERTUBE_PROVIDER,
      metadataPatch: { providerQuotaFallback: { fromProvider: 'youtube-search' } },
    });
    childId = segment.childRunId;
    const parent = (await db.query(`SELECT continued_to_run_id,next_page_token,resume_mode FROM query_runs WHERE id=$1`, [parentId])).rows[0];
    const child = (await db.query(
      `SELECT provider_key,cost_domain,quota_reserved,next_page_token,resume_mode,metadata,continued_from_run_id
         FROM query_runs WHERE id=$1`,
      [childId],
    )).rows[0];
    assert.equal(parent.continued_to_run_id, childId);
    assert.equal(parent.next_page_token, '3');
    assert.equal(parent.resume_mode, 'REWALK');
    assert.equal(child.provider_key, 'youtube-innertube');
    assert.equal(child.cost_domain, 'YOUTUBE_INNERTUBE_FREE');
    assert.equal(Number(child.quota_reserved), 0);
    assert.equal(child.next_page_token, '3');
    assert.equal(child.resume_mode, 'REWALK');
    assert.equal(child.metadata.providerQuotaFallback.fromProvider, 'youtube-search');
    assert.equal(child.continued_from_run_id, parentId);
  } finally {
    if (childId) await db.query('DELETE FROM query_runs WHERE id=$1', [childId]).catch(() => undefined);
    if (parentId) await db.query('DELETE FROM query_runs WHERE id=$1', [parentId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
  }
});
