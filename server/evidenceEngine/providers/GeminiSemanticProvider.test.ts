import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiSemanticProvider, type SemanticModelClient } from './GeminiSemanticProvider';
import { ProviderCallError } from '../../providerResilience';

const input = {
  channel_id: 'channel-1',
  channel_name: 'Example creator',
  description: 'Creator-level description with enough context for semantic classification.',
  video_titles: ['Example recent video', 'Another recent video'],
  video_descriptions: ['Description one', 'Description two'],
  country: 'United States'
} as any;

const unrelatedResult = {
  label: 'UNRELATED',
  confidence: 96,
  supportedLanguage: true,
  reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
  explanation: 'The creator focuses on sports commentary rather than trading.',
  concepts: ['sports commentary'],
  languages: [{ language: 'en', script: 'Latin', confidence: 100, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }]
};

test('candidate model 404 retries once with adjudicator model and preserves fallback provenance', async () => {
  const calls: string[] = [];
  const client: SemanticModelClient = {
    async classify(_prompt, model) {
      calls.push(model);
      if (calls.length === 1) throw new ProviderCallError('model unavailable', 'PERMANENT_INPUT', false, { status: 404 });
      return unrelatedResult;
    }
  };
  const provider = new GeminiSemanticProvider(client);
  const items = await provider.collectEvidence(input, {} as any);
  assert.deepEqual(calls, ['gemini-2.5-flash-lite', 'gemini-2.5-flash']);
  assert.equal(items[0].polarity, 'NEGATIVE');
  assert.equal(items[0].category, 'IRRELEVANT_DOMAIN');
  assert.equal(items[0].provenance?.semantic?.modelVersion, 'gemini-2.5-flash');
  assert.ok(items[0].provenance?.semantic?.reasonCodes?.includes('SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'));
});

test('non-404 permanent failures do not invoke fallback model', async () => {
  const calls: string[] = [];
  const client: SemanticModelClient = {
    async classify(_prompt, model) {
      calls.push(model);
      throw new ProviderCallError('invalid request', 'PERMANENT_INPUT', false, { status: 400 });
    }
  };
  const provider = new GeminiSemanticProvider(client);
  await assert.rejects(provider.collectEvidence(input, {} as any), (error: any) => error?.status === 400);
  assert.deepEqual(calls, ['gemini-2.5-flash-lite']);
});
