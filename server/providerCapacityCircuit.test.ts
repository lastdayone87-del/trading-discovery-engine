import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('semantic claim gate and provider circuit are wired', () => {
  const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');
  const resilience = readFileSync(new URL('./providerResilience.ts', import.meta.url), 'utf8');
  assert.match(queue, /getSemanticCapacityStatus/);
  assert.match(queue, /semanticCapacity\.available/);
  assert.match(dbCore, /providerCapacityExhausted/);
  assert.match(dbCore, /RETRYING_WITHOUT_ATTEMPT/);
  assert.match(resilience, /recordProviderCapacityExhausted/);
  assert.match(resilience, /recordProviderCapacitySuccess/);
  assert.match(resilience, /typed\.quotaScope==='DAILY'/);
  assert.match(resilience, /nextPacificMidnightMs/);
  assert.match(resilience, /providerCapacityExhausted:true/);
});
