import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDiscoveryRecall } from './discoveryRecallRunner';
import { runE2EYield } from './e2eYieldRunner';
import { runClassificationRecall } from './classificationRecallRunner';

test('discovery recall applies FOUND/DUPLICATE/NOT_FOUND/WRONG ground rules', () => {
  const result = classifyDiscoveryRecall(
    {
      query: 'DAX Analyse',
      country: 'Germany',
      language: 'de',
      results: [
        { channelId: 'UCaaa', page: 1, market: 'Germany', language: 'de' },
        { channelId: 'UCaaa', page: 2, market: 'Germany', language: 'de' },
        { channelId: 'UCbbb', page: 5, market: 'Germany', language: 'de' },
        { channelId: 'UCccc', page: 1, market: 'France', language: 'fr' },
        { channelId: 'UCddd', page: 2, market: 'Germany', language: 'en' },
      ],
    },
    ['UCaaa', 'UCbbb', 'UCccc', 'UCddd', 'UCeee'],
    'Germany',
    'de',
  );
  assert.equal(result.verdicts['UCaaa'], 'FOUND');
  assert.equal(result.verdicts['UCbbb'], 'NOT_FOUND');
  assert.equal(result.verdicts['UCccc'], 'WRONG_MARKET');
  assert.equal(result.verdicts['UCddd'], 'WRONG_LANGUAGE');
  assert.equal(result.verdicts['UCeee'], 'NOT_FOUND');
  assert.equal(result.duplicates, 1);
  assert.equal(result.found, 1);
  assert.deepEqual(result.missed.sort(), ['UCbbb', 'UCeee']);
  assert.equal(result.recall, 1 / 5);
});

test('discovery recall is empty-safe', () => {
  const result = classifyDiscoveryRecall(
    { query: 'x', country: 'Germany', language: 'de', results: [] },
    [],
    'Germany',
    'de',
  );
  assert.equal(result.recall, null);
});

test('e2e yield extracts frozen payloads with zero live calls', () => {
  const result = runE2EYield([
    {
      channelId: 'UCaaa',
      payload: {
        lane: 'CHANNEL',
        query: 'DAX Trading',
        items: [
          {
            id: { channelId: 'UCaaa' },
            snippet: {
              channelTitle: 'DAX Trader',
              title: 'DAX Trader',
              description: 'Trading lernen mit Markttechnik und Risiko pro Trade.',
              thumbnails: { high: { url: 'https://img/x.jpg' } },
            },
          },
        ],
      },
      expectExtracted: true,
      expectDescription: true,
      expectVideoTitles: false,
    },
    {
      channelId: 'UCbbb',
      payload: {
        lane: 'VIDEO',
        query: 'DAX Analyse',
        items: [
          {
            snippet: {
              channelId: 'UCbbb',
              channelTitle: 'DAX Trader',
              title: 'DAX Morgenanalyse',
              description: 'Tägliche DAX Analyse mit Orderflow',
              thumbnails: { high: { url: 'https://img/y.jpg' } },
            },
          },
        ],
      },
      expectExtracted: true,
      expectDescription: false,
      expectVideoTitles: true,
    },
    {
      channelId: 'UCzzz',
      payload: { lane: 'VIDEO', query: 'DAX Analyse', items: [] },
      expectExtracted: false,
      expectDescription: false,
      expectVideoTitles: false,
    },
  ]);
  assert.equal(result.extractionRate, 2 / 3);
  assert.equal(result.completenessRate, 1);
  assert.equal(result.details[1].hasVideoTitles, true);
});

test('classification recall separates trading education from distractors', () => {
  const result = runClassificationRecall([
    {
      channelId: 'UCaaa',
      country: 'Germany',
      description: 'Trading lernen mit Markttechnik und Risiko pro Trade.',
      videoTitles: ['DAX Trade Analyse und Stop Loss'],
      expected: 'TRADING',
    },
    {
      channelId: 'UCbbb',
      country: 'Germany',
      description: 'Bundesliga reaction und Garten vlog.',
      videoTitles: ['Spieltag Analyse'],
      expected: 'NON_TRADING',
    },
  ]);
  assert.equal(result.evaluated, 2);
  assert.equal(result.correct, 2);
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 1);
});

test('pilot stage-1 fixtures carry per-fact sources and honest audit status', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixtures = JSON.parse(
    await readFile(new URL('./fixtures/pilot-stage1.json', import.meta.url), 'utf8'),
  );
  assert.ok(Array.isArray(fixtures) && fixtures.length > 0);
  for (const entry of fixtures) {
    for (const fact of ['identityLinkage', 'domicile', 'trading', 'marketRelevance', 'liveness90d']) {
      assert.ok(entry.facts[fact] !== undefined, `${entry.channelId} missing fact ${fact}`);
    }
    const labels = new Set(entry.sources.map((s: any) => s.fact));
    for (const label of ['A', 'B', 'C', 'D', 'E']) {
      assert.ok(labels.has(label), `${entry.channelId} missing source for fact ${label}`);
    }
    assert.equal(entry.audit?.status, 'pipeline-sourced');
  }
  const manifest = JSON.parse(
    await readFile(new URL('./fixtures/pilot-manifest.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.status, 'NOT YET MEASURED');
});
