import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyGate1CountryRejectionToExisting } from './ingestionPipeline';

const existingRow = () => ({
  channel_id: 'UCxxxxxxxxxxxxxxxxxxxxxx',
  channel_name: 'Test Channel',
  youtube_url: 'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx',
  country: 'United States',
  country_status: 'UNCERTAIN',
  confidence_score: 40,
  discord_status: 'NOT_FOUND',
  discord_invite: null,
  scan_status: 'ENRICHING',
  scan_attempts: 1,
  discovery_source: 'automated_query',
  first_seen: '2026-01-01T00:00:00.000Z',
  last_checked: '2026-01-01T00:00:00.000Z',
  inspection_trail: [
    {
      step: 'COUNTRY_VALIDATION',
      title: 'Country Validation (Unknown)',
      status: 'NOT_FOUND',
      details: 'earlier uncertain validation',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  ],
  trading_status: 'UNCERTAIN',
}) as never;

const candidate = () => ({
  channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx',
  channelName: 'Test Channel',
  youtubeUrl: 'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx',
  description: '',
  videoTitles: [],
}) as never;

const validationStep = {
  step: 'COUNTRY_VALIDATION',
  title: 'Country Validation (Vietnam)',
  status: 'REJECTED',
  details: '  [P3] AGGREGATED_CONTENT_LANGUAGE: Vietnam (90/100)',
  timestamp: '2026-02-01T00:00:00.000Z',
} as never;

test('Gate-1 rejection is projected onto the known row with audit trail', () => {
  const row = existingRow();
  const out = applyGate1CountryRejectionToExisting(
    row,
    { creatorCountry: 'Vietnam', score: 90, validationStep, now: '2026-02-01T00:00:00.000Z' },
    candidate(),
  );
  assert.equal(out.country_status, 'REJECTED');
  assert.equal(out.country, 'Vietnam');
  assert.equal(out.confidence_score, 90);
  assert.equal(out.scan_status, 'COMPLETED');
  assert.equal(out.last_checked, '2026-02-01T00:00:00.000Z');
  assert.equal(out.inspection_trail.length, 2);
  assert.equal(out.inspection_trail[1], validationStep);
  assert.equal(out.inspection_trail[0].details, 'earlier uncertain validation');
});

test('Gate-1 rejection projection never touches trading/discord ownership', () => {
  const row = existingRow();
  const out = applyGate1CountryRejectionToExisting(
    row,
    { creatorCountry: 'Vietnam', score: 90, validationStep, now: '2026-02-01T00:00:00.000Z' },
    candidate(),
  );
  assert.equal(out.trading_status, 'UNCERTAIN');
  assert.equal(out.discord_status, 'NOT_FOUND');
  assert.equal(out.discord_invite, null);
});

test('hard-rejection branch persists known rows and keeps no-row behavior write-free', () => {
  const source = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const branch = source.slice(
    source.indexOf("if (countryVal.gateDisposition === 'REJECT_EXCLUDED'"),
    source.indexOf("if (countryVal.gateDisposition === 'NEEDS_REVIEW'"),
  );
  // Exactly one upsert, gated on an existing row; the no-row return stays
  // write-free (persisted:false, no channelRecord).
  assert.equal(branch.match(/await upsertChannel\(existing\)/g)?.length, 1);
  assert.match(branch, /if \(existing\) \{[\s\S]*applyGate1CountryRejectionToExisting/);
  assert.match(branch, /persisted: true/);
  assert.match(branch, /persisted: false/);
});
