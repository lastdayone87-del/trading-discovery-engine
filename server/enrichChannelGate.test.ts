import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enrichChannelClaimableDuringCooldown, groqFallbackCoolingDown, allRoutesCoolingDown } from './queueManager';

test('gemini healthy allows ENRICH claim (fallback absent or present)', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: false, groqCooldownActive: false }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: false, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: false }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: false, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: true }), true);
});

test('gemini cooldown without fallback stays blocked (legacy behavior unchanged)', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false }), false);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: false, groqFallbackCooldownActive: false }), false);
});

test('gemini cooldown with healthy groq fallback allows ENRICH claim', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: false }), true);
});

test('gemini cooldown with cooling-down groq fallback stays blocked (anti-DEFER-storm)', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: true }), false);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: false, groqFallbackCooldownActive: true }), false);
});

test('groq fallback cooling-down composes persisted AND local cooldowns', () => {
  assert.equal(groqFallbackCoolingDown(false, 0), false);
  assert.equal(groqFallbackCoolingDown(true, 0), true);
  assert.equal(groqFallbackCoolingDown(false, 1), true);
  assert.equal(groqFallbackCoolingDown(false, 90_000), true);
  assert.equal(groqFallbackCoolingDown(true, 5_000), true);
});

test('gemini cooldown + persisted groq cooldown blocks ENRICH (ledger 429)', () => {
  const fallbackCooling = groqFallbackCoolingDown(true, 0);
  assert.equal(fallbackCooling, true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: fallbackCooling }), false);
});

test('gemini cooldown + local groq cooldown blocks ENRICH (unpersisted 429)', () => {
  const fallbackCooling = groqFallbackCoolingDown(false, 45_000);
  assert.equal(fallbackCooling, true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: fallbackCooling }), false);
});

test('gemini cooldown + both groq cooldowns clear allows ENRICH', () => {
  const fallbackCooling = groqFallbackCoolingDown(false, 0);
  assert.equal(fallbackCooling, false);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: fallbackCooling }), true);
});

test('fallback claim gate consults both persisted and local groq cooldowns per org', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('isGroqOrgCooldownActive('), 'fallback must read the per-org persisted Groq cooldown');
  assert.ok(source.includes('groqOrgCooldownRemainingMs('), 'fallback must read the per-org process-local Groq cooldown');
  assert.ok(source.includes('allRoutesCoolingDown('), 'fallback must stay blocked only while every org is cooling');
});

test('gemini claim gate consults per-account cooldowns, never a global window', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('isGeminiOrgCooldownActive('), 'gemini gate must read the per-account cooldown');
  assert.ok(source.includes('geminiRouteOrg('), 'gemini gate must resolve the account identity per route');
});

test('process-local groq cooldown starts clear in test runtime', async () => {
  const { groqCooldownRemainingMs, resetGroqCooldownForTests } = await import('./evidenceEngine/providers/GroqSemanticProvider');
  resetGroqCooldownForTests();
  assert.equal(groqCooldownRemainingMs(), 0);
});

test('groq route claims only outside its own cooldown', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: true, geminiCooldownActive: false, groqCooldownActive: false }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: true, geminiCooldownActive: false, groqCooldownActive: true }), false);
});

test('a stale cooldown on the idle route never stalls the serving route', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: true, geminiCooldownActive: true, groqCooldownActive: false }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: false, groqCooldownActive: true }), true);
});

test('free-gemini route claims only outside its own cooldown, never paid gemini state', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiFreeSelected: true, geminiCooldownActive: true, groqCooldownActive: false, geminiFreeCooldownActive: false }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiFreeSelected: true, geminiCooldownActive: false, groqCooldownActive: false, geminiFreeCooldownActive: true }), false);
  // Paid-gemini selection ignores the free cooldown entirely.
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: false, groqCooldownActive: false, geminiFreeCooldownActive: true }), true);
});

test('free-gemini cooldown helper reads only the gemini-free ledger', async () => {
  const { isGeminiFreeSemanticCooldownActive } = await import('./providerResilience');
  const fnStr = isGeminiFreeSemanticCooldownActive.toString();
  assert.ok(fnStr.includes('resolveGeminiFreeSemanticCooldownExpiryMs'), 'must resolve via the free-tier resolver');
});

test('pool cooling composes per-route states: open while any account is healthy', () => {
  assert.equal(allRoutesCoolingDown([]), true);
  assert.equal(allRoutesCoolingDown([false]), false);
  assert.equal(allRoutesCoolingDown([true]), true);
  assert.equal(allRoutesCoolingDown([true, false]), false);
  assert.equal(allRoutesCoolingDown([true, true, false, true]), false);
  assert.equal(allRoutesCoolingDown([true, true]), true);
});

test('multi-org groq pool keeps the ENRICH claim open while one org is healthy', () => {
  const poolCooling = allRoutesCoolingDown([true, false]);
  assert.equal(poolCooling, false);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: poolCooling }), true);
  const allCooling = allRoutesCoolingDown([true, true]);
  assert.equal(allCooling, true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false, groqFallbackConfigured: true, groqFallbackCooldownActive: allCooling }), false);
});

test('multi-account gemini pool keeps the ENRICH claim open while one account is healthy', () => {
  assert.equal(allRoutesCoolingDown([true, false, true]), false);
  assert.equal(allRoutesCoolingDown([true, true, true]), true);
});
