import test from 'node:test';
import assert from 'node:assert/strict';
import { runSemanticShadowComparison } from './semanticShadowHarness';
import { GroqSemanticProvider } from './providers/GroqSemanticProvider';
import { GeminiSemanticProvider } from './providers/GeminiSemanticProvider';
import type { SemanticModelClient } from './providers/GeminiSemanticProvider';

const input = {
  channel_id: 'channel-1',
  channel_name: 'Example creator',
  description: 'Creator-level description with enough context for semantic classification.',
  video_titles: ['Example recent video'],
  video_descriptions: ['Description one'],
  country: 'United States',
} as any;

const unrelated = {
  label: 'UNRELATED', confidence: 96, supportedLanguage: true, reasonCodes: ['CREATOR_FOCUS_UNRELATED'],
  explanation: 'Sports commentary, not trading.', concepts: ['sports commentary'],
  languages: [{ language: 'en', script: 'Latin', confidence: 100, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }],
};

const trading = {
  label: 'ACTIVE_TRADING', confidence: 92, supportedLanguage: true, reasonCodes: ['CREATOR_FOCUS_TRADING'],
  explanation: 'Teaches price action.', concepts: ['price action'],
  languages: [{ language: 'en', script: 'Latin', confidence: 100, field: 'channel_bio' }],
  citations: [{ field: 'channel_bio' }],
};

const of = (value: unknown): SemanticModelClient => ({ classify: async () => value });
const cases = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `case-${i}`, input }));

test('identical stub outputs agree fully with zero disagreements', async () => {
  const report = await runSemanticShadowComparison(
    cases(3),
    { gemini: new GeminiSemanticProvider(of(unrelated)), groq: new GroqSemanticProvider(of(unrelated)) },
    {} as any,
  );
  assert.equal(report.cases, 3);
  assert.equal(report.evaluated, 3);
  assert.deepEqual(report.failures, []);
  assert.equal(report.agreement.label, 1);
  assert.equal(report.agreement.abstention, 1);
  assert.equal(report.agreement.polarity, 1);
  assert.equal(report.meanAbsWeightDelta, 0);
  assert.deepEqual(report.disagreements, []);
});

test('divergent labels are flagged with per-case detail', async () => {
  const report = await runSemanticShadowComparison(
    cases(2),
    { gemini: new GeminiSemanticProvider(of(unrelated)), groq: new GroqSemanticProvider(of(trading)) },
    {} as any,
  );
  assert.equal(report.evaluated, 2);
  assert.equal(report.agreement.label, 0);
  assert.equal(report.agreement.polarity, 0);
  assert.equal(report.disagreements.length, 2);
  assert.equal(report.disagreements[0].groq && 'label' in report.disagreements[0].groq
    ? (report.disagreements[0].groq as { label: string }).label : '', 'ACTIVE_TRADING');
  assert.ok((report.meanAbsWeightDelta as number) > 0);
});

test('one-sided provider failure is isolated and reported without losing the other side', async () => {
  const failing: SemanticModelClient = { classify: async () => { throw new Error('boom'); } };
  const report = await runSemanticShadowComparison(
    cases(2),
    { gemini: new GeminiSemanticProvider(of(unrelated)), groq: new GroqSemanticProvider(failing) },
    {} as any,
  );
  assert.equal(report.cases, 2);
  assert.equal(report.evaluated, 0);
  assert.equal(report.failures.length, 2);
  assert.ok(report.failures.every(f => f.side === 'groq'));
  assert.deepEqual(report.disagreements, []);
});
