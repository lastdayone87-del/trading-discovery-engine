import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getDb,
  listChannelsPage,
  persistDiscordCandidates,
  appendDiscordCheckAttempts,
  getChannelById,
} from './db';

const enabled = Boolean(process.env.DATABASE_URL);
const maybe = enabled ? test : test.skip;
const PREFIX = 'recent-invite-';

maybe('recently confirmed invites are ordered, filtered, paginated, and backfilled from successful attempts', async t => {
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}`;
  const search = suffix;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  const ids = {
    oldActive: id('old-active'),
    lowVolume: id('low-volume'),
    newActive: id('new-active'),
    tieA: id('tie-a'),
    tieB: id('tie-b'),
    mismatchedCandidateId: id('mismatched-candidate-id'),
    legacyNull: id('legacy-null'),
    notFound: id('excluded-not-found'),
    pending: id('excluded-pending'),
    uncertain: id('excluded-uncertain'),
    duplicate: id('excluded-duplicate'),
    provenanceOnly: id('included-provenance-only'),
    unconfirmed: id('excluded-unconfirmed'),
    dead: id('excluded-dead'),
    backfill: id('backfill'),
  };
  const codeSuffix = suffix.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const conflictCode = `dupconflict${codeSuffix}`;
  const provenanceCode = `provenance${codeSuffix}`;
  const cleanup = async () => {
    await db.query(`DELETE FROM discord_invite_registry WHERE canonical_code = ANY($1)`, [[conflictCode, provenanceCode]]).catch(() => undefined);
    await db.query(`DELETE FROM channels WHERE channel_id LIKE $1`, [`${PREFIX}%${suffix}`]).catch(() => undefined);
  };
  await cleanup();
  t.after(cleanup);

  const insertChannel = async (channelId: string, firstSeen: string, overrides: {
    status?: string;
    invite?: string | null;
    validation?: string;
    liveness?: string;
    discovery?: string;
    duplicate?: string | null;
    scanStatus?: string;
  } = {}) => {
    await db.query(
      `INSERT INTO channels(
        channel_id,channel_name,youtube_url,country,country_status,discord_status,discord_invite,
        scan_status,discovery_source,first_seen,trading_status,subscriber_count,
        discord_validation_status,discord_liveness_status,discord_discovery_status,discord_duplicate_owner_channel_id
      ) VALUES($1,$2,$3,'Germany','CONFIRMED',$4,$5,$6,'automated_query',$7,'TRADING_CONFIRMED','1000',$8,$9,$10,$11)`,
      [
        channelId,
        `${PREFIX}${channelId} ${suffix}`,
        `https://youtube.test/${channelId}`,
        overrides.status || 'ACTIVE',
        overrides.invite || null,
        overrides.scanStatus || 'COMPLETED',
        firstSeen,
        overrides.validation || 'SUCCEEDED',
        overrides.liveness || 'ACTIVE',
        overrides.discovery || 'VALIDATED',
        overrides.duplicate || null,
      ],
    );
  };

  const confirm = async (channelId: string, code: string, checkedAt: string, status = 'ACTIVE') => {
    const url = `https://discord.gg/${code}`;
    const candidateId = `candidate-${code}`;
    const candidate = {
      candidateId,
      rawLocator: `discord.gg/${code}`,
      resolvedLocator: url,
      locatorType: 'NATIVE_INVITE',
      sourceSurface: 'YOUTUBE_ABOUT',
    };
    await persistDiscordCandidates(channelId, [candidate]);
    await appendDiscordCheckAttempts(channelId, url, status, [{
      attemptNumber: 1,
      operationalOutcome: 'SUCCEEDED',
      retryable: false,
      reason: 'active',
      checkedAt,
    }], candidate);
    await db.query(
      `UPDATE channels SET
         discord_status=$2,discord_invite=$3,discord_candidate_id=$4,discord_candidate_locator=$3,
         discord_candidate_raw_locator=$5,discord_candidate_type='NATIVE_INVITE',
         discord_resolution_status='RESOLVED',discord_liveness_status='ACTIVE',
         discord_relevance_status='TRADING_RELEVANT',discord_validation_status='SUCCEEDED',
         discord_discovery_status='VALIDATED'
       WHERE channel_id=$1`,
      [channelId, status, url, candidateId, `discord.gg/${code}`],
    );
    return { url, candidateId };
  };

  await insertChannel(ids.oldActive, '2023-01-01T00:00:00.000Z');
  await insertChannel(ids.lowVolume, '2022-01-01T00:00:00.000Z');
  await insertChannel(ids.newActive, '2026-10-19T00:00:00.000Z');
  await insertChannel(ids.tieA, '2021-01-01T00:00:00.000Z');
  await insertChannel(ids.tieB, '2021-01-01T00:00:00.000Z');
  await insertChannel(ids.legacyNull, '2020-01-01T00:00:00.000Z', { invite: 'https://discord.gg/legacynull' });
  await insertChannel(ids.notFound, '2020-01-01T00:00:00.000Z', {
    status: 'NOT_FOUND', validation: 'COMPLETED', liveness: 'NOT_CHECKED', discovery: 'NOT_DISCOVERED',
  });
  await insertChannel(ids.pending, '2020-01-01T00:00:00.000Z', {
    status: 'PENDING', validation: 'RETRY_PENDING', liveness: 'NOT_CHECKED', discovery: 'DISCOVERED_VALIDATION_FAILED',
  });
  await insertChannel(ids.uncertain, '2020-01-01T00:00:00.000Z', {
    status: 'UNCERTAIN', invite: 'https://discord.gg/uncertain', validation: 'SUCCEEDED', liveness: 'ACTIVE', discovery: 'VALIDATED',
  });
  await insertChannel(ids.duplicate, '2020-01-01T00:00:00.000Z', {
    status: 'ACTIVE', invite: `https://discord.gg/${conflictCode}`, validation: 'SUCCEEDED', liveness: 'ACTIVE', discovery: 'VALIDATED', duplicate: 'UC-owner',
  });
  await db.query(
    `INSERT INTO discord_invite_registry(canonical_code,first_channel_id,first_seen_at)
     VALUES($1,$2,now())
     ON CONFLICT(canonical_code) DO UPDATE SET first_channel_id=EXCLUDED.first_channel_id`,
    [conflictCode, 'UC-owner'],
  );
  await insertChannel(ids.provenanceOnly, '2020-01-01T00:00:00.000Z', {
    status: 'ACTIVE', invite: `https://discord.gg/${provenanceCode}`, validation: 'SUCCEEDED', liveness: 'ACTIVE', discovery: 'VALIDATED', duplicate: 'UC-discarded-owner',
  });
  await insertChannel(ids.unconfirmed, '2020-01-01T00:00:00.000Z', {
    status: 'ACTIVE', invite: 'https://discord.gg/unconfirmed', validation: 'RETRY_PENDING', liveness: 'UNCERTAIN', discovery: 'DISCOVERED_VALIDATION_FAILED',
  });
  await insertChannel(ids.dead, '2020-01-01T00:00:00.000Z', {
    status: 'DEAD', validation: 'COMPLETED', liveness: 'DEAD', discovery: 'VALIDATED',
  });

  // Persist retains the first candidate id for an already-known locator while
  // the channel can project a newer id. The timestamp lookup must fall back to
  // the selected locator when the projected id has no candidate row.
  const mismatchedUrl = 'https://discord.gg/mismatchedcandidate';
  await insertChannel(ids.mismatchedCandidateId, '2020-01-01T00:00:00.000Z', { invite: mismatchedUrl });
  await persistDiscordCandidates(ids.mismatchedCandidateId, [{
    candidateId: 'candidate-retained',
    rawLocator: 'discord.gg/mismatchedcandidate',
    resolvedLocator: mismatchedUrl,
    locatorType: 'NATIVE_INVITE',
    sourceSurface: 'YOUTUBE_ABOUT',
  }]);
  await appendDiscordCheckAttempts(ids.mismatchedCandidateId, mismatchedUrl, 'ACTIVE', [{
    attemptNumber: 1,
    operationalOutcome: 'SUCCEEDED',
    retryable: false,
    reason: 'active',
    checkedAt: '2026-10-16T18:00:00.000Z',
  }], {
    candidateId: 'candidate-projected',
    rawLocator: 'discord.gg/mismatchedcandidate',
    resolvedLocator: mismatchedUrl,
    locatorType: 'NATIVE_INVITE',
  });
  await db.query(
    `UPDATE channels SET discord_status='ACTIVE',discord_invite=$2,discord_candidate_id=$3,
       discord_candidate_locator=$2,discord_candidate_raw_locator='discord.gg/mismatchedcandidate',
       discord_candidate_type='NATIVE_INVITE',discord_resolution_status='RESOLVED',
       discord_liveness_status='ACTIVE',discord_relevance_status='TRADING_RELEVANT',
       discord_validation_status='SUCCEEDED',discord_discovery_status='VALIDATED'
     WHERE channel_id=$1`,
    [ids.mismatchedCandidateId, mismatchedUrl, 'candidate-projected'],
  );

  const old = await confirm(ids.oldActive, 'oldactive', '2026-10-20T18:00:00.000Z');
  const low = await confirm(ids.lowVolume, 'lowvolume', '2026-10-19T18:00:00.000Z', 'ACTIVE_LOW_VOLUME');
  const fresh = await confirm(ids.newActive, 'newactive', '2026-10-18T18:00:00.000Z');
  const tieB = await confirm(ids.tieB, 'tie-b', '2026-10-17T18:00:00.000Z');
  const tieA = await confirm(ids.tieA, 'tie-a', '2026-10-17T18:00:00.000Z');
  await confirm(ids.provenanceOnly, provenanceCode, '2026-10-15T18:00:00.000Z');

  // The old channel's confirmation is newer than the new channel's, so the
  // sort must follow the invite timestamp rather than first_seen.
  // A later successful attempt must never replace the first confirmation.
  await appendDiscordCheckAttempts(ids.oldActive, old.url, 'ACTIVE', [{
    attemptNumber: 2,
    operationalOutcome: 'SUCCEEDED',
    retryable: false,
    reason: 'active',
    checkedAt: '2026-10-20T19:00:00.000Z',
  }], { candidateId: old.candidateId, rawLocator: 'discord.gg/oldactive', resolvedLocator: old.url, locatorType: 'NATIVE_INVITE' });

  const all = await listChannelsPage({ limit: 100, offset: 0, search, recentInvites: true });
  assert.equal(all.total, 8, 'only confirmed active/low-volume legacy-null rows are in the recent view');
  assert.deepEqual(all.items.map(channel => channel.channel_id), [
    ids.oldActive, ids.lowVolume, ids.newActive, ids.tieB, ids.tieA,
    ids.mismatchedCandidateId, ids.provenanceOnly, ids.legacyNull,
  ]);
  assert.equal(all.items[0].discord_invite_first_validated_at, '2026-10-20T18:00:00.000Z');
  assert.equal(all.items[5].discord_invite_first_validated_at, '2026-10-16T18:00:00.000Z', 'locator fallback keeps the confirmation timestamp');
  assert.equal(all.items[6].discord_invite_first_validated_at, '2026-10-15T18:00:00.000Z');
  assert.equal(all.items[7].discord_invite_first_validated_at, null, 'missing confirmation time is not synthesized');

  const page1 = await listChannelsPage({ limit: 2, offset: 0, search, recentInvites: true });
  const page2 = await listChannelsPage({ limit: 2, offset: 2, search, recentInvites: true });
  const page3 = await listChannelsPage({ limit: 2, offset: 4, search, recentInvites: true });
  const page4 = await listChannelsPage({ limit: 2, offset: 6, search, recentInvites: true });
  assert.equal(page1.total, 8);
  assert.deepEqual(page1.items.map(channel => channel.channel_id), [ids.oldActive, ids.lowVolume]);
  assert.deepEqual(page2.items.map(channel => channel.channel_id), [ids.newActive, ids.tieB]);
  assert.deepEqual(page3.items.map(channel => channel.channel_id), [ids.tieA, ids.mismatchedCandidateId]);
  assert.deepEqual(page4.items.map(channel => channel.channel_id), [ids.provenanceOnly, ids.legacyNull]);
  assert.equal(page3.items[0].discord_invite_first_validated_at, '2026-10-17T18:00:00.000Z');
  assert.equal(page3.items[1].discord_invite_first_validated_at, '2026-10-16T18:00:00.000Z');
  assert.equal(page4.items[0].discord_invite_first_validated_at, '2026-10-15T18:00:00.000Z');
  assert.equal(page4.items[1].discord_invite_first_validated_at, null);
  assert.equal(tieB.candidateId, 'candidate-tie-b');
  assert.equal(tieA.candidateId, 'candidate-tie-a');
  assert.equal(fresh.candidateId, 'candidate-newactive');
  assert.equal(low.candidateId, 'candidate-lowvolume');

  const activeOnly = await listChannelsPage({ limit: 100, offset: 0, search, recentInvites: true, discordStatus: 'ACTIVE' });
  assert.equal(activeOnly.total, 7);
  assert.deepEqual(activeOnly.items.map(channel => channel.channel_id), [
    ids.oldActive, ids.newActive, ids.tieB, ids.tieA, ids.mismatchedCandidateId, ids.provenanceOnly, ids.legacyNull,
  ]);
  const lowOnly = await listChannelsPage({ limit: 100, offset: 0, search, recentInvites: true, discordStatus: 'ACTIVE_LOW_VOLUME' });
  assert.deepEqual(lowOnly.items.map(channel => channel.channel_id), [ids.lowVolume]);
  for (const excluded of ['UNCERTAIN', 'NOT_FOUND', 'PENDING']) {
    const page = await listChannelsPage({ limit: 100, offset: 0, search, recentInvites: true, discordStatus: excluded });
    assert.equal(page.total, 0, `${excluded} is not a confirmed invite category`);
  }

  const excludedIds = new Set([ids.notFound, ids.pending, ids.uncertain, ids.duplicate, ids.unconfirmed, ids.dead]);
  assert.equal(all.items.some(channel => excludedIds.has(channel.channel_id)), false);
  assert.equal(all.items.some(channel => channel.channel_id === ids.duplicate), false,
    'a selected invite registered to another channel remains excluded');
  assert.equal(all.items.some(channel => channel.channel_id === ids.provenanceOnly), true,
    'a historical duplicate-owner flag alone must not exclude the selected invite');
  assert.equal(all.items.find(channel => channel.channel_id === ids.provenanceOnly)?.discord_duplicate_owner_channel_id, 'UC-discarded-owner');
  assert.equal(all.items.find(channel => channel.channel_id === ids.provenanceOnly)?.discord_selected_invite_conflict, false);
  assert.equal((await getChannelById(ids.duplicate))?.discord_selected_invite_conflict, true);
  assert.equal(all.items.some(channel => channel.channel_id === ids.unconfirmed), false);

  // Backfill coverage: simulate a pre-152 candidate whose column is NULL even
  // though the append-only ledger contains a successful attempt. The migration
  // query must restore the earliest success and must leave a failure-only
  // candidate NULL.
  await insertChannel(ids.backfill, '2019-01-01T00:00:00.000Z', { scanStatus: 'SKIPPED_EXCLUDED' });
  const backfill = await confirm(ids.backfill, 'backfill', '2026-10-05T00:00:00.000Z');
  await appendDiscordCheckAttempts(ids.backfill, backfill.url, 'ACTIVE', [{
    attemptNumber: 2,
    operationalOutcome: 'SUCCEEDED',
    retryable: false,
    reason: 'active',
    checkedAt: '2026-10-10T00:00:00.000Z',
  }], { candidateId: backfill.candidateId, rawLocator: 'discord.gg/backfill', resolvedLocator: backfill.url, locatorType: 'NATIVE_INVITE' });
  const failureUrl = 'https://discord.gg/failureonly';
  await persistDiscordCandidates(ids.backfill, [{
    candidateId: 'candidate-failureonly', rawLocator: 'discord.gg/failureonly', resolvedLocator: failureUrl,
    locatorType: 'NATIVE_INVITE', sourceSurface: 'YOUTUBE_ABOUT',
  }]);
  await appendDiscordCheckAttempts(ids.backfill, failureUrl, 'UNCERTAIN', [{
    attemptNumber: 1, operationalOutcome: 'TIMEOUT', retryable: true, reason: 'timeout', checkedAt: '2026-10-06T00:00:00.000Z',
  }], { candidateId: 'candidate-failureonly', rawLocator: 'discord.gg/failureonly', resolvedLocator: failureUrl, locatorType: 'NATIVE_INVITE' });
  await db.query(`UPDATE discord_candidates SET first_validated_at=NULL WHERE channel_id=$1`, [ids.backfill]);
  const backfillResult = await db.query(
    `WITH successful_validation AS (
       SELECT channel_id,lower(COALESCE(resolved_locator,invite_locator)) AS normalized_locator,MIN(checked_at) AS first_validated_at
         FROM discord_check_attempts
        WHERE operational_outcome='SUCCEEDED'
        GROUP BY channel_id,lower(COALESCE(resolved_locator,invite_locator))
     )
     UPDATE discord_candidates dc
        SET first_validated_at=LEAST(COALESCE(dc.first_validated_at,successful_validation.first_validated_at),successful_validation.first_validated_at)
       FROM successful_validation
      WHERE dc.channel_id=successful_validation.channel_id
        AND dc.normalized_locator=successful_validation.normalized_locator
        AND (dc.first_validated_at IS NULL OR dc.first_validated_at > successful_validation.first_validated_at)`,
    [],
  );
  assert.ok((backfillResult.rowCount || 0) >= 1);
  const restored = await db.query(
    `SELECT candidate_id,first_validated_at FROM discord_candidates WHERE channel_id=$1 ORDER BY candidate_id`,
    [ids.backfill],
  );
  const byCandidate = new Map(restored.rows.map(row => [row.candidate_id, row.first_validated_at]));
  assert.equal(new Date(byCandidate.get('candidate-backfill')).toISOString(), '2026-10-05T00:00:00.000Z');
  assert.equal(byCandidate.get('candidate-failureonly'), null);
});

after(async () => { if (enabled) (await getDb()).end(); });
