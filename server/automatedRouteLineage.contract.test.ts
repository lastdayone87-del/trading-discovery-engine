import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

test('authenticated automated search routes through the governed autonomous producer', () => {
  const server = here('../server.ts');
  assert.match(server, /runAutonomousDiscoveryCycle\(country, undefined, req\.requestId\)/);
  assert.match(server, /const report = await runAutonomousDiscoveryCycle\(country, undefined, req\.requestId\);/);
  assert.match(server, /const queries = report\.queries \|\|/);
  assert.match(server, /Scheduled \$\{report\.queuedCount \|\| 0\} governed queries/);
  assert.doesNotMatch(server, /addAutomatedCountrySearch/);
});

test('legacy automated direct-enqueue helper is absent from queueManager', () => {
  const queueManager = here('./queueManager.ts');
  assert.doesNotMatch(queueManager, /export async function addAutomatedCountrySearch/);
  assert.doesNotMatch(queueManager, /selectNextQueryForCountry/);
});

test('automated route preserves structured producer diagnostics in its response', () => {
  const server = here('../server.ts');
  assert.match(server, /queuedCount: report\.queuedCount \|\| 0, diagnostics: report\.diagnostics/);
});
