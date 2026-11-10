import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assessIntakeTradingFocus } from './intakeTradingFocus';
import { observeKeywordBaseline, triageAutonomousSearchCandidate } from './candidateTriage';
import { buildDeferredTradingIntakeChannel } from './ingestionPipeline';
import type { DiscoveredChannelRaw } from './youtube';

function candidate(overrides: Partial<DiscoveredChannelRaw> & { channelName: string }): DiscoveredChannelRaw {
  return {
    channelId: 'UCintake0000000000000000',
    youtubeUrl: 'https://youtube.com/channel/UCintake0000000000000000',
    description: '',
    videoTitles: [],
    matchedDocument: {
      type: 'CHANNEL',
      title: overrides.channelName,
      description: overrides.description || '',
    },
    ...overrides,
  };
}

test('investigated MPSC and Gujarati recruitment channels are withheld, never enriched', () => {
  const booster = candidate({
    channelName: 'BOOSTER UP',
    description: 'हे चेनेल MPSC, PSI, STI सरळ सेवा भरती, बँकिंग, NTSE, MTSE, स्कॉलरशिप अशा विविध परीक्षा साठी खूप उपयुक्त चेनेल आहे.',
  });
  const mission = candidate({
    channelName: 'MISSION MPSC',
    description: 'नमस्कार मित्रांनो! Mission MPSC या आपल्या अधिकृत YouTube चॅनलवर तुमचे स्वागत आहे. हे चॅनल MPSC (राज्यसेवा, PSI, STI, ASO) आणि महाराष्ट्रातील स्पर्धा परीक्षांची तयारी करणाऱ्या विद्यार्थ्यांसाठी आहे.',
  });
  const jr = candidate({
    channelName: 'JR Education Hub',
    description: 'અમારી youtube ચેનલ JR Education Hub માં આપનું સ્વાગત છે. ગુજરાત સરકાર ભરતી | competitive Exam Updates | Sarkari Naukri Gujarat.',
  });
  const pyarelal = candidate({
    channelName: 'Pyarelal Lamba',
    description: 'Share your videos with friends, family, and the world',
    videoTitles: ['जय श्री राम'],
    matchedDocument: {
      type: 'VIDEO',
      title: 'जय श्री राम',
      description: '',
    },
  });

  for (const item of [booster, mission, jr, pyarelal]) {
    const decision = triageAutonomousSearchCandidate(item, 'automated_query', false);
    assert.notEqual(decision.disposition, 'PLAUSIBLE_TRADING_HYPOTHESIS', item.channelName);
    assert.ok(
      decision.disposition === 'WITHHOLD_NO_PLAUSIBLE_HYPOTHESIS'
      || decision.disposition === 'DEFER_NO_CONFIDENT_EVIDENCE',
      `${item.channelName}: ${decision.disposition} ${decision.reasonCodes.join(',')}`,
    );
  }
});

test('genuine multilingual trading channels are admitted without English trading terms', () => {
  const examples = [
    ['Marathi', 'शेअर बाजार तांत्रिक विश्लेषण आणि गुंतवणूक मार्गदर्शन', 'ट्रेडिंग शिका'],
    ['Gujarati', 'શેર બજાર ટેકનિકલ વિશ્લેષણ અને રોકાણ માર્ગદર્શન', 'ટ્રેડિંગ શીખો'],
    ['Hindi', 'शेयर बाजार निवेश और तकनीकी विश्लेषण', 'ट्रेडिंग सीखें'],
    ['Telugu', 'స్టాక్ మార్కెట్ విశ్లేషణ మరియు పెట్టుబడి మార్గదర్శకం', 'ట్రేడింగ్ నేర్చుకోండి'],
    ['Bengali', 'শেয়ার বাজার বিশ্লেষণ ও বিনিয়োগ নির্দেশনা', 'ট্রেডিং শিখুন'],
    ['Arabic', 'تحليل فني للأسهم والبورصة مع تعليم التداول', 'تداول'],
    ['Chinese', '股票技术分析和交易教育', '期货外汇'],
  ] as const;
  for (const [label, title, secondary] of examples) {
    const decision = assessIntakeTradingFocus({
      channelName: `${label} channel`,
      description: title,
      matchedDocument: { type: 'VIDEO', title: secondary, description: '' },
      videoTitles: [secondary],
    });
    assert.equal(decision.decision, 'ADMIT', `${label}: ${decision.reasonCodes.join(',')}`);
    assert.ok(decision.positiveFamilies.some(family => family.endsWith('_TRADING')), `${label} must be admitted by native trading evidence, got ${decision.positiveFamilies.join(',')}`);
  }
});

test('ambiguous trading plus education evidence is deferred, not withheld or admitted', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'Market Exam Academy',
    description: 'MPSC exam preparation and stock market trading analysis for students.',
    matchedDocument: { type: 'CHANNEL', title: 'Market Exam Academy', description: 'MPSC exam preparation' },
  });
  assert.equal(decision.decision, 'DEFER');
  assert.ok(decision.reasonCodes.includes('CONFLICTING_TRADING_AND_UNRELATED_EVIDENCE'));
});

test('non-Latin text with no recognizable trading or unrelated domain is deferred rather than admitted', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'सामान्य चैनल',
    description: 'आमच्या चॅनलवर विविध विषयांची माहिती मिळेल.',
    matchedDocument: { type: 'CHANNEL', title: 'सामान्य चैनल', description: 'विविध विषय' },
  });
  assert.equal(decision.decision, 'DEFER');
  assert.ok(decision.reasonCodes.includes('NON_LATIN_INSUFFICIENT_TRADING_EVIDENCE'));
});

test('empty metadata is deferred, not admitted', () => {
  const decision = assessIntakeTradingFocus({ channelName: '', description: '', matchedDocument: { type: 'UNKNOWN' } });
  assert.equal(decision.decision, 'DEFER');
  assert.ok(decision.reasonCodes.includes('INSUFFICIENT_CHANNEL_EVIDENCE'));
});

test('polysemous single market words still do not admit', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'Career Desk',
    description: 'Understanding your options',
    matchedDocument: { type: 'VIDEO', title: 'Understanding your options', description: 'A general explainer.' },
  });
  assert.equal(decision.decision, 'WITHHOLD');
  assert.ok(decision.reasonCodes.includes('AMBIGUOUS_RETRIEVAL_CONTEXT'));
});


test('ingestion pipeline persists a DEFER as INTAKE_DEFERRED without an enrichment enqueue', () => {
  const source = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const start = source.indexOf("retrievalTriage.disposition === 'DEFER_NO_CONFIDENT_EVIDENCE'");
  const end = source.indexOf('// Step 1: GATE 1', start);
  assert.ok(start >= 0 && end > start, 'DEFER branch must exist before Gate 1');
  const block = source.slice(start, end);
  assert.match(block, /buildDeferredTradingIntakeChannel/);
  const builderStart = source.indexOf('function buildDeferredTradingIntakeChannel');
  const builderEnd = source.indexOf('\nexport async function processChannelThroughPipeline(', builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builder = source.slice(builderStart, builderEnd);
  assert.match(builder, /channel\.scan_status = 'INTAKE_DEFERRED'/);
  assert.match(builder, /channel\.trading_status = 'UNCERTAIN'/);
  assert.doesNotMatch(block, /enqueueJob\s*\(/);
});


test('incidental Indic share/investment words do not admit an unrelated channel', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'सामान्य चैनल',
    description: 'कृपया व्हिडिओ शेयर करें और चैनल को सब्सक्राइब करें. निवेश के बारे में बाद में बताएंगे.',
    matchedDocument: { type: 'CHANNEL', title: 'सामान्य चैनल', description: 'कृपया शेयर करें' },
  });
  assert.notEqual(decision.decision, 'ADMIT');
});

test('trading coaching language admits a genuine trading educator', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'Price Action Coach',
    description: 'Day trading coaching and daily preparation for price action traders.',
    matchedDocument: { type: 'CHANNEL', title: 'Price Action Coach', description: 'Day trading coaching' },
  });
  assert.equal(decision.decision, 'ADMIT');
});

test('an incidental music word in an explicit trading video does not withhold the channel', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'Desk Notes',
    description: 'Price action trading and risk management.',
    matchedDocument: { type: 'VIDEO', title: 'Price action trade review with lyrics in the intro', description: 'One trade, one plan.' },
    videoTitles: ['Price action trade review with lyrics in the intro'],
  });
  assert.notEqual(decision.decision, 'WITHHOLD');
});


test('deferred channel persistence uses INTAKE_DEFERRED and does not manufacture review debt', () => {
  const channel = buildDeferredTradingIntakeChannel({
    channelId: 'UCdefer00000000000000001',
    channelName: 'Deferred Channel',
    youtubeUrl: 'https://youtube.com/channel/UCdefer00000000000000001',
    description: 'Sparse metadata',
    videoTitles: [],
  }, undefined, 'automated_query', '2026-11-10T00:00:00.000Z', ['INSUFFICIENT_CHANNEL_EVIDENCE']);
  assert.equal(channel.scan_status, 'INTAKE_DEFERRED');
  assert.equal(channel.trading_status, 'UNCERTAIN');
  assert.equal(channel.country_status, 'UNCERTAIN');
  assert.equal(channel.inspection_trail.at(-1)?.step, 'BIO');
});

test('incidental market words do not admit a music channel with a hard domain signal', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'Backstage Sessions',
    description: 'Official music video. Streaming options available.',
    videoTitles: ['Artist shares backstage footage'],
    matchedDocument: { type: 'VIDEO', title: 'Backstage Sessions', description: '' },
  });
  assert.equal(decision.decision, 'DEFER');
});

test('generic hard-negative words in video text defer instead of withholding a market channel', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'DAX Weekly',
    description: 'DAX market analysis and weekly levels.',
    videoTitles: ['Kitchen table walkthrough of my DAX process'],
    matchedDocument: { type: 'VIDEO', title: 'DAX Weekly levels', description: 'DAX market analysis.' },
  });
  assert.notEqual(decision.decision, 'WITHHOLD');
});

test('conflicting non-Latin evidence is not recorded as a legacy admission', () => {
  const baseline = observeKeywordBaseline({
    channelId: 'UClegacy0000000000000002',
    channelName: 'ट्रेडिंग Kitchen',
    youtubeUrl: 'https://youtube.com/channel/UClegacy0000000000000002',
    description: '',
    videoTitles: [],
    matchedDocument: { type: 'CHANNEL', title: 'ट्रेडिंग Kitchen' },
  });
  assert.equal(baseline.baseline, 'WOULD_WITHHOLD');
});

test('keyword baseline preserves the old non-Latin coverage pass for observational comparison', () => {
  const baseline = observeKeywordBaseline({
    channelId: 'UClegacy0000000000000001',
    channelName: 'सामान्य चैनल',
    youtubeUrl: 'https://youtube.com/channel/UClegacy0000000000000001',
    description: '',
    videoTitles: [],
    matchedDocument: { type: 'CHANNEL', title: 'सामान्य चैनल' },
  });
  assert.equal(baseline.baseline, 'WOULD_ADMIT');
  assert.ok(baseline.reasonCodes.includes('LEGACY_NON_LATIN_COVERAGE_PASS'));
});


test('tutorial format does not block a two-market trading hypothesis', () => {
  const decision = assessIntakeTradingFocus({
    channelName: 'NQ Desk',
    description: 'NQ futures 0DTE tutorial and trade recap.',
    matchedDocument: { type: 'VIDEO', title: 'NQ futures 0DTE tutorial', description: 'Nasdaq session recap.' },
  });
  assert.equal(decision.decision, 'ADMIT');
});
