import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContinuationRunSegment, getDb } from './db';

const databaseUrl = process.env.PHASE4_POSTGRES_URL;

test('continuation segment creation binds parent id as both text lineage and uuid lookup', () => {
  const source = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function createContinuationRunSegment');
  assert.ok(start >= 0, 'createContinuationRunSegment must exist');
  const body = source.slice(start, start + 4000);
  const insertStart = body.indexOf('INSERT INTO query_runs(');
  const insertEnd = body.indexOf('RETURNING id', insertStart);
  assert.ok(insertStart >= 0 && insertEnd > insertStart, 'continuation INSERT must exist');
  const insertSql = body.slice(insertStart, insertEnd);
  // The parent id feeds a text column (continued_from_run_id) and a uuid
  // primary-key lookup. They must be separate bound parameters; a single $1
  // with both uses produces PostgreSQL "uuid versus text".
  assert.match(insertSql, /\$1::text/);
  assert.match(insertSql, /WHERE id=\$6::uuid/);
  assert.doesNotMatch(insertSql, /WHERE id=\$1/);
});

test('Stage 4 PostgreSQL: continuation segment links parent and child without a uuid/text type error', { skip: databaseUrl ? false : 'PHASE4_POSTGRES_URL is required' }, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `continuation-${Date.now()}-${process.pid}`;
  let queryId: number | undefined;
  let parentId: string | undefined;
  let childId: string | undefined;
  try {
    queryId = (await db.query(
      `INSERT INTO query_library(query,country,collection,intent,normalized_query)
       VALUES($1,'FR','EXPERIMENTAL','GENERAL',$1) RETURNING id`, [suffix]
    )).rows[0].id;
    parentId = (await db.query(
      `INSERT INTO query_runs(query_id,country,source,status,selection_strategy,selection_reason,retrieval_lane,search_ordering,provider_key,continuation_segment)
       VALUES($1,'FR','automated_query','RUNNING','BASELINE','continuation test','VIDEO','RELEVANCE','youtube-search',0) RETURNING id`, [queryId]
    )).rows[0].id;

    const segment = await createContinuationRunSegment({
      parentRunId: parentId!,
      nextPageToken: 'next-page-token',
      resumeMode: 'TOKEN',
      explorationPagesRemaining: 2,
    });
    childId = segment.childRunId;
    assert.equal(segment.parentRunId, parentId);
    assert.equal(segment.segment, 1);

    const parent = (await db.query('SELECT continued_to_run_id, continuation_segment FROM query_runs WHERE id=$1', [parentId])).rows[0];
    const child = (await db.query('SELECT continued_from_run_id, continuation_segment, next_page_token, resume_mode FROM query_runs WHERE id=$1', [childId])).rows[0];
    assert.equal(parent.continued_to_run_id, childId);
    assert.equal(parent.continuation_segment, 0);
    assert.equal(child.continued_from_run_id, parentId);
    assert.equal(child.continuation_segment, 1);
    assert.equal(child.next_page_token, 'next-page-token');
    assert.equal(child.resume_mode, 'TOKEN');
  } finally {
    if (childId) await db.query('DELETE FROM query_runs WHERE id=$1', [childId]).catch(() => undefined);
    if (parentId) await db.query('DELETE FROM query_runs WHERE id=$1', [parentId]).catch(() => undefined);
    if (queryId) await db.query('DELETE FROM query_library WHERE id=$1', [queryId]).catch(() => undefined);
    await db.end();
  }
});
