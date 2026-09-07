import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichChannelClaimableDuringCooldown } from './queueManager';

test('gemini route claims only outside its cooldown', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: false }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: false, geminiCooldownActive: true }), false);
});

test('groq route is never blocked by a stale gemini cooldown', () => {
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: true, geminiCooldownActive: true }), true);
  assert.equal(enrichChannelClaimableDuringCooldown({ groqSelected: true, geminiCooldownActive: false }), true);
});
