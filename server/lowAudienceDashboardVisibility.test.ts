import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildChannelListingWhere, getDb, listChannelsPage } from './db';

const serving = { predicate: "country_status <> 'REJECTED'", scope: 'ELIGIBLE_OPERATOR_VISIBLE_CHANNELS' };
const baseFilters = { includeRejected: false, diagnosticsOnly: false };

test('default channel listing excludes low-audience skips while retaining the rest of the stored corpus', () => {
  const result = buildChannelListingWhere(serving, baseFilters);
  assert.match(result.where, /scan_status <> 'SKIPPED_LOW_AUDIENCE'/);
  assert.doesNotMatch(result.where, /subscriber_count::integer < 30/);
  assert.match(result.where, /NOT COALESCE\([\s\S]*CASE[\s\S]*subscriber_count/);
  assert.deepEqual(result.values, []);
});

test('explicit low-audience scan filter opts into only those stored rows', () => {
  const result = buildChannelListingWhere(serving, { ...baseFilters, scanStatus: 'SKIPPED_LOW_AUDIENCE' });
  assert.doesNotMatch(result.where, /scan_status <> 'SKIPPED_LOW_AUDIENCE'/);
  assert.match(result.where, /scan_status=\$1/);
  assert.match(result.where, /OR COALESCE\([\s\S]*CASE[\s\S]*subscriber_count/);
  assert.deepEqual(result.values, ['SKIPPED_LOW_AUDIENCE']);
});

test('unknown or unavailable audience remains visible under the default contract', () => {
  const result = buildChannelListingWhere(serving, baseFilters);
  assert.match(result.where, /NOT COALESCE\([\s\S]*CASE[\s\S]*subscriber_count/);
  assert.match(result.where, /COALESCE\(/);
  assert.match(result.where, /subscriber_count IS NULL/);
  assert.match(result.where, /ELSE NULL/);
});

test('other explicit scan statuses, search, and combined filters preserve default exclusion', () => {
  const result = buildChannelListingWhere(serving, {
    ...baseFilters,
    search: 'alpha',
    country: 'Germany',
    countryStatus: 'CONFIRMED',
    tradingStatus: 'TRADING_CONFIRMED',
    discordStatus: 'ACTIVE',
    scanStatus: 'COMPLETED',
  });
  assert.match(result.where, /scan_status <> 'SKIPPED_LOW_AUDIENCE'/);
  assert.match(result.where, /scan_status=\$6/);
  assert.deepEqual(result.values, ['alpha', 'Germany', 'CONFIRMED', 'TRADING_CONFIRMED', 'ACTIVE', 'COMPLETED']);
});

test('diagnostics and explicit rejected-corpus requests remain opt-in views', () => {
  const diagnostics = buildChannelListingWhere(serving, { ...baseFilters, diagnosticsOnly: true });
  const allStored = buildChannelListingWhere(serving, { ...baseFilters, includeRejected: true });
  assert.match(diagnostics.where, /NOT \(country_status <> 'REJECTED'\)/);
  assert.doesNotMatch(diagnostics.where, /scan_status <> 'SKIPPED_LOW_AUDIENCE'/);
  assert.doesNotMatch(allStored.where, /scan_status <> 'SKIPPED_LOW_AUDIENCE'/);
});

test('Channels Table API and UI preserve the default exclusion and explicit filter contract', () => {
  const server = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const db = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  const table = fs.readFileSync(new URL('../src/components/ResultsTable.tsx', import.meta.url), 'utf8');
  assert.match(server, /scanStatus:req\.query\.scan_status as string\|undefined/);
  assert.match(db, /SELECT \$\{columns\} FROM channels WHERE \$\{where\} ORDER BY first_seen DESC,channel_id LIMIT/);
  assert.match(db, /SELECT COUNT\(\*\)::int total,MAX\(updated_at\) revision FROM channels WHERE \$\{where\}/);
  assert.match(db, /getChannelListingRevision[\s\S]+channelListingWhere\(db,args\)/);
  assert.match(table, /selectedScanStatus === 'SKIPPED_LOW_AUDIENCE' \|\| c\.scan_status !== 'SKIPPED_LOW_AUDIENCE'/);
  assert.match(table, /value="SKIPPED_LOW_AUDIENCE">LOW AUDIENCE \(Skipped &lt;30\)/);
});

const databaseUrl = process.env.CHANNEL_LISTING_POSTGRES_URL;
test('PostgreSQL integration: low-audience rows remain stored but are excluded from and recoverable through the listing', {
  skip: databaseUrl ? false : 'CHANNEL_LISTING_POSTGRES_URL is required for PostgreSQL storage coverage',
}, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const suffix = `${Date.now()}_${process.pid}`;
  const lowAudienceId = `CHANNEL_LISTING_LOW_${suffix}`;
  const normalId = `CHANNEL_LISTING_NORMAL_${suffix}`;
  try {
    await db.query(`INSERT INTO channels(channel_id,channel_name,youtube_url,country,country_status,discord_status,scan_status,discovery_source,first_seen,trading_status)
      VALUES($1,$1,$2,'Germany','CONFIRMED','UNKNOWN','SKIPPED_LOW_AUDIENCE','channels-table-test',now(),'TRADING_CONFIRMED'),
            ($3,$3,$4,'Germany','CONFIRMED','UNKNOWN','COMPLETED','channels-table-test',now(),'TRADING_CONFIRMED')`, [
      lowAudienceId,
      `https://youtube.com/channel/${lowAudienceId}`,
      normalId,
      `https://youtube.com/channel/${normalId}`,
    ]);

    const stored = await db.query('SELECT channel_id,scan_status FROM channels WHERE channel_id=ANY($1::text[]) ORDER BY channel_id', [[lowAudienceId, normalId]]);
    assert.deepEqual(stored.rows, [
      { channel_id: lowAudienceId, scan_status: 'SKIPPED_LOW_AUDIENCE' },
      { channel_id: normalId, scan_status: 'COMPLETED' },
    ]);

    const defaultPage = await listChannelsPage({ ...baseFilters, limit: 100, offset: 0, search: 'CHANNEL_LISTING_' });
    assert.equal(defaultPage.items.some(channel => channel.channel_id === lowAudienceId), false);
    assert.equal(defaultPage.items.some(channel => channel.channel_id === normalId), true);
    assert.equal(defaultPage.total, 1);

    const explicitPage = await listChannelsPage({ ...baseFilters, scanStatus: 'SKIPPED_LOW_AUDIENCE', limit: 100, offset: 0 });
    assert.deepEqual(explicitPage.items.map(channel => channel.channel_id), [lowAudienceId]);
    assert.equal(explicitPage.total, 1);
  } finally {
    await db.query('DELETE FROM channels WHERE channel_id=ANY($1::text[])', [[lowAudienceId, normalId]]).catch(() => undefined);
  }
});
