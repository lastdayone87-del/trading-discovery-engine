import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {getDb,listChannelsPage,getChannelListingRevision,getDashboardOperationalSummary,persistDiscordCandidates,appendDiscordCheckAttempts,selectDiscordCandidate} from './db';

const enabled=Boolean(process.env.DATABASE_URL);
const maybe=enabled?test:test.skip;
const ids=['confirmed','uncertain','nontrading','rejected','skipped','low','pending','enriching','failed','review'];

maybe('real PostgreSQL master listing, KPI, filters, revision, pagination and candidate concurrency',async()=>{
  const db=await getDb();
  await db.query(`DELETE FROM discord_candidates; DELETE FROM discord_check_attempts; DELETE FROM channel_reviews; DELETE FROM channels`);
  const states=[
    ['confirmed','CONFIRMED','TRADING_CONFIRMED','COMPLETED','ACTIVE','100'],
    ['uncertain','UNCERTAIN','UNCERTAIN','PENDING','UNCERTAIN','100'],
    ['nontrading','CONFIRMED','NON_TRADING','SKIPPED_NON_TRADING','NON_TRADING','100'],
    ['rejected','REJECTED','UNCERTAIN','COMPLETED','NOT_FOUND','100'],
    ['skipped','CONFIRMED','UNCERTAIN','SKIPPED_EXCLUDED','NOT_FOUND','100'],
    ['low','CONFIRMED','TRADING_CONFIRMED','SKIPPED_LOW_AUDIENCE','NOT_FOUND','12'],
    ['pending','CONFIRMED','TRADING_CONFIRMED','ENRICHMENT_PENDING','PENDING','100'],
    ['enriching','CONFIRMED','TRADING_CONFIRMED','ENRICHING','PENDING','100'],
    ['failed','CONFIRMED','TRADING_CONFIRMED','FAILED','UNCERTAIN','100'],
    ['review','CONFIRMED','NEEDS_REVIEW','NEEDS_REVIEW','UNCERTAIN','100']
  ];
  for(const [id,country,trading,scan,discord,subs] of states)await db.query(`INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,trading_status,subscriber_count) VALUES($1,$2,$3,'Germany',$4,$5,$6,'automated_query',now(),$7,$8)`,[id,`Channel ${id}`,`https://youtube.test/${id}`,country,discord,scan,trading,subs]);
  const all=await listChannelsPage({limit:100,offset:0});
  assert.equal(all.total,ids.length); assert.deepEqual(new Set(all.items.map(x=>x.channel_id)),new Set(ids));
  const sqlCount=Number((await db.query('SELECT count(*)::int n FROM channels')).rows[0].n); assert.equal(all.total,sqlCount);
  assert.equal((await listChannelsPage({limit:100,offset:0,tradingStatus:'NON_TRADING'})).total,1);
  assert.equal((await listChannelsPage({limit:100,offset:0,scanStatus:'SKIPPED_LOW_AUDIENCE'})).total,1);
  assert.equal((await listChannelsPage({limit:100,offset:0,countryStatus:'REJECTED'})).total,1);
  assert.equal((await listChannelsPage({limit:100,offset:0,search:'low'})).total,1);
  assert.equal((await listChannelsPage({limit:3,offset:3})).total,ids.length);
  assert.equal((await getChannelListingRevision({scanStatus:'FAILED'})).total,1);
  assert.ok((await listChannelsPage({limit:100,offset:0,diagnosticsOnly:true})).total>0);
  const summary=await getDashboardOperationalSummary(); assert.equal(summary.storedChannels,sqlCount); assert.equal(summary.scope.storedChannels,'ALL_STORED_CHANNELS');

  await Promise.all([
    persistDiscordCandidates('confirmed',[{candidateId:'surface-a',rawLocator:'discord.gg/MixedCode',resolvedLocator:'https://discord.gg/MixedCode',locatorType:'NATIVE_INVITE',sourceSurface:'YOUTUBE_ABOUT'}]),
    persistDiscordCandidates('confirmed',[{candidateId:'surface-b',rawLocator:'discord.com/invite/mixedcode',resolvedLocator:'https://discord.gg/mixedcode',locatorType:'NATIVE_INVITE',sourceSurface:'CHANNEL_EXTERNAL_LINKS'}])
  ]);
  const equivalent=(await db.query(`SELECT source_observations FROM discord_candidates WHERE channel_id='confirmed'`)).rows;
  assert.equal(equivalent.length,1); assert.equal(equivalent[0].source_observations.length,2);
  const checked='2026-08-20T20:00:00.000Z';
  await Promise.all([
    appendDiscordCheckAttempts('confirmed','https://discord.gg/mixedcode','UNCERTAIN',[{attemptNumber:1,operationalOutcome:'TIMEOUT',retryable:true,reason:'timeout',checkedAt:checked}],{candidateId:'surface-a',resolvedLocator:'https://discord.gg/mixedcode'}),
    appendDiscordCheckAttempts('confirmed','https://discord.gg/other','ACTIVE',[{attemptNumber:1,operationalOutcome:'SUCCEEDED',retryable:false,reason:'active',checkedAt:checked}],{candidateId:'other',rawLocator:'discord.gg/other',resolvedLocator:'https://discord.gg/other',sourceSurface:'YOUTUBE_ABOUT'})
  ]);
  assert.equal(Number((await db.query(`SELECT count(*)::int n FROM discord_check_attempts WHERE channel_id='confirmed'`)).rows[0].n),2);
  const candidates=(await db.query(`SELECT * FROM discord_candidates WHERE channel_id='confirmed' ORDER BY normalized_locator`)).rows;
  assert.equal(candidates.length,2); assert.equal(candidates[0].attempt_count+candidates[1].attempt_count,2);
  assert.ok(candidates.some(c=>c.relevance_status==='TRADING_RELEVANT'&&c.liveness_status==='ACTIVE'));
  await selectDiscordCandidate('confirmed','other');
  assert.equal((await db.query(`SELECT candidate_id FROM discord_candidates WHERE channel_id='confirmed' AND selected`)).rows[0].candidate_id,'other');
  const api=await listChannelsPage({limit:100,offset:0,search:'confirmed'}); assert.equal(api.items[0].discord_candidates?.length,2);
});

after(async()=>{if(enabled)(await getDb()).end();});
