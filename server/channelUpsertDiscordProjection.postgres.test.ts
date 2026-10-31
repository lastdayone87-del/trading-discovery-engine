import test from 'node:test';
import assert from 'node:assert/strict';
import { getChannelById, getDb, upsertChannel, writeChannelUpsert } from './db';
import { runWithOfficialYouTubeQuotaOrigin } from './officialYouTubeQuotaFence';

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

  // A plain caller carrying a stale DEAD snapshot cannot clear the newer live
  // projection either: its terminal status may predate the validation that
  // just committed. Only the authoritative validation write or explicit
  // cleanup owns that transition.
  await upsertChannel({ ...stale, discord_status: 'DEAD', discord_invite: null });
  const retained = await getChannelById(channelId);
  assert.equal(retained?.discord_status, 'ACTIVE');
  assert.equal(retained?.discord_invite, 'https://discord.gg/newroom');

  // Explicit intentional cleanup still applies the terminal projection.
  await upsertChannel({ ...stale, discord_status: 'DEAD', discord_invite: null }, { allowDiscordClear: true });
  const overwritten = await getChannelById(channelId);
  assert.equal(overwritten?.discord_status, 'DEAD');
  assert.equal(overwritten?.discord_invite, null);
});

maybe('classification-only upsert preserves a Discord row inserted between its read and write', async t => {
  const db = await getDb();
  const channelId = `${PREFIX}insert-race-${Date.now()}_${process.pid}`;
  const cleanup = async () => {
    await db.query(`DELETE FROM channels WHERE channel_id=$1`, [channelId]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  const stale = {
    channel_id: channelId,
    channel_name: 'classification after concurrent insert',
    youtube_url: `https://youtube.test/${channelId}`,
    country: 'Germany',
    country_status: 'CONFIRMED',
    confidence_score: 90,
    discord_status: 'DEAD',
    discord_invite: null,
    discord_discovery_status: 'NOT_DISCOVERED',
    discord_candidate_locator: null,
    discord_candidate_id: null,
    discord_candidate_raw_locator: null,
    discord_candidate_type: null,
    discord_resolution_status: 'NOT_ATTEMPTED',
    discord_liveness_status: 'DEAD',
    discord_relevance_status: 'NOT_CHECKED',
    discord_validation_status: 'COMPLETED',
    discord_duplicate_owner_channel_id: null,
    scan_status: 'COMPLETED',
    discovery_source: 'automated_query',
    trading_status: 'TRADING_CONFIRMED',
  } as any;

  const active = {
    ...stale,
    channel_name: 'concurrent active insert',
    discord_status: 'ACTIVE',
    discord_invite: 'https://discord.gg/inserted',
    discord_discovery_status: 'VALIDATED',
    discord_candidate_locator: 'https://discord.gg/inserted',
    discord_candidate_id: 'inserted-candidate',
    discord_resolution_status: 'RESOLVED',
    discord_liveness_status: 'ACTIVE',
    discord_relevance_status: 'TRADING_RELEVANT',
    discord_validation_status: 'COMPLETED',
  };

  // Reproduce the interleaving that the original read-then-write path missed:
  // the classification transaction's locked read returns no row, then another
  // writer inserts and commits before the conflict write runs.
  const classification = await db.connect();
  const concurrent = await db.connect();
  try {
    await classification.query('BEGIN');
    await classification.query(`SET LOCAL statement_timeout='5s'`);
    const prior = await classification.query(
      `SELECT quality_score,trading_status FROM channels WHERE channel_id=$1 FOR UPDATE`,
      [channelId],
    );
    assert.equal(prior.rowCount, 0, 'the classification read must miss the row to exercise the insert race');

    // The concurrent writer uses the same production write helper with a
    // bounded statement, so an unexpected lock wait fails the regression
    // quickly instead of consuming the CI job timeout.
    await concurrent.query('BEGIN');
    await concurrent.query(`SET LOCAL statement_timeout='5s'`);
    await writeChannelUpsert(concurrent, active);
    await concurrent.query('COMMIT');

    await writeChannelUpsert(classification, stale, { preserveDiscordOnUpdate: true });
    await classification.query('COMMIT');
  } catch (error) {
    await classification.query('ROLLBACK').catch(() => undefined);
    await concurrent.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    classification.release();
    concurrent.release();
  }

  const row = await getChannelById(channelId);
  assert.equal(row?.discord_status, 'ACTIVE', 'the concurrent ACTIVE insert must not be replaced by the stale DEAD snapshot');
  assert.equal(row?.discord_invite, 'https://discord.gg/inserted');
  assert.equal(row?.discord_liveness_status, 'ACTIVE');
  assert.equal(row?.discord_validation_status, 'COMPLETED');
  assert.equal(row?.channel_name, 'classification after concurrent insert', 'non-Discord fields still come from the classification write');
});

maybe('quota origin is insert-only: probe rediscovery never rewrites an existing marker', async t => {
  const db = await getDb();
  const normalId = `${PREFIX}quota-normal-${Date.now()}_${process.pid}`;
  const probeId = `${PREFIX}quota-probe-${Date.now()}_${process.pid}`;
  const cleanup = async () => {
    await db.query(`DELETE FROM channels WHERE channel_id = ANY($1::text[])`, [[normalId, probeId]]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  const base = {
    channel_id: normalId,
    channel_name: 'quota origin fixture',
    youtube_url: `https://youtube.test/${normalId}`,
    country: 'Germany',
    country_status: 'CONFIRMED',
    confidence_score: 90,
    discord_status: 'NOT_FOUND',
    discord_invite: null,
    scan_status: 'COMPLETED',
    discovery_source: 'probe',
    trading_status: 'TRADING_CONFIRMED',
    quota_origin: 'NORMAL',
  } as any;

  await upsertChannel(base);
  await runWithOfficialYouTubeQuotaOrigin('PROBE', 'quota-origin-test', () =>
    upsertChannel({ ...base, subscriber_count: 123 } as any),
  );
  assert.equal(
    (await getChannelById(normalId))?.quota_origin,
    'NORMAL',
    'a probe run that rediscovers an established NORMAL channel must not move it to the probe bucket',
  );

  const probeBase = { ...base, channel_id: probeId, quota_origin: 'PROBE' } as any;
  await runWithOfficialYouTubeQuotaOrigin('PROBE', 'quota-origin-test', () => upsertChannel(probeBase));
  assert.equal((await getChannelById(probeId))?.quota_origin, 'PROBE', 'a probe-created row keeps PROBE');

  await runWithOfficialYouTubeQuotaOrigin('NORMAL', 'quota-origin-test', () =>
    upsertChannel({ ...probeBase, subscriber_count: 456 } as any),
  );
  assert.equal(
    (await getChannelById(probeId))?.quota_origin,
    'PROBE',
    'a normal upsert must not downgrade a PROBE row',
  );
});
