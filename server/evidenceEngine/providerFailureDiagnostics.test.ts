import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceBasedTradingEngine } from './index';
import type { EvidenceProvider } from './types';
import { ProviderCallError } from '../providerResilience';

const baseInput = {
  channel_name: 'Example creator',
  description: 'Enough creator-level context to exercise the evidence collection report safely.',
  video_titles: ['Example recent video', 'Another recent video'],
  country: 'United States'
};

test('typed rate-limit failure is preserved in provider coverage diagnostics', async () => {
  const provider: EvidenceProvider = {
    name: 'gemini_semantic',
    async collectEvidence() {
      throw new ProviderCallError('rate limited', 'RATE_LIMIT', true, {
        status: 429,
        providerReasons: ['RATE_LIMIT_EXCEEDED']
      });
    }
  };
  const decision = await new EvidenceBasedTradingEngine([provider]).evaluateChannel(baseInput);
  const report = decision.evidenceCollection.providers[0];
  assert.equal(report.availability, 'FAILED');
  assert.equal(report.outcome, 'FAILED_PROVIDER');
  assert.deepEqual(report.reasonCodes, ['PROVIDER_RATE_LIMIT', 'RATE_LIMIT_EXCEEDED']);
  assert.equal(report.reason, 'Provider failure (RATE_LIMIT).');
});

test('typed permanent-input failure is preserved without raw provider message', async () => {
  const provider: EvidenceProvider = {
    name: 'gemini_semantic',
    async collectEvidence() {
      throw new ProviderCallError('potentially verbose provider payload', 'PERMANENT_INPUT', false, {
        status: 400,
        providerReasons: ['INVALID_ARGUMENT']
      });
    }
  };
  const decision = await new EvidenceBasedTradingEngine([provider]).evaluateChannel(baseInput);
  const report = decision.evidenceCollection.providers[0];
  assert.deepEqual(report.reasonCodes, ['PROVIDER_PERMANENT_INPUT', 'INVALID_ARGUMENT']);
  assert.equal(report.reason, 'Provider failure (PERMANENT_INPUT).');
  assert.doesNotMatch(report.reason || '', /verbose provider payload/);
});
