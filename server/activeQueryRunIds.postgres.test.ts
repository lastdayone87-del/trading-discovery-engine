import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getActiveQueryRunQueryIds, getDb } from './db';

const databaseUrl = process.env.PHASE4_POSTGRES_URL;

test('Stage 4 PostgreSQL: a completed-job orphan is selectable but deferred and live runs stay active', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `active-runs-${Date.now()}-${process.pid}`;
  const queryIds: number[] = [];
  const jobIds: string[] = [];
  const runIds: string[] = [];
  try {
    const insertQuery = async (label: string) => {
      const id = (await db.query(
        `INSERT INTO query_library(query,country,collection,intent,normalized_query)
         VALUES($1,'FR','EXPERIMENTAL','GENERAL',$1) RETURNING id`, [`${suffix}-${label}`]
      )).rows[0].id as number;
      queryIds.push(id);
      return id;
    };
    const insertJob = async (status: 'COMPLETED' | 'PENDING', completedAt: string | null) => {
      const id = randomUUID();
      jobIds.push(id);
      await db.query(
        `INSERT INTO jobs(id,type,status,payload,attempts,max_attempts,run_after,completed_at)
         VALUES($1,'SEARCH_YOUTUBE',$2,'{}'::jsonb,0,3,now(),$3)`,
        [id, status, completedAt]
      );
      return id;
    };
    const insertRun = async (queryId: number, jobId: string, continuationStatus: string | null, deferredUntil: string | null) => {
      const id = randomUUID();
      runIds.push(id);
      await db.query(
        `INSERT INTO query_runs(id,query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,provider_key,retrieval_surface,provider_capability,cost_domain,provider_allocation_snapshot,job_id,continuation_status,deferred_until,continuation_segment)
         VALUES($1,$2,'FR','automated_query','RUNNING','BASELINE','active-run test','VIDEO','RELEVANCE','youtube-search','YOUTUBE_NATIVE','SEARCH_YOUTUBE','YOUTUBE_DATA_API',$3::jsonb,$4,$5,$6,0)`,
        [id, queryId, JSON.stringify({ providerKey: 'youtube-search', retrievalSurface: 'YOUTUBE_NATIVE', capability: 'SEARCH_YOUTUBE', costDomain: 'YOUTUBE_DATA_API', continuationOwner: 'PHASE_9' }), jobId, continuationStatus || 'RUNNING', deferredUntil]
      );
      return id;
    };

    const orphanQuery = await insertQuery('orphan');
    await insertRun(orphanQuery, await insertJob('COMPLETED', new Date(Date.now() - 30 * 60_000).toISOString()), null, null);
    const liveQuery = await insertQuery('live');
    await insertRun(liveQuery, await insertJob('COMPLETED', new Date(Date.now() - 60_000).toISOString()), null, null);
    const deferredQuery = await insertQuery('deferred');
    await insertRun(deferredQuery, await insertJob('COMPLETED', new Date(Date.now() - 30 * 60_000).toISOString()), 'DEFERRED_QUOTA', new Date(Date.now() + 60 * 60_000).toISOString());
    const pendingQuery = await insertQuery('pending');
    await insertRun(pendingQuery, await insertJob('PENDING', null), null, null);

    const active = new Set(await getActiveQueryRunQueryIds('FR'));
    assert.equal(active.has(orphanQuery), false, 'a non-deferred completed-job orphan must be selectable for reconciliation');
    assert.equal(active.has(liveQuery), true, 'a completed job inside the grace window still owns its run');
    assert.equal(active.has(deferredQuery), true, 'a deferred run is owned by the resume sweep, not the selector');
    assert.equal(active.has(pendingQuery), true, 'a pending job owns its run');
  } finally {
    if (runIds.length) await db.query('DELETE FROM query_runs WHERE id=ANY($1::uuid[])', [runIds]).catch(() => undefined);
    if (jobIds.length) await db.query('DELETE FROM jobs WHERE id=ANY($1::uuid[])', [jobIds]).catch(() => undefined);
    if (queryIds.length) await db.query('DELETE FROM query_library WHERE id=ANY($1::int[])', [queryIds]).catch(() => undefined);
    await db.end();
  }
});
