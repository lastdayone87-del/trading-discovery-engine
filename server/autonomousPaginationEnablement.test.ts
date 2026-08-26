import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(new URL('./db/migrations/125_enable_autonomous_pagination.sql', import.meta.url), 'utf8');

test('pagination enablement migration changes only the boolean control', () => {
  assert.match(migration, /autonomous_pagination_enabled/);
  assert.match(migration, /VALUES \('autonomous_pagination_enabled', 'true'\)/);
  assert.match(migration, /ON CONFLICT \(setting_key\) DO UPDATE/);
  assert.match(migration, /SET setting_value = 'true'/);
  assert.doesNotMatch(migration, /updated_at/);
  assert.doesNotMatch(migration, /UPDATE\s+app_settings\s+SET\s+setting_value.*autonomous_pagination_max_pages/i);
  assert.doesNotMatch(migration, /UPDATE\s+app_settings\s+SET\s+setting_value.*autonomous_pagination_max_low_yield_pages/i);
  assert.doesNotMatch(migration, /INSERT INTO\s+jobs|UPDATE\s+jobs|DELETE FROM\s+jobs/i);
});

test('pagination enablement migration contains no provider or unrelated control changes', () => {
  assert.doesNotMatch(migration, /YOUTUBE|BRAVE|quota|cooldown|retry|queue|country|discord/i);
  assert.doesNotMatch(migration, /DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i);
});
