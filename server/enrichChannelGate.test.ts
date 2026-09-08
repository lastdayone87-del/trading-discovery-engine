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
