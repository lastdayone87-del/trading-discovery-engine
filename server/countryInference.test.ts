import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTargetCountryBoundary, mergeCountryValidationResults } from './countryValidator';
import { CountryInferenceInput, inferChannelCountry } from './countryInference';

const asValidationResult = (result: ReturnType<typeof inferChannelCountry>) => ({
  score: result.confidence,
  status: result.status,
  detectedCountry: result.detectedCountry,
  rejectionReason: result.rejectionReason,
  decisionLogs: result.reasoning,
  evidence: result.evidence
});

const multilingualCases: Array<{ language: string; country: string; input: CountryInferenceInput }> = [
  { language: 'Arabic', country: 'Saudi Arabia', input: { channelName: 'متداول الرياض', aboutBio: 'تحليل فني للأسهم في تداول السعودية والسوق المحلي', videoTitles: ['نظرة على مؤشر تاسي'], discoveryCountry: 'United States' } },
  { language: 'Spanish', country: 'Spain', input: { channelName: 'Mercados con Elena', aboutBio: 'Análisis bursátil y trading intradía', videoTitles: ['Sesión del mercado y bolsa'], discoveryCountry: 'Mexico' } },
  { language: 'Portuguese', country: 'Brazil', input: { channelName: 'Diário do Trader', aboutBio: 'Análise técnica do mercado financeiro', videoTitles: ['Ações e operações de hoje'], discoveryCountry: 'Portugal' } },
  { language: 'French', country: 'France', input: { channelName: 'Le Journal du Marché', aboutBio: 'Analyse technique de la bourse', videoTitles: ['Séance hebdomadaire du marché'], discoveryCountry: 'Canada' } },
  { language: 'German', country: 'Germany', input: { channelName: 'Börsenblick', aboutBio: 'Börsenanalyse und Handelsstrategie', videoTitles: ['Marktanalyse zum Handel'], discoveryCountry: 'Austria' } },
  { language: 'Russian', country: 'Russia', input: { channelName: 'Трейдер Москва', aboutBio: 'Технический анализ и акции', videoTitles: ['Рынок и биржа сегодня'], discoveryCountry: 'Germany' } },
  { language: 'Hindi', country: 'India', input: { channelName: 'बाज़ार की बात', aboutBio: 'शेयर बाजार और तकनीकी विश्लेषण', videoTitles: ['निफ्टी ट्रेडिंग आज'], discoveryCountry: 'United Kingdom' } },
  { language: 'Japanese', country: 'Japan', input: { channelName: '東京株式ノート', aboutBio: '株式とテクニカル分析', videoTitles: ['日経平均の相場とトレード'], discoveryCountry: 'United States' } },
  { language: 'Korean', country: 'South Korea', input: { channelName: '서울 주식 연구소', aboutBio: '주식 시장 기술적 분석', videoTitles: ['코스피 트레이딩 전략'], discoveryCountry: 'Japan' } },
  { language: 'Turkish', country: 'Turkey', input: { channelName: 'Piyasa Günlüğü', aboutBio: 'Borsa ve teknik analiz', videoTitles: ['Hisse işlem stratejisi'], discoveryCountry: 'Germany' } }
];

for (const example of multilingualCases) {
  test(`infers ${example.country} from realistic ${example.language} evidence before discovery context`, () => {
    const result = inferChannelCountry(example.input);
    assert.equal(result.detectedCountry, example.country);
    assert.notEqual(result.decisiveEvidence[0].source, 'DISCOVERY_CONTEXT');
    assert.ok(['CONFIRMED', 'LIKELY', 'UNCERTAIN'].includes(result.status));
  });
}

test('official YouTube metadata outranks every contradictory lower-priority signal', () => {
  const result = inferChannelCountry({
    officialCountry: 'DE',
    aboutBio: 'Trader español based in Madrid using CAC 40 and Boursorama, phone +33 1 22 33 44 55',
    officialWebsiteLinks: ['https://example.fr'],
    verifiedSocialLinks: ['https://instagram.com/paris_trader'],
    discoveryCountry: 'France'
  });
  assert.equal(result.detectedCountry, 'Germany');
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.decisiveEvidence[0].source, 'OFFICIAL_YOUTUBE_METADATA');
});

test('About/Bio outranks website, social, exchange, broker, phone, address, language, and discovery signals', () => {
  const result = inferChannelCountry({
    aboutBio: 'Independent trader based in España',
    officialWebsiteLinks: ['https://example.de'],
    verifiedSocialLinks: ['https://instagram.com/paris_market'],
    videoTitles: ['Xetra Flatex +49 Frankfurt Börsenanalyse'],
    discoveryCountry: 'Germany'
  });
  assert.equal(result.detectedCountry, 'Spain');
  assert.equal(result.decisiveEvidence[0].source, 'CHANNEL_ABOUT_BIO');
});

test('official website domain outranks a contradictory social profile and market references', () => {
  const result = inferChannelCountry({
    officialWebsiteLinks: ['https://trader.com.br'],
    verifiedSocialLinks: ['https://instagram.com/madrid_trader'],
    videoTitles: ['IBEX 35 con Renta 4'],
    discoveryCountry: 'Spain'
  });
  assert.equal(result.detectedCountry, 'Brazil');
  assert.equal(result.decisiveEvidence[0].source, 'OFFICIAL_WEBSITE_DOMAIN');
});

test('phone evidence outranks address, native language, and discovery context', () => {
  const result = inferChannelCountry({ aboutBio: 'Call +81 90 1234 5678. Seoul 주식 시장.', discoveryCountry: 'South Korea' });
  assert.equal(result.detectedCountry, 'Japan');
  assert.equal(result.decisiveEvidence[0].source, 'PHONE_NUMBER');
});

test('discovery context alone remains uncertain and low confidence', () => {
  const result = inferChannelCountry({ discoveryCountry: 'France' });
  assert.equal(result.detectedCountry, 'France');
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.confidence, 25);
  assert.equal(result.decisiveEvidence[0].source, 'DISCOVERY_CONTEXT');
});

test('a detected excluded country returns a policy-auditable rejection', () => {
  const result = inferChannelCountry(
    { officialCountry: 'IN', discoveryCountry: 'Germany' },
    [{ country_name: 'India', reason: 'Configured regional exclusion' }]
  );
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.detectedCountry, 'India');
  assert.equal(result.decisiveEvidence[0].source, 'OFFICIAL_YOUTUBE_METADATA');
  assert.equal(result.confidence, 100);
  assert.ok(result.evidence.some(item => item.source === 'EXCLUSION_POLICY'));
  assert.match(result.rejectionReason || '', /Configured regional exclusion/);
});

test('excluded-country policy applies to inferred bio evidence, not only official metadata', () => {
  const result = inferChannelCountry(
    { aboutBio: 'Nigerian trader based in Lagos covering the Nigerian Exchange', discoveryCountry: 'Germany' },
    [{ country_name: 'Nigeria', reason: 'Configured regional exclusion' }]
  );
  assert.equal(result.detectedCountry, 'Nigeria');
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.confidence, 92);
  assert.equal(result.decisiveEvidence[0].source, 'CHANNEL_ABOUT_BIO');
  assert.ok(result.evidence.some(item => item.source === 'EXCLUSION_POLICY'));
});

test('weak indirect excluded-country evidence remains non-terminal at its original confidence', () => {
  const result = inferChannelCountry(
    { aboutBio: 'Trading the Ho Chi Minh Stock Exchange', discoveryCountry: 'United Kingdom' },
    [{ country_name: 'Vietnam', reason: 'Configured regional exclusion' }]
  );
  assert.equal(result.detectedCountry, 'Vietnam');
  assert.equal(result.status, 'LIKELY');
  assert.equal(result.confidence, 78);
  assert.equal(result.decisiveEvidence[0].source, 'EXCHANGE_REFERENCE');
  assert.equal(result.evidence.some(item => item.source === 'EXCLUSION_POLICY'), false);
});

test('conflicting strong excluded and included country evidence remains uncertain', () => {
  const result = inferChannelCountry(
    { aboutBio: 'United Kingdom Vietnam', discoveryCountry: 'United Kingdom' },
    [{ country_name: 'Vietnam', reason: 'Configured regional exclusion' }]
  );
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.confidence, 49);
  assert.equal(result.evidence.some(item => item.source === 'EXCLUSION_POLICY'), false);
});

test('weaker live excluded evidence cannot override an earlier stronger conflict', () => {
  const initial = {
    score: 49,
    status: 'UNCERTAIN' as const,
    detectedCountry: 'United Kingdom',
    decisionLogs: 'Initial P2 evidence conflicted.',
    evidence: [
      { source: 'CHANNEL_ABOUT_BIO' as const, priority: 2, detectedCountry: 'United Kingdom', confidence: 92, reasoning: 'UK' },
      { source: 'CHANNEL_ABOUT_BIO' as const, priority: 2, detectedCountry: 'Vietnam', confidence: 92, reasoning: 'Vietnam' }
    ]
  };
  const live = {
    score: 78,
    status: 'LIKELY' as const,
    detectedCountry: 'Vietnam',
    decisionLogs: 'Indirect exchange evidence identifies Vietnam.',
    evidence: [
      { source: 'EXCHANGE_REFERENCE' as const, priority: 5, detectedCountry: 'Vietnam', confidence: 78, reasoning: 'Indirect' }
    ]
  };
  const merged = mergeCountryValidationResults(initial, live);
  assert.equal(merged.status, 'UNCERTAIN');
  assert.equal(merged.score, 49);
  assert.equal(merged.detectedCountry, 'United Kingdom');
});

test('returns ordered, structured evidence for every available signal tier', () => {
  const result = inferChannelCountry({
    officialCountry: 'TR',
    channelName: 'Türkiye Piyasa Günlüğü',
    aboutBio: 'Türkiye trader, Borsa Istanbul, Midas, +90 212 000 0000, Istanbul; borsa teknik analiz',
    officialWebsiteLinks: ['https://piyasa.com.tr'],
    verifiedSocialLinks: ['https://instagram.com/istanbul_trader'],
    videoTitles: ['BIST 100 hisse işlem stratejisi'],
    discoveryCountry: 'Germany'
  });
  const sources = new Set(result.evidence.map(item => item.source));
  for (const source of [
    'OFFICIAL_YOUTUBE_METADATA', 'CHANNEL_ABOUT_BIO', 'OFFICIAL_WEBSITE_DOMAIN',
    'VERIFIED_SOCIAL_LINK', 'EXCHANGE_REFERENCE', 'BROKER_REFERENCE', 'PHONE_NUMBER',
    'PHYSICAL_ADDRESS', 'NATIVE_LANGUAGE', 'DISCOVERY_CONTEXT'
  ]) assert.ok(sources.has(source as any), `missing ${source}`);
  assert.deepEqual(result.evidence.map(item => item.priority), [...result.evidence.map(item => item.priority)].sort((a, b) => a - b));
  assert.ok(result.evidence.every(item => item.detectedCountry && item.reasoning && item.confidence >= 0));
});


test('target-country boundary retains a strongly attributed non-excluded creator for normal processing', () => {
  const inferred = inferChannelCountry({
    aboutBio: 'Trader italiano based in Milano covering Borsa Italiana and FTSE MIB',
    discoveryCountry: 'Germany'
  });
  assert.equal(inferred.detectedCountry, 'Italy');
  assert.equal(inferred.status, 'CONFIRMED');
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'Germany');
  assert.equal(bounded.status, 'CONFIRMED');
  assert.equal(bounded.detectedCountry, 'Italy');
  assert.equal(bounded.rejectionReason, undefined);
  assert.match(bounded.decisionLogs, /Target Country Boundary: RETAINED/);
});

test('target-country boundary preserves a matching strong country decision', () => {
  const inferred = inferChannelCountry({ officialCountry: 'DE', discoveryCountry: 'Germany' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'Germany');
  assert.equal(bounded.status, 'CONFIRMED');
  assert.equal(bounded.detectedCountry, 'Germany');
  assert.equal(bounded.rejectionReason, undefined);
});

test('target-country boundary preserves unresolved country uncertainty', () => {
  const inferred = inferChannelCountry({ channelName: 'Trading Channel', discoveryCountry: 'Germany' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'Germany');
  assert.equal(bounded.status, 'UNCERTAIN');
  assert.equal(bounded.detectedCountry, 'Germany');
});

test('target-country boundary preserves conflicting non-target uncertainty instead of rejecting it', () => {
  const bounded = applyTargetCountryBoundary({
    score: 49,
    status: 'UNCERTAIN',
    detectedCountry: 'United Kingdom',
    decisionLogs: 'Conflicting CHANNEL_ABOUT_BIO evidence prevents a reliable country decision.',
    evidence: []
  }, 'Germany');
  assert.equal(bounded.status, 'UNCERTAIN');
  assert.equal(bounded.detectedCountry, 'United Kingdom');
  assert.equal(bounded.rejectionReason, undefined);
});

test('target-country boundary bypasses intentional global discovery context', () => {
  const inferred = inferChannelCountry({ officialCountry: 'IT', discoveryCountry: 'GLOBAL' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'GLOBAL');
  assert.equal(bounded.status, 'CONFIRMED');
  assert.equal(bounded.detectedCountry, 'Italy');
});

test('target-country boundary preserves an existing policy rejection', () => {
  const inferred = inferChannelCountry({ officialCountry: 'IN', discoveryCountry: 'Germany' }, [{ country_name: 'India', reason: 'Configured regional exclusion' }]);
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'Germany');
  assert.equal(bounded.status, 'REJECTED');
  assert.match(bounded.rejectionReason || '', /Configured regional exclusion/);
});

test('target search country mismatch with non-excluded detected country => NOT rejected', () => {
  const inferred = inferChannelCountry({ officialCountry: 'DE', discoveryCountry: 'CA' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'CA');
  assert.notEqual(bounded.status, 'REJECTED');
  assert.equal(bounded.detectedCountry, 'Germany');
});

test('target search country mismatch with non-excluded detected country (CH -> CA) => NOT rejected', () => {
  const inferred = inferChannelCountry({ officialCountry: 'CH', discoveryCountry: 'CA' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'CA');
  assert.notEqual(bounded.status, 'REJECTED');
  assert.equal(bounded.detectedCountry, 'Switzerland');
});

test('target search country mismatch with non-excluded detected country (CA -> DE) => NOT rejected', () => {
  const inferred = inferChannelCountry({ officialCountry: 'CA', discoveryCountry: 'DE' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'DE');
  assert.notEqual(bounded.status, 'REJECTED');
  assert.equal(bounded.detectedCountry, 'Canada');
});

test('target search country mismatch with non-excluded detected country (NZ -> CH) => NOT rejected', () => {
  const inferred = inferChannelCountry({ officialCountry: 'NZ', discoveryCountry: 'CH' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'CH');
  assert.notEqual(bounded.status, 'REJECTED');
  assert.equal(bounded.detectedCountry, 'New Zealand');
});

test('target search country mismatch with dynamically excluded detected country => REJECTED', async () => {
  const { INITIAL_EXCLUDED_COUNTRIES } = await import('../src/data/initial_countries');
  assert.ok(INITIAL_EXCLUDED_COUNTRIES.length > 0, 'Initial excluded countries policy must be available');
  const excludedCountryName = INITIAL_EXCLUDED_COUNTRIES[0].country_name;
  const exclusions = [{ country_name: excludedCountryName, reason: 'Configured regional exclusion' }];

  const inferred = inferChannelCountry({ officialCountry: excludedCountryName, discoveryCountry: 'CA' }, exclusions);
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'CA');
  assert.equal(bounded.status, 'REJECTED');
  assert.equal(bounded.detectedCountry, excludedCountryName);
  assert.match(bounded.rejectionReason || '', new RegExp(`${excludedCountryName} is excluded by policy`));
});

test('global / no-target mode continues to work correctly', () => {
  const inferred = inferChannelCountry({ officialCountry: 'CA', discoveryCountry: 'GLOBAL' });
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'GLOBAL');
  assert.notEqual(bounded.status, 'REJECTED');
  assert.equal(bounded.detectedCountry, 'Canada');

  const emptyTarget = applyTargetCountryBoundary(asValidationResult(inferred), '');
  assert.notEqual(emptyTarget.status, 'REJECTED');
  assert.equal(emptyTarget.detectedCountry, 'Canada');
});


test('weaker live indirect evidence cannot override an earlier confirmed creator country', () => {
  const initial = {
    score: 92,
    status: 'CONFIRMED' as const,
    detectedCountry: 'United Kingdom',
    decisionLogs: 'Creator About evidence identifies the United Kingdom.',
    evidence: [
      { source: 'CHANNEL_ABOUT_BIO' as const, priority: 2, detectedCountry: 'United Kingdom', confidence: 92, reasoning: 'UK About' }
    ]
  };
  const live = {
    score: 78,
    status: 'LIKELY' as const,
    detectedCountry: 'Vietnam',
    decisionLogs: 'Indirect exchange evidence identifies Vietnam.',
    evidence: [
      { source: 'EXCHANGE_REFERENCE' as const, priority: 5, detectedCountry: 'Vietnam', confidence: 78, reasoning: 'Indirect exchange' }
    ]
  };
  const merged = mergeCountryValidationResults(initial, live);
  assert.equal(merged.status, 'CONFIRMED');
  assert.equal(merged.score, 92);
  assert.equal(merged.detectedCountry, 'United Kingdom');
});

test('stronger live official excluded evidence can establish a legitimate terminal rejection', () => {
  const initial = {
    score: 49,
    status: 'UNCERTAIN' as const,
    detectedCountry: 'United Kingdom',
    decisionLogs: 'Initial evidence conflicted.',
    evidence: [
      { source: 'CHANNEL_ABOUT_BIO' as const, priority: 2, detectedCountry: 'United Kingdom', confidence: 92, reasoning: 'UK' },
      { source: 'CHANNEL_ABOUT_BIO' as const, priority: 2, detectedCountry: 'Vietnam', confidence: 92, reasoning: 'Vietnam' }
    ]
  };
  const live = {
    score: 100,
    status: 'REJECTED' as const,
    detectedCountry: 'Vietnam',
    decisionLogs: 'Official excluded country.',
    evidence: [
      { source: 'EXCLUSION_POLICY' as const, priority: 0, detectedCountry: 'Vietnam', confidence: 100, reasoning: 'Excluded' },
      { source: 'OFFICIAL_YOUTUBE_METADATA' as const, priority: 1, detectedCountry: 'Vietnam', confidence: 100, reasoning: 'Official' }
    ]
  };
  const merged = mergeCountryValidationResults(initial, live);
  assert.equal(merged.status, 'REJECTED');
  assert.equal(merged.score, 100);
  assert.equal(merged.detectedCountry, 'Vietnam');
});
