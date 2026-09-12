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
  assert.deepEqual(result.missed.sort(), ['UCbbb', 'UCccc', 'UCddd', 'UCeee']);
  assert.equal(result.recall, 1 / 5);
});

test('discovery recall counts valid hits regardless of page order', () => {
  const result = classifyDiscoveryRecall(
    {
      query: 'DAX Analyse',
      country: 'Germany',
      language: 'de',
      results: [
        { channelId: 'UClate', page: 5, market: 'Germany', language: 'de' },
        { channelId: 'UClate', page: 2, market: 'Germany', language: 'de' },
      ],
    },
    ['UClate'],
    'Germany',
    'de',
  );
  assert.equal(result.verdicts['UClate'], 'FOUND');
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.missed, []);
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

test('e2e yield uses expected-only denominators with separate false positives', () => {
  const videoItem = (channelId: string, title?: string, description?: string) => ({
    snippet: {
      channelId,
      channelTitle: 'Test Channel',
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      thumbnails: { high: { url: 'https://img/x.jpg' } },
    },
  });
  const result = runE2EYield([
    { // 1. expected + successfully extracted (complete: VIDEO lane carries
      // titles; channel bio only comes from CHANNEL lane or hydration)
      channelId: 'UCfull',
      payload: { lane: 'VIDEO', query: 'DAX Analyse', items: [videoItem('UCfull', 'DAX Morgenanalyse', 'Tägliche Analyse')] },
      expectExtracted: true,
      expectDescription: false,
      expectVideoTitles: true,
    },
    { // 2. expected + partially extracted (extracted, description missing)
      channelId: 'UCpart',
      payload: { lane: 'VIDEO', query: 'DAX Analyse', items: [videoItem('UCpart', 'DAX Analyse')] },
      expectExtracted: true,
      expectDescription: true,
      expectVideoTitles: true,
    },
    { // 3. expected + missing (nothing extracted)
      channelId: 'UCmiss',
      payload: { lane: 'VIDEO', query: 'DAX Analyse', items: [] },
      expectExtracted: true,
      expectDescription: false,
      expectVideoTitles: false,
    },
    { // 4. unexpected extraction on a negative case (false positive)
      channelId: 'UCghost',
      payload: { lane: 'VIDEO', query: 'DAX Analyse', items: [videoItem('UCghost', 'Ghost Video')] },
      expectExtracted: false,
      expectDescription: false,
      expectVideoTitles: false,
    },
    { // 5. clean negative (correctly absent)
      channelId: 'UCclean',
      payload: { lane: 'VIDEO', query: 'DAX Analyse', items: [] },
      expectExtracted: false,
      expectDescription: false,
      expectVideoTitles: false,
    },
  ]);
  assert.equal(result.evaluated, 5);
  assert.equal(result.expectedCases, 3);
  assert.equal(result.successfulExpectedExtractions, 2);
  assert.equal(result.completeExpectedExtractions, 1);
  assert.equal(result.extractionRate, 2 / 3);
  assert.equal(result.completenessRate, 1 / 3);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.falsePositiveRate, 1 / 2);
});

test('e2e yield rates are null without expected or negative cases', () => {
  const empty = runE2EYield([]);
  assert.equal(empty.extractionRate, null);
  assert.equal(empty.completenessRate, null);
  assert.equal(empty.falsePositiveRate, null);
  const noNegatives = runE2EYield([
    {
      channelId: 'UCa',
      payload: { lane: 'VIDEO', query: 'x', items: [] },
      expectExtracted: true,
      expectDescription: false,
      expectVideoTitles: false,
    },
  ]);
  assert.equal(noNegatives.falsePositiveRate, null);
});
test('channel-lane query-echo titles do not count as title coverage', () => {
  const result = runE2EYield([
    {
      channelId: 'UCecho',
      payload: {
        lane: 'CHANNEL',
        query: 'DAX Trading',
        items: [
          {
            id: { channelId: 'UCecho' },
            snippet: {
              channelTitle: 'Echo Channel',
              title: 'Echo Channel',
              description: 'Echte Kanalbeschreibung über Trading.',
              thumbnails: { high: { url: 'https://img/w.jpg' } },
            },
          },
        ],
      },
      expectExtracted: true,
      expectDescription: true,
      expectVideoTitles: true,
    },
  ]);
  // Extracted with a real description, but titles are only the query echo.
  assert.equal(result.successfulExpectedExtractions, 1);
  assert.equal(result.completeExpectedExtractions, 0);
  assert.equal(result.extractionRate, 1);
  assert.equal(result.completenessRate, 0);
  assert.equal(result.falsePositives, 0);
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
    // Liveness is tri-state: true = proven live, false = proven NOT live
    // (requires disproving evidence), UNPROVEN = insufficient evidence.
    // Unknown must never be recorded as false.
    assert.ok(
      [true, false, 'UNPROVEN'].includes(entry.facts.liveness90d),
      `${entry.channelId} has invalid liveness value`,
    );
    if (entry.facts.liveness90d === 'UNPROVEN') {
      const evidence = entry.sources.find((s: any) => s.fact === 'E');
      assert.ok(
        evidence && /UNPROVEN|unproven|pending/i.test(JSON.stringify(evidence) + JSON.stringify(entry.audit)),
        `${entry.channelId} UNPROVEN liveness must say so in its evidence`,
      );
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
