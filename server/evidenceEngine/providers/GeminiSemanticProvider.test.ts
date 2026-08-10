import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MULTILINGUAL_CANDIDATE_MODEL,
  GeminiSemanticProvider,
  type SemanticModelClient
} from './GeminiSemanticProvider';
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

function withModelOverrides(candidate: string | undefined, adjudicator: string | undefined) {
  const previousCandidate = process.env.MULTILINGUAL_CANDIDATE_MODEL;
  const previousAdjudicator = process.env.MULTILINGUAL_ADJUDICATOR_MODEL;
  if (candidate === undefined) delete process.env.MULTILINGUAL_CANDIDATE_MODEL;
  else process.env.MULTILINGUAL_CANDIDATE_MODEL = candidate;
  if (adjudicator === undefined) delete process.env.MULTILINGUAL_ADJUDICATOR_MODEL;
  else process.env.MULTILINGUAL_ADJUDICATOR_MODEL = adjudicator;
  return () => {
    if (previousCandidate === undefined) delete process.env.MULTILINGUAL_CANDIDATE_MODEL;
    else process.env.MULTILINGUAL_CANDIDATE_MODEL = previousCandidate;
    if (previousAdjudicator === undefined) delete process.env.MULTILINGUAL_ADJUDICATOR_MODEL;
    else process.env.MULTILINGUAL_ADJUDICATOR_MODEL = previousAdjudicator;
  };
}

test('candidate model 404 retries once with explicitly configured adjudicator model and preserves fallback provenance', async () => {
  const restore = withModelOverrides('gemini-unavailable-test-model', 'gemini-3.6-flash');
  try {
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
    assert.deepEqual(calls, ['gemini-unavailable-test-model', 'gemini-3.6-flash']);
    assert.equal(items[0].polarity, 'NEGATIVE');
    assert.equal(items[0].category, 'IRRELEVANT_DOMAIN');
    assert.equal(items[0].provenance?.semantic?.modelVersion, 'gemini-3.6-flash');
    assert.ok(items[0].provenance?.semantic?.reasonCodes?.includes('SEMANTIC_CANDIDATE_MODEL_404_FALLBACK'));
  } finally {
    restore();
  }
});

test('non-404 permanent failures do not invoke fallback model', async () => {
  const restore = withModelOverrides(undefined, undefined);
  try {
    const calls: string[] = [];
    const client: SemanticModelClient = {
      async classify(_prompt, model) {
        calls.push(model);
        throw new ProviderCallError('invalid request', 'PERMANENT_INPUT', false, { status: 400 });
      }
    };
    const provider = new GeminiSemanticProvider(client);
    await assert.rejects(provider.collectEvidence(input, {} as any), (error: any) => error?.status === 400);
    assert.deepEqual(calls, [DEFAULT_MULTILINGUAL_CANDIDATE_MODEL]);
  } finally {
    restore();
  }
});
