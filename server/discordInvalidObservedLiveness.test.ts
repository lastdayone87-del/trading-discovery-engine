import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const migration = readFileSync('server/db/migrations/128_discord_invalid_observed_liveness.sql', 'utf8');
const ui = readFileSync('src/components/ResultsTable.tsx', 'utf8');

test('migration 128 has a unique version prefix', () => {
  const dupes = readdirSync('server/db/migrations').filter(f => f.startsWith('128_'));
  assert.deepEqual(dupes, ['128_discord_invalid_observed_liveness.sql']);
});

test('trigger projects INVALID_OBSERVED into liveness instead of preserving stale ACTIVE', () => {
  assert.match(migration, /WHEN NEW\.operational_outcome='INVALID_OBSERVED' THEN 'INVALID_OBSERVED'/);
  // Terminal mappings are unchanged.
  assert.match(migration, /WHEN NEW\.operational_outcome='SUCCEEDED' THEN 'ACTIVE'/);
  assert.match(migration, /WHEN NEW\.operational_outcome='CONFIRMED_INVALID' THEN 'DEAD'/);
  // Inconclusive outcomes still preserve last-known-good liveness.
  assert.match(migration, /ELSE liveness_status END/);
});

test('backfill touches only evidence-confirmed stale rows', () => {
  const backfill = migration.slice(migration.indexOf('UPDATE discord_candidates'));
  assert.match(backfill, /candidate_status='VALIDATION_FAILED'/);
  assert.match(backfill, /validation_status='RETRY_PENDING'/);
  assert.match(backfill, /liveness_status='ACTIVE'/);
  assert.match(backfill, /operational_outcome = 'INVALID_OBSERVED'/);
  assert.doesNotMatch(backfill, /candidate_status='VALIDATED'/);
});

test('dashboard no longer presents non-trading/uncertain locators as Validated', () => {
  // TRADING_RELEVANT keeps the Validated label; nothing is refiltered.
  assert.match(ui, /Validated candidate:/);
  assert.match(ui, /Live invite · non-trading:/);
  assert.match(ui, /Live invite · relevance uncertain:/);
  assert.match(ui, /discord_relevance_status === 'TRADING_RELEVANT'/);
});

test('stale-active banner wording distinguishes retention from re-check failure', () => {
  assert.match(ui, /Previously verified active · latest re-check inconclusive, retained/);
  assert.match(ui, /Discovered · validation failed/);
});
