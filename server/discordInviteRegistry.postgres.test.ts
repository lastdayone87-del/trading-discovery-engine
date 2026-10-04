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
  await cleanup(db);
});

maybe('concurrent first discoveries produce exactly one winner', async () => {
  const db = await getDb();
  await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code='rgtestrace'`);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => claimDiscordInvites(['rgtestrace'], `rgchan${(i % 3) + 1}`)),
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
  const first = await claimDiscordInvites(['rgtestghost'], 'rgchan1');
  assert.equal(first[0].admitted, true);
  const t0 = (await db.query(`SELECT first_seen_at FROM discord_invite_registry WHERE canonical_code='rgtestghost'`)).rows[0].first_seen_at;
  const other = await claimDiscordInvites(['rgtestghost'], 'rgchan2');
  assert.equal(other[0].admitted, false);
  assert.equal(other[0].firstChannelId, 'rgchan1');
  const again = await claimDiscordInvites(['rgtestghost'], 'rgchan1');
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
