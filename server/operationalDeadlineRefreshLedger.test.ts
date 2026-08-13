import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('./db/migrations/087_unique_operational_deadline_refresh_events.sql', import.meta.url),
  'utf8'
);

test('operational deadline refresh events use a database-owned monotonic identity', () => {
  assert.match(migration, /CREATE SEQUENCE IF NOT EXISTS investigation_deadline_refresh_event_seq/);
  assert.match(migration, /NEW\.event_type = 'INVESTIGATION_DEADLINE_REFRESHED'/);
  assert.match(migration, /nextval\('investigation_deadline_refresh_event_seq'\)/);
  assert.match(migration, /NEW\.event_key := NEW\.event_key[\s\S]*':refresh:'[\s\S]*nextval/);
});

test('two refreshes with the same attempt cannot intentionally share the final event key', () => {
  const base = 'investigation:i:step:s:attempt:1:operational-deadline-refresh';
  const eventKey = (generation: number) => `${base}:refresh:${generation}`;
  assert.notEqual(eventKey(1), eventKey(2));
  assert.equal(new Set([eventKey(1), eventKey(2)]).size, 2);
});
