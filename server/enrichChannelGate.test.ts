import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichChannelClaimableDuringCooldown } from './queueManager';

test('gemini route claims only outside its own cooldown', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: false, groqCooldownActive: false }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true, groqCooldownActive: false }), false);
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
