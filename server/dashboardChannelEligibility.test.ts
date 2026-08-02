import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATOR_VISIBLE_CHANNEL_SQL } from './db';

test('operator-visible channel policy excludes rejected and disallowed countries', () => {
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /country_status <> 'REJECTED'/);
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /scan_status <> 'SKIPPED_EXCLUDED'/);
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /trading_status <> 'NON_TRADING'/);
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /NOT EXISTS[\s\S]+FROM excluded_countries/);
  assert.match(OPERATOR_VISIBLE_CHANNEL_SQL, /excluded\.country_name[\s\S]+channels\.country/);
});

test('dashboard summary and channel listing share one eligibility policy', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./db.ts', import.meta.url), 'utf8'));
  assert.match(source, /dashboardServingPredicate/);
  assert.match(source, /release5_dashboard_serving_mode/);
  assert.match(source, /FROM channels WHERE \$\{serving\.predicate\}/);
});

test('dashboard pending review count uses the durable review queue', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./db.ts', import.meta.url), 'utf8'));
  assert.match(source, /SELECT COUNT\(\*\)::int FROM channel_reviews WHERE state='PENDING'/);
  assert.match(source, /pendingReviews:'DURABLE_REVIEW_QUEUE'/);
});
