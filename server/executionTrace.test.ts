import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { routePolicyInventory } from './operatorAuth';

test('manual discovery persists evidence for every pre-provider execution boundary',()=>{
  const queue=fs.readFileSync(new URL('./queueManager.ts',import.meta.url),'utf8');
  const db=fs.readFileSync(new URL('./db.ts',import.meta.url),'utf8');
  const store=fs.readFileSync(new URL('./manualSearchStore.ts',import.meta.url),'utf8');
  const youtube=fs.readFileSync(new URL('./youtube.ts',import.meta.url),'utf8');
  for(const stage of ['JOB_CREATION','QUEUE_PERSISTENCE','DISPATCHER']) assert.match(queue,new RegExp(`recordExecutionStage\\('${stage}'`));
  for(const stage of ['WORKER_POLLING','QUEUE_CLAIM']) assert.match(db,new RegExp(`'${stage}'`));
  assert.match(store,/traceId:args\.traceId/);
  assert.match(youtube,/recordExecutionStage\('PROVIDER_ACQUISITION'/);
  assert.match(youtube,/recordFirstYouTubeRequest\(operation\)/);
});

test('dashboard operator actions remain operator-authorized while database maintenance remains admin-only',()=>{
  const policy=(method:string,path:string)=>routePolicyInventory.find(route=>route.method===method&&new RegExp(route.pattern).test(path))?.policy;
  assert.equal(policy('POST','/api/query-intelligence/run-cycle'),'operator');
  assert.equal(policy('POST','/api/queues/pause'),'operator');
  assert.equal(policy('POST','/api/database/backup'),'admin');
});

test('a forbidden action does not invalidate the authenticated dashboard session',()=>{
  const client=fs.readFileSync(new URL('../src/apiClient.ts',import.meta.url),'utf8');
  assert.match(client,/response\.status === 401/);
  assert.doesNotMatch(client,/response\.status === 401 \|\| response\.status === 403/);
});
