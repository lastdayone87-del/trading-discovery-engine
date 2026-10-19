import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Contract coverage for the bounded unexpected-404 (e.g. provider error 50270)
// Discord policy wiring. The behavioral validator tests live in
// discordValidatorRobustness.test.ts; these assert the durable observation
// count is sourced from discord_check_attempts and threaded by the worker.

test('dbCore exposes a durable count of prior unexpected-404 provider failures', () => {
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  assert.match(dbCore, /export async function countDiscordProviderFailureObservations/);
  assert.match(dbCore, /operational_outcome='PROVIDER_FAILURE' AND http_status=404/);
  assert.match(dbCore, /FROM discord_check_attempts/);
});

test('queue manager threads the prior unexpected-404 observation count into validation', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(queue, /countDiscordProviderFailureObservations\(channel\.channel_id,candidate\.candidateId,locator\)/);
  assert.match(queue, /priorProviderFailureObservations/);
  assert.match(queue, /priorProviderFailureObservations\s*\n?\s*\}/);
});

test('validator exports the bounded observation ceiling as a named constant', () => {
  const validator = readFileSync(new URL('./discordValidator.ts', import.meta.url), 'utf8');
  assert.match(validator, /export const DISCORD_UNEXPECTED_404_BOUNDED_OBSERVATIONS = 3/);
  assert.match(validator, /priorProviderFailureObservations\?: number/);
  assert.match(validator, /boundedNotFoundExhausted/);
  assert.match(validator, /classified terminal/);
});
