import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applySemanticPrefilter,
  evaluateSemanticPrefilter,
  recordSemanticPrefilterOutcome,
  resetSemanticPrefilterMetricsForTests,
  resetSemanticPrefilterWarningsForTests,
  SEMANTIC_PREFILTER_POLICY_VERSION,
  semanticPrefilterInputFromRaw,
  semanticPrefilterMode,
  semanticPrefilterSnapshot,
  type SemanticPrefilterInput,
} from './semanticPrefilter';
import { GeminiSemanticProvider } from './evidenceEngine/providers/GeminiSemanticProvider';
import { GroqSemanticProvider } from './evidenceEngine/providers/GroqSemanticProvider';
import { GeminiFreeSemanticProvider } from './evidenceEngine/providers/GeminiFreeSemanticProvider';
import type { RawChannelInput } from './evidenceEngine/types';

const NOW = Date.parse('2026-11-07T00:00:00Z');

const positives: Array<[string, SemanticPrefilterInput]> = [
  ['english trading', { channelName: 'Order Flow Lab', description: 'Day trading futures with price action and risk controls.' }],
  ['spanish trading', { channelName: 'Mesa Abierta', description: 'Aprende trading, bolsa y análisis técnico cada semana.' }],
  ['japanese trading', { channelName: '東京トレーダー', description: '株式投資とデイトレードのチャンネルです。' }],
  ['dormant trading', { channelName: 'Old FX Desk', description: 'Forex trader sharing entries.', latestUploadAt: '2019-01-01T00:00:00Z', uploadsLast365Days: 0 }],
  ['low subscriber trading', { channelName: 'Small Caps', description: 'I teach stocks and options.', subscriberCount: 10, videoCount: 1 }],
  ['crypto trading', { channelName: 'Chain Desk', description: 'Bitcoin and crypto market analysis.' }],
  ['broad finance', { channelName: 'Market Notes', description: 'Investing and markets explained every week.' }],
];

const negatives: Array<[string, SemanticPrefilterInput]> = [
  ['gaming', { channelName: 'Block World', description: 'Minecraft gameplay walkthrough and speedrun.' }],
  ['cooking', { channelName: 'Home Kitchen', description: 'Easy recipes and cooking tips.' }],
  ['music', { channelName: 'Night Wave', description: 'Official music video and lyrics.' }],
  ['beauty', { channelName: 'Glow Lab', description: 'Makeup tutorial and beauty vlog.' }],
  ['sports', { channelName: 'Court Side', description: 'NBA highlights and full game replays.' }],
  ['lifestyle', { channelName: 'Roam Diaries', description: 'Daily travel vlog and food vlog.' }],
  ['stale non-finance', { channelName: 'Old Hobby', description: 'My random life updates.', latestUploadAt: '2018-01-01T00:00:00Z', uploadsLast365Days: 0 }],
  ['thin low audience', { channelName: 'Tiny Channel', description: 'Hi', subscriberCount: 5, videoCount: 1 }],
];

test('labeled prefilter sample has zero false negatives and withholds at least 30%', () => {
  const positiveDecisions = positives.map(([label, input]) => ({ label, decision: evaluateSemanticPrefilter(input, NOW) }));
  const negativeDecisions = negatives.map(([label, input]) => ({ label, decision: evaluateSemanticPrefilter(input, NOW) }));
  const falseNegatives = positiveDecisions.filter(({ decision }) => decision.disposition === 'WITHHOLD_SEMANTIC');
  assert.deepEqual(falseNegatives, [], 'no labeled trading creator may be withheld');
  const withheld = negativeDecisions.filter(({ decision }) => decision.disposition === 'WITHHOLD_SEMANTIC');
  assert.ok(
    withheld.length / negativeDecisions.length >= 0.3,
    `expected >=30% unrelated reduction, got ${withheld.length}/${negativeDecisions.length}`
  );
  for (const decision of [...positiveDecisions, ...negativeDecisions].map(entry => entry.decision)) {
    assert.equal(decision.policyVersion, SEMANTIC_PREFILTER_POLICY_VERSION);
  }
});

test('a finance signal vetoes an unrelated-domain cue', () => {
  const decision = evaluateSemanticPrefilter({
    channelName: 'Valorant Trading Strategies',
    description: 'Gaming clips plus day trading futures setups.',
  }, NOW);
  assert.equal(decision.disposition, 'CLASSIFY');
  assert.ok(decision.reasonCodes.includes('FINANCE_SIGNAL_PRESENT'));
});

test('finance evidence in transcripts, visuals, corpus, and link labels vetoes withholding at full length', () => {
  const padding = ` ${'unrelated lifestyle text '.repeat(300)}`;
  const decision = evaluateSemanticPrefilter({
    channelName: 'Minecraft gameplay walkthrough',
    description: `${padding}Minecraft gameplay walkthrough.`,
    transcriptExcerpts: [`${padding} We review futures order flow and risk.`],
    visualEvidence: [`${padding} Chart shows a trading setup.`],
    evidenceCorpus: [`${padding} Technical analysis of the market.`],
    externalLinkLabels: [`${padding} My broker`],
  }, NOW);
  assert.equal(decision.disposition, 'CLASSIFY');
  assert.ok(decision.reasonCodes.includes('FINANCE_SIGNAL_PRESENT'));
});

test('an empty videos array still uses populated legacy titles and descriptions', () => {
  const raw: RawChannelInput = {
    channel_name: 'Quiet Channel',
    description: '',
    videos: [],
    video_titles: ['Futures trading for beginners'],
    video_descriptions: ['Order flow and risk management.'],
  };
  const input = semanticPrefilterInputFromRaw(raw);
  assert.deepEqual(input.videoTitles, ['Futures trading for beginners']);
  assert.deepEqual(input.videoDescriptions, ['Order flow and risk management.']);
  assert.equal(evaluateSemanticPrefilter(input, NOW).disposition, 'CLASSIFY');
  assert.ok(evaluateSemanticPrefilter(input, NOW).matchedSignals.includes('TRADING_LITERAL'));
});

test('unmodeled detected languages veto withholding before stale and audience rules', () => {
  const decision = evaluateSemanticPrefilter({
    channelName: 'Mkulima Channel',
    description: 'Kilimo na mazao.',
    detectedLanguages: ['sw'],
    subscriberCount: 5,
    videoCount: 1,
    latestUploadAt: '2018-01-01T00:00:00Z',
    uploadsLast365Days: 0,
    videoTitles: ['Minecraft gameplay walkthrough'],
  }, NOW);
  assert.equal(decision.disposition, 'CLASSIFY');
  assert.ok(decision.reasonCodes.includes('UNMODELED_LANGUAGE_NEEDS_SEMANTICS'));
});

test('a mixed-language hint list keeps semantics when any language is unmodeled', () => {
  const decision = evaluateSemanticPrefilter({
    channelName: 'Mkulima Channel',
    description: 'Kilimo na mazao.',
    detectedLanguages: ['en', 'sw'],
    subscriberCount: 5,
    videoCount: 1,
    latestUploadAt: '2018-01-01T00:00:00Z',
    uploadsLast365Days: 0,
    videoTitles: ['Minecraft gameplay walkthrough'],
  }, NOW);
  assert.equal(decision.disposition, 'CLASSIFY');
  assert.ok(decision.reasonCodes.includes('UNMODELED_LANGUAGE_NEEDS_SEMANTICS'));
});

test('accented finance terms match with Unicode-aware boundaries', () => {
  const decision = evaluateSemanticPrefilter({
    channelName: 'Analyse du marché',
    description: 'Bourse et investissement.',
  }, NOW);
  assert.equal(decision.disposition, 'CLASSIFY');
  assert.ok(decision.matchedSignals.includes('FRENCH_FINANCE'));
});

test('retrieval-only corpus text cannot veto withholding for an unrelated creator', () => {
  const raw: RawChannelInput = {
    channel_name: 'Block World',
    description: 'Minecraft gameplay walkthrough and speedrun.',
    evidence_corpus: [
      { id: 'retrieval-hit', field: 'search_match_context', text: 'Futures trading order flow and market analysis.', sourceFamilyId: 'search-match' },
      { id: 'creator-bio', field: 'channel_bio', text: 'Minecraft gameplay walkthrough and speedrun.', sourceFamilyId: 'channel' },
    ],
  };
  const projected = semanticPrefilterInputFromRaw(raw);
  assert.deepEqual(projected.evidenceCorpus, ['Minecraft gameplay walkthrough and speedrun.']);
  assert.equal(evaluateSemanticPrefilter(projected, NOW).disposition, 'WITHHOLD_SEMANTIC');
});

test('creator-owned corpus finance evidence still vetoes withholding', () => {
  const raw: RawChannelInput = {
    channel_name: 'Block World',
    description: 'Minecraft gameplay walkthrough and speedrun.',
    evidence_corpus: [
      { id: 'retrieval-hit', field: 'search_match_context', text: 'Minecraft gameplay walkthrough', sourceFamilyId: 'search-match' },
      { id: 'creator-bio', field: 'channel_bio', text: 'I also teach futures trading risk management.', sourceFamilyId: 'channel' },
    ],
  };
  const projected = semanticPrefilterInputFromRaw(raw);
  assert.equal(evaluateSemanticPrefilter(projected, NOW).disposition, 'CLASSIFY');
});

test('raw audience counts are projected into the prefilter and can withhold a thin surface', () => {
  const raw: RawChannelInput = {
    channel_name: 'Tiny Channel',
    description: 'Hi',
    subscriber_count: 5,
    video_count: 1,
  };
  const projected = semanticPrefilterInputFromRaw(raw);
  assert.equal(projected.subscriberCount, 5);
  assert.equal(projected.videoCount, 1);
  assert.equal(evaluateSemanticPrefilter(projected, NOW).disposition, 'WITHHOLD_SEMANTIC');
});

test('ingestion threads observed video volume alongside subscribers', () => {
  const source = readFileSync('server/ingestionPipeline.ts', 'utf8');
  assert.match(source, /subscriber_count:parseSubscriberCountNumber\(candidate\.subscriberCount\),video_count:structuredVideos\.length/,
    'the low-audience rule must not treat an observed video sample as an empty surface');
});

test('custom env is threaded through the stale and audience thresholds', () => {
  const input = {
    channelName: 'Old Hobby',
    description: 'My random life updates.',
    latestUploadAt: '2018-01-01T00:00:00Z',
    uploadsLast365Days: 0,
  };
  assert.equal(evaluateSemanticPrefilter(input, NOW, { SEMANTIC_PREFILTER_STALE_DAYS: '0' } as any).disposition, 'CLASSIFY');
  assert.equal(evaluateSemanticPrefilter(input, NOW, { SEMANTIC_PREFILTER_STALE_DAYS: '1' } as any).disposition, 'WITHHOLD_SEMANTIC');
  assert.equal(evaluateSemanticPrefilter(input, NOW, { SEMANTIC_PREFILTER_STALE_DAYS: '36500' } as any).disposition, 'CLASSIFY');
});

test('stale threshold 0 disables the staleness rule', () => {
  const previous = process.env.SEMANTIC_PREFILTER_STALE_DAYS;
  process.env.SEMANTIC_PREFILTER_STALE_DAYS = '0';
  try {
    const decision = evaluateSemanticPrefilter({
      channelName: 'Old Hobby',
      description: 'My random life updates.',
      latestUploadAt: '2018-01-01T00:00:00Z',
      uploadsLast365Days: 0,
    }, NOW);
    assert.equal(decision.disposition, 'CLASSIFY');
  } finally {
    if (previous === undefined) delete process.env.SEMANTIC_PREFILTER_STALE_DAYS;
    else process.env.SEMANTIC_PREFILTER_STALE_DAYS = previous;
  }
});

test('shadow mode evaluates and counts but never skips semantic classification', () => {
  resetSemanticPrefilterMetricsForTests();
  const raw: RawChannelInput = { channel_name: 'Block World', description: 'Minecraft gameplay walkthrough.' };
  const result = applySemanticPrefilter(raw, 'gemini_semantic', { SEMANTIC_PREFILTER_MODE: 'shadow' } as any);
  assert.equal(result.skip, false);
  assert.equal(result.decision?.disposition, 'WITHHOLD_SEMANTIC');
  const snapshot = semanticPrefilterSnapshot();
  assert.equal(snapshot.mode, 'shadow');
  assert.equal(snapshot.evaluations, 1);
  assert.equal(snapshot.withheld, 1);
  assert.equal(snapshot.enforcedWithholds, 0);
});

test('enforce mode skips only a confident unrelated-domain withholding', () => {
  resetSemanticPrefilterMetricsForTests();
  const unrelated = applySemanticPrefilter(
    { channel_name: 'Block World', description: 'Minecraft gameplay walkthrough.' },
    'groq_semantic',
    { SEMANTIC_PREFILTER_MODE: 'enforce' } as any
  );
  assert.equal(unrelated.skip, true);
  const trading = applySemanticPrefilter(
    { channel_name: 'Order Flow Lab', description: 'Day trading futures.' },
    'groq_semantic',
    { SEMANTIC_PREFILTER_MODE: 'enforce' } as any
  );
  assert.equal(trading.skip, false);
  assert.equal(semanticPrefilterSnapshot().enforcedWithholds, 1);
});

test('off mode performs no evaluation and has no behavior change', () => {
  resetSemanticPrefilterMetricsForTests();
  const result = applySemanticPrefilter(
    { channel_name: 'Block World', description: 'Minecraft gameplay walkthrough.' },
    'gemini_semantic',
    { SEMANTIC_PREFILTER_MODE: 'off' } as any
  );
  assert.equal(result.skip, false);
  assert.equal(result.decision, undefined);
  assert.equal(semanticPrefilterSnapshot().evaluations, 0);
});

test('repeated availability probes count one evaluation for the same channel and provider', () => {
  const env = { SEMANTIC_PREFILTER_MODE: 'shadow' } as any;
  resetSemanticPrefilterMetricsForTests(env);
  const raw: RawChannelInput = { channel_name: 'Block World', description: 'Minecraft gameplay walkthrough.' };
  applySemanticPrefilter(raw, 'gemini_semantic', env);
  applySemanticPrefilter(raw, 'gemini_semantic', env);
  applySemanticPrefilter(raw, 'gemini_semantic', env);
  assert.equal(semanticPrefilterSnapshot().evaluations, 1);
});

test('each production provider actually withholds an unrelated channel at availability in enforce mode', async () => {
  const previous = process.env.SEMANTIC_PREFILTER_MODE;
  process.env.SEMANTIC_PREFILTER_MODE = 'enforce';
  resetSemanticPrefilterMetricsForTests();
  try {
    const refusingClient = { classify: async () => { throw new Error('model must not be called by availability'); } };
    const providers = [
      new GeminiSemanticProvider(refusingClient as any),
      new GroqSemanticProvider(refusingClient as any),
      new GeminiFreeSemanticProvider(refusingClient as any),
    ];
    for (const provider of providers) {
      const unrelated = provider.availability({
        channel_name: 'Block World',
        description: 'Minecraft gameplay walkthrough and speedrun.',
        video_titles: ['Minecraft episode 1'],
      });
      assert.equal(unrelated.availability, 'NOT_APPLICABLE', `${provider.name} must honor enforce mode`);
      assert.match(String(unrelated.reason), /Semantic prefilter withheld/);

      const finance = provider.availability({
        channel_name: 'Order Flow Lab',
        description: 'Day trading futures with risk controls.',
        video_titles: ['Liquidity sweeps'],
      });
      assert.equal(finance.availability, 'AVAILABLE', `${provider.name} must retain finance channels`);
    }
    assert.equal(semanticPrefilterSnapshot().enforcedWithholds, providers.length);
  } finally {
    if (previous === undefined) delete process.env.SEMANTIC_PREFILTER_MODE;
    else process.env.SEMANTIC_PREFILTER_MODE = previous;
    resetSemanticPrefilterMetricsForTests();
  }
});

test('mode defaults to shadow and rejects unknown values safely', () => {
  assert.equal(semanticPrefilterMode({} as any), 'shadow');
  assert.equal(semanticPrefilterMode({ SEMANTIC_PREFILTER_MODE: 'enforce' } as any), 'enforce');
  assert.equal(semanticPrefilterMode({ SEMANTIC_PREFILTER_MODE: 'off' } as any), 'off');
  assert.equal(semanticPrefilterMode({ SEMANTIC_PREFILTER_MODE: 'unexpected' } as any), 'shadow');
});

test('an unrecognized mode warns once per distinct token and names supported values', () => {
  resetSemanticPrefilterWarningsForTests();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(semanticPrefilterMode({ SEMANTIC_PREFILTER_MODE: 'enfroce' } as any), 'shadow');
    }
    assert.equal(semanticPrefilterMode({ SEMANTIC_PREFILTER_MODE: 'shadwo' } as any), 'shadow');
  } finally {
    console.warn = originalWarn;
    resetSemanticPrefilterWarningsForTests();
  }
  assert.equal(warnings.length, 2, 'each distinct token warns once');
  assert.match(warnings[0], /enfroce/);
  assert.match(warnings[0], /"off", "shadow", "enforce"/);
});

test('shadow validation records real-traffic false negatives without changing behavior', () => {
  resetSemanticPrefilterMetricsForTests();
  const gaming = { channel_name: 'Block World', description: 'Minecraft gameplay walkthrough.' };
  recordSemanticPrefilterOutcome(gaming, 'groq_semantic', 'UNRELATED', { SEMANTIC_PREFILTER_MODE: 'shadow' } as any);
  let snapshot = semanticPrefilterSnapshot();
  assert.equal(snapshot.shadowComparisons, 1);
  assert.equal(snapshot.shadowFalseNegatives, 0);

  recordSemanticPrefilterOutcome(gaming, 'groq_semantic', 'ACTIVE_TRADING', { SEMANTIC_PREFILTER_MODE: 'shadow' } as any);
  snapshot = semanticPrefilterSnapshot();
  assert.equal(snapshot.shadowComparisons, 2);
  assert.equal(snapshot.shadowFalseNegatives, 1);
  assert.equal(snapshot.recentFalseNegatives.length, 1);
  assert.equal(snapshot.recentFalseNegatives[0].channelName, 'Block World');
  assert.equal(snapshot.recentFalseNegatives[0].semanticLabel, 'ACTIVE_TRADING');

  // A retained channel is not a comparison: only withheld decisions are.
  recordSemanticPrefilterOutcome(
    { channel_name: 'Order Flow Lab', description: 'Day trading futures.' },
    'groq_semantic',
    'ACTIVE_TRADING',
    { SEMANTIC_PREFILTER_MODE: 'shadow' } as any
  );
  assert.equal(semanticPrefilterSnapshot().shadowComparisons, 2);

  // Enforce and off produce no shadow evidence.
  recordSemanticPrefilterOutcome(gaming, 'groq_semantic', 'ACTIVE_TRADING', { SEMANTIC_PREFILTER_MODE: 'enforce' } as any);
  recordSemanticPrefilterOutcome(gaming, 'groq_semantic', 'ACTIVE_TRADING', { SEMANTIC_PREFILTER_MODE: 'off' } as any);
  assert.equal(semanticPrefilterSnapshot().shadowComparisons, 2);
});

test('shadow false-negative samples stay bounded', () => {
  resetSemanticPrefilterMetricsForTests();
  for (let index = 0; index < 25; index++) {
    recordSemanticPrefilterOutcome(
      { channel_id: `channel-${index}`, channel_name: 'Block World', description: 'Minecraft gameplay walkthrough.' },
      'gemini_semantic',
      'ACTIVE_TRADING',
      { SEMANTIC_PREFILTER_MODE: 'shadow' } as any
    );
  }
  const snapshot = semanticPrefilterSnapshot();
  assert.equal(snapshot.shadowFalseNegatives, 25);
  assert.equal(snapshot.recentFalseNegatives.length, 20);
  assert.equal(snapshot.recentFalseNegatives[19].channelId, 'channel-24');
});

test('all production semantic providers apply the prefilter at availability', () => {
  for (const file of [
    'server/evidenceEngine/providers/GeminiSemanticProvider.ts',
    'server/evidenceEngine/providers/GroqSemanticProvider.ts',
    'server/evidenceEngine/providers/GeminiFreeSemanticProvider.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /applySemanticPrefilter\(input, this\.name\)/, `${file} must apply the prefilter`);
    assert.match(source, /prefilter\.skip/, `${file} must honor enforce mode`);
  }
});
