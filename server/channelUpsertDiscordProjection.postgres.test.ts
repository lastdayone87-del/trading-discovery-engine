import test from 'node:test';
import assert from 'node:assert/strict';
import { getChannelById, getDb, upsertChannel } from './db';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;
const PREFIX = 'upsert-discord-projection-';

/**
 * The ingestion pipeline writes classification-only upserts whose Discord
 * snapshot may predate a long classification. The opt-in option must keep the
 * locked row's Discord projection instead of writing that snapshot back. Only
 * real PostgreSQL proves the transaction-scoped read and column semantics.
 */
maybe('classification-only upserts never overwrite a newer Discord projection', async t => {
  const db = await getDb();
  const channelId = `${PREFIX}${Date.now()}_${process.pid}`;
  const cleanup = async () => {
    await db.query(`DELETE FROM channels WHERE channel_id=$1`, [channelId]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  const stale = {
    channel_id: channelId,
    channel_name: 'upsert race fixture',
    youtube_url: `https://youtube.test/${channelId}`,
    country: 'Germany',
    country_status: 'CONFIRMED',
    confidence_score: 90,
    discord_status: 'ACTIVE',
    discord_invite: 'https://discord.gg/oldroom',
    discord_discovery_status: 'VALIDATED',
    discord_candidate_locator: 'https://discord.gg/oldroom',
    discord_candidate_id: 'old-candidate',
    discord_resolution_status: 'RESOLVED',
    discord_liveness_status: 'ACTIVE',
    discord_relevance_status: 'TRADING_RELEVANT',
    discord_validation_status: 'COMPLETED',
    discord_duplicate_owner_channel_id: null,
    scan_status: 'COMPLETED',
    discovery_source: 'automated_query',
    trading_status: 'TRADING_CONFIRMED',
  } as any;

  await upsertChannel(stale);

  // A validation worker confirms the selected invite is dead after the
  // classification snapshot above was loaded.
  await db.query(
    `UPDATE channels SET discord_status='DEAD',discord_invite=NULL,discord_liveness_status='DEAD',discord_validation_status='COMPLETED' WHERE channel_id=$1`,
    [channelId],
  );
  await upsertChannel({ ...stale, channel_name: 'upsert race fixture v2' }, { preserveDiscordOnUpdate: true });

  const dead = await getChannelById(channelId);
  assert.equal(dead?.discord_status, 'DEAD', 'a stale ACTIVE snapshot must not resurrect a confirmed DEAD result');
  assert.equal(dead?.discord_invite, null);
  assert.equal(dead?.channel_name, 'upsert race fixture v2', 'non-Discord fields still update');

  // The inverse: a stale DEAD snapshot must not overwrite a newer live projection.
  await db.query(
    `UPDATE channels SET discord_status='ACTIVE',discord_invite='https://discord.gg/newroom',discord_liveness_status='ACTIVE',discord_validation_status='COMPLETED' WHERE channel_id=$1`,
    [channelId],
  );
  await upsertChannel({ ...stale, discord_status: 'DEAD', discord_invite: null }, { preserveDiscordOnUpdate: true });

  const live = await getChannelById(channelId);
  assert.equal(live?.discord_status, 'ACTIVE');
  assert.equal(live?.discord_invite, 'https://discord.gg/newroom');

  // Plain callers keep the historical full-row write semantics.
  await upsertChannel({ ...stale, discord_status: 'DEAD', discord_invite: null });
  const overwritten = await getChannelById(channelId);
  assert.equal(overwritten?.discord_status, 'DEAD');
  assert.equal(overwritten?.discord_invite, null);
});
