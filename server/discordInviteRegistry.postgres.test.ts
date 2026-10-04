import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type pg from 'pg';
import { getDb, claimDiscordInvites } from './db';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;
const CH = ['rgchan1', 'rgchan2', 'rgchan3'];
type Db = Awaited<ReturnType<typeof getDb>>;

async function cleanup(db: Db) {
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code LIKE 'rgtest%'`);
  await db.query(`DELETE FROM discord_candidates WHERE channel_id = ANY($1)`, [CH]);
  await db.query(`DELETE FROM channels WHERE channel_id = ANY($1)`, [CH]);
}

maybe('registry migration applies idempotently with earliest-wins backfill', async () => {
  const db = await getDb();
  const sql = fs.readFileSync(new URL('./db/migrations/138_discord_invite_registry.sql', import.meta.url), 'utf8');
  await db.query(sql);
  await db.query(sql);
  await cleanup(db);
  for (const id of CH) {
    await db.query(
      `INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,trading_status,subscriber_count) VALUES($1,$2,$3,'Germany','CONFIRMED','NOT_FOUND','ENRICHING','automated_query',now(),'UNCERTAIN','100') ON CONFLICT DO NOTHING`,
      [id, `RG ${id}`, `https://youtube.test/${id}`],
    );
  }
  await db.query(
    `INSERT INTO discord_candidates(channel_id,candidate_id,raw_locator,normalized_locator) VALUES('rgchan2','x','https://discord.gg/rgtestABC','https://discord.gg/rgtestabc'),('rgchan1','x','https://discord.gg/rgtestABC','https://discord.gg/rgtestabc'),('rgchan3','y','https://discord.com/invite/rgtestXYZ','https://discord.com/invite/rgtestXYZ')`,
  );
  await db.query(`UPDATE discord_candidates SET discovered_at=now()-interval '2 hours' WHERE channel_id='rgchan1'`);
  await db.query(sql);
  const rows = await db.query(`SELECT canonical_code,first_channel_id FROM discord_invite_registry WHERE canonical_code LIKE 'rgtest%' ORDER BY 1`);
  assert.deepEqual(rows.rows, [
    { canonical_code: 'rgtestabc', first_channel_id: 'rgchan1' },
    { canonical_code: 'rgtestxyz', first_channel_id: 'rgchan3' },
  ]);
  // Historical attempt timestamps beat row creation time: an earlier check
  // attempt for rgchan2 redates its discovery before rgchan1's row.
  await db.query(
    `INSERT INTO discord_check_attempts(attempt_key,channel_id,invite_locator,semantic_status,operational_outcome,retryable,attempt_number,reason,checked_at) VALUES('rg-attempt-1','rgchan2','https://discord.gg/rgtestABC','ACTIVE','SUCCEEDED',false,1,'ok',now()-interval '3 hours')`,
  );
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code LIKE 'rgtest%'`);
  await db.query(sql);
  const redated = await db.query(`SELECT canonical_code,first_channel_id,first_source_surface FROM discord_invite_registry WHERE canonical_code='rgtestabc'`);
  assert.equal(redated.rows[0].first_channel_id, 'rgchan2');
  await cleanup(db);
});

maybe('concurrent first discoveries produce exactly one winner', async () => {
  const db = await getDb();
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code='rgtestrace'`);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => claimDiscordInvites([{code:'rgtestrace'}], `rgchan${(i % 3) + 1}`)),
  );
  const admitted = results.flat().filter(r => r.admitted);
  assert.equal(admitted.length, 1);
  const stored = await db.query(`SELECT canonical_code,first_channel_id FROM discord_invite_registry WHERE canonical_code='rgtestrace'`);
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].first_channel_id, admitted[0].firstChannelId);
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code='rgtestrace'`);
});

maybe('same-channel reclaim admitted; first_seen_at immutable; claim creates no candidate rows', async () => {
  const db = await getDb();
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code='rgtestghost'`);
  const first = await claimDiscordInvites([{code:'rgtestghost',sourceSurface:'CHANNEL_EXTERNAL_LINKS',sourceUrl:'https://rg.test/'}], 'rgchan1');
  assert.equal(first[0].admitted, true);
  const src = await db.query(`SELECT first_source_surface,first_source_url FROM discord_invite_registry WHERE canonical_code='rgtestghost'`);
  assert.equal(src.rows[0].first_source_surface, 'CHANNEL_EXTERNAL_LINKS');
  assert.equal(src.rows[0].first_source_url, 'https://rg.test/');
  const t0 = (await db.query(`SELECT first_seen_at FROM discord_invite_registry WHERE canonical_code='rgtestghost'`)).rows[0].first_seen_at;
  const other = await claimDiscordInvites([{code:'rgtestghost'}], 'rgchan2');
  assert.equal(other[0].admitted, false);
  assert.equal(other[0].firstChannelId, 'rgchan1');
  const again = await claimDiscordInvites([{code:'rgtestghost',sourceSurface:'CHANNEL_EXTERNAL_LINKS',sourceUrl:'https://rg.test/'}], 'rgchan1');
  assert.equal(again[0].admitted, true);
  const t1 = (await db.query(`SELECT first_seen_at FROM discord_invite_registry WHERE canonical_code='rgtestghost'`)).rows[0].first_seen_at;
  assert.equal(new Date(t1).getTime(), new Date(t0).getTime());
  const rows = await db.query(`SELECT count(*)::int n FROM discord_candidates WHERE normalized_locator LIKE '%rgtestghost%'`);
  assert.equal(rows.rows[0].n, 0);
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code='rgtestghost'`);
});

after(async () => {
  if (!process.env.DATABASE_URL) return;
  const db = await getDb();
  await cleanup(db).catch(() => undefined);
});

maybe('loser rows are removed without touching the registry or winner rows', async () => {
  const { persistDiscordCandidates, deleteDiscordCandidates } = await import('./db');
  const db = await getDb();
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code='rgtestloser'`);
  await persistDiscordCandidates('rgchan1', [{candidateId:'rg-loser',rawLocator:'https://discord.gg/rgtestloser',resolvedLocator:'https://discord.gg/rgtestloser',locatorType:'NATIVE_INVITE',sourceSurface:'CREATOR_WEBSITES',sourceUrl:'https://rg.test/'}]);
  await claimDiscordInvites([{code:'rgtestloser'}], 'rgchan1');
  await persistDiscordCandidates('rgchan2', [{candidateId:'rg-loser',rawLocator:'https://discord.gg/rgtestloser',resolvedLocator:'https://discord.gg/rgtestloser',locatorType:'NATIVE_INVITE',sourceSurface:'CREATOR_WEBSITES',sourceUrl:'https://rg2.test/'}]);
  const lost = await claimDiscordInvites([{code:'rgtestloser'}], 'rgchan2');
  assert.equal(lost[0].admitted, false);
  assert.equal(await deleteDiscordCandidates('rgchan2', ['rgtestloser']), 1);
  const remaining = await db.query(`SELECT channel_id FROM discord_candidates WHERE normalized_locator='https://discord.gg/rgtestloser' ORDER BY 1`);
  assert.deepEqual(remaining.rows.map(r => r.channel_id), ['rgchan1']);
  const reg = await db.query(`SELECT first_channel_id FROM discord_invite_registry WHERE canonical_code='rgtestloser'`);
  assert.equal(reg.rows[0].first_channel_id, 'rgchan1');
  await cleanup(db);
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code='rgtestloser'`);
});
