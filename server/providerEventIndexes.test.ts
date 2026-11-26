import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const names = [
  'idx_provider_events_gemini_active_org_time',
  'idx_provider_events_groq_rate_org_time',
  'idx_provider_events_rate_provider_time',
  'idx_provider_events_run_id',
];

test('provider event indexes target capacity reads and run accounting', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('./db/migrations/209_provider_event_indexes.sql', import.meta.url), 'utf8');
  for (const name of names) {
    assert.ok(dbCore.includes(name), `dbCore must know ${name}`);
    assert.ok(migration.includes(name), `migration 209 must adopt ${name}`);
  }
  assert.ok(dbCore.includes("WHERE provider='gemini' AND COALESCE(request_metadata->>'geminiCapacityDeferral','') <> 'true'"));
  assert.ok(dbCore.includes("WHERE provider='groq' AND status='RATE_LIMITED' AND COALESCE(request_metadata->>'groqCooldownDeferral','') <> 'true'"));
  assert.ok(dbCore.includes('ON public.provider_call_events (run_id, provider, operation, status) WHERE run_id IS NOT NULL'));
  assert.match(dbCore, /const migration209 = await client\.query\('SELECT 1 FROM schema_migrations WHERE version=209'\);/);
  assert.match(dbCore, /if \(!migration209\.rowCount\) await ensureProviderEventIndexes\(client\);/);
  assert.match(dbCore, /providerEventIndexMigration\.rowCount\) await ensureProviderEventIndexes\(client\)/);
});
