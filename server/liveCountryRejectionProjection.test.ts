import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChannelRecord } from '../src/types';
import { applyLiveCountryRejectionToInspected } from './queueManager';

const inspectedRow = () => ({
  channel_id: 'UCxxxxxxxxxxxxxxxxxxxxxx',
  channel_name: 'Test Channel',
  youtube_url: 'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx',
  country: 'United States',
  country_status: 'UNCERTAIN',
  confidence_score: 0,
  discord_status: 'UNCERTAIN',
  discord_invite: null,
  discord_validation_status: 'RETRY_PENDING',
  scan_status: 'ENRICHING',
  scan_attempts: 1,
  discovery_source: 'automated_query',
  first_seen: '2026-01-01T00:00:00.000Z',
  last_checked: '2026-01-01T00:00:00.000Z',
  inspection_trail: [{ step: 'COUNTRY_VALIDATION', title: 'Country Validation', status: 'NOT_FOUND', details: 'earlier', timestamp: '2026-01-01T00:00:00.000Z' }],
  trading_status: 'UNCERTAIN',
}) as never;

test('live rejection projects fresh score, terminal scan status, and check time', () => {
  const row = inspectedRow();
  const out = applyLiveCountryRejectionToInspected(
    row,
    { detectedCreatorCountry: 'Vietnam', score: 90 },
    '2026-02-01T00:00:00.000Z',
  );
  assert.equal(out.country_status, 'REJECTED');
  assert.equal(out.country, 'Vietnam');
  assert.equal(out.confidence_score, 90);
  assert.equal(out.scan_status, 'COMPLETED');
  assert.equal(out.last_checked, '2026-02-01T00:00:00.000Z');
});

test('live rejection helper never touches trading/Discord ownership or the trail', () => {
  const row: ChannelRecord = inspectedRow();
  const trailBefore = row.inspection_trail;
  const out = applyLiveCountryRejectionToInspected(
    row,
    { detectedCreatorCountry: 'Vietnam', score: 90 },
    '2026-02-01T00:00:00.000Z',
  );
  assert.equal(out.trading_status, 'UNCERTAIN');
  assert.equal(out.discord_status, 'UNCERTAIN');
  assert.equal(out.discord_invite, null);
  assert.equal(out.discord_validation_status, 'RETRY_PENDING');
  assert.equal(out.inspection_trail, trailBefore);
  assert.equal(out.inspection_trail.length, 1);
});

test('live rejection branch uses the helper and persists via the finally upsert only', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const branch = source.slice(
    source.indexOf('if (liveCountry.status ==='),
    source.indexOf("if (liveCountry.detectedCreatorCountry !== undefined)"),
  );
  assert.match(branch, /applyLiveCountryRejectionToInspected\(channel, liveCountry, now\)/);
  assert.match(branch, /channel\.inspection_trail=\[countryStep, \.\.\.inspection\.steps, liveCountryStep\]/);
  // No direct write in the branch: the function's finally-block upsert owns
  // persistence, so exactly one durable write path exists.
  assert.doesNotMatch(branch, /await upsertChannel/);
});

test('existing-row Gate-1 outcome mirrors the preserved trading/Discord record', () => {
  const source = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const branch = source.slice(
    source.indexOf('if (existing) {', source.indexOf("if (countryVal.gateDisposition === 'REJECT_EXCLUDED'")),
    source.indexOf("if (countryVal.gateDisposition === 'NEEDS_REVIEW'"),
  );
  // Outcome reports the row's own ownership fields — never defaults that
  // would contradict the returned channelRecord.
  assert.match(branch, /tradingStatus: existing\.trading_status \|\| 'UNCERTAIN'/);
  assert.match(branch, /discordStatus: existing\.discord_status/);
  assert.match(branch, /discordInvite: existing\.discord_invite \|\| null/);
  // The branch must not mutate those fields to fit the outcome; the helper
  // preserves them and the outcome only reads them.
  assert.doesNotMatch(branch, /existing\.trading_status\s*=/);
  assert.doesNotMatch(branch, /existing\.discord_status\s*=/);
  assert.doesNotMatch(branch, /existing\.discord_invite\s*=/);
  // Gate-1 persistence fix stays intact: single projection + single upsert.
  assert.match(branch, /applyGate1CountryRejectionToExisting/);
  assert.equal(branch.match(/await upsertChannel\(existing\)/g)?.length, 1);
});
