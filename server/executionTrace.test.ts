import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { routePolicyInventory } from './operatorAuth';
import { persistExecutionStage } from './executionTrace';

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

test('provider-targeted canary cycles are admin-gated and use the governed authority path',()=>{
  const server=fs.readFileSync(new URL('../server.ts',import.meta.url),'utf8');
  const autonomous=fs.readFileSync(new URL('./autonomousDiscovery.ts',import.meta.url),'utf8');
  const authority=fs.readFileSync(new URL('./creatorIntelligence/authority.ts',import.meta.url),'utf8');
  assert.match(server,/req\.operator\?\.role !== 'admin'/);
  assert.match(server,/providerKey !== 'brave-search' \|\| capability !== 'SEARCH_BRAVE_DIRECT'/);
  assert.match(server,/runAutonomousDiscoveryCycle\(country, providerTargetRequested/);
  assert.match(server,/Number\(maxRuns\) !== 1/);
  assert.match(autonomous,/targetProviderKey: providerTarget\?\.targetProviderKey/);
  assert.match(autonomous,/Math\.min\(calculatedCapacity, Math\.max\(1, Math\.floor\(providerTarget\.maxRuns\)\)\)/);
  assert.match(authority,/targetProviderKey: input\.targetProviderKey/);
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

test('execution tracing degrades gracefully only when its table is missing',async()=>{
  const missing={query:async()=>{throw Object.assign(new Error('relation does not exist'),{code:'42P01'});}};
  assert.equal(await persistExecutionStage(missing,'00000000-0000-0000-0000-000000000001','HTTP_HANDLER','REACHED',{}),false);

  const unavailable={query:async()=>{throw Object.assign(new Error('database unavailable'),{code:'08006'});}};
  await assert.rejects(()=>persistExecutionStage(unavailable,'00000000-0000-0000-0000-000000000001','HTTP_HANDLER','REACHED',{}),/database unavailable/);
});

test('claim tracing cannot participate in or roll back the durable job claim',()=>{
  const db=fs.readFileSync(new URL('./db.ts',import.meta.url),'utf8');
  const claim=db.slice(db.indexOf('export async function claimNextJob'),db.indexOf('export async function completeJob'));
  assert.ok(claim.indexOf("await client.query('COMMIT')") < claim.indexOf("INSERT INTO discovery_execution_trace"));
  assert.match(claim,/Claim trace unavailable; discovery claim remains committed/);
});

test('migration versions are unique and Railway runs them before application startup',()=>{
  const migrationNames=fs.readdirSync(new URL('./db/migrations/',import.meta.url)).filter(name=>name.endsWith('.sql'));
  const versions=migrationNames.map(name=>name.split('_')[0]);
  assert.equal(new Set(versions).size,versions.length);
  assert.ok(migrationNames.includes('034_discovery_execution_trace.sql'));
  const railway=JSON.parse(fs.readFileSync(new URL('../railway.json',import.meta.url),'utf8'));
  assert.equal(railway.deploy.startCommand,'npm run migrate && npm run start');
});
