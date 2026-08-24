import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTargetCountryBoundary } from './countryValidator';
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
  assert.equal(result.decisiveEvidence[0].source, 'EXCLUSION_POLICY');
  assert.match(result.rejectionReason || '', /Configured regional exclusion/);
});

test('excluded-country policy applies to inferred bio evidence, not only official metadata', () => {
  const result = inferChannelCountry(
    { aboutBio: 'Nigerian trader based in Lagos covering the Nigerian Exchange', discoveryCountry: 'Germany' },
    [{ country_name: 'Nigeria', reason: 'Configured regional exclusion' }]
  );
  assert.equal(result.detectedCountry, 'Nigeria');
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.decisiveEvidence[0].source, 'EXCLUSION_POLICY');
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


test('target-country boundary rejects a strongly attributed non-target creator', () => {
  const inferred = inferChannelCountry({
    aboutBio: 'Trader italiano based in Milano covering Borsa Italiana and FTSE MIB',
    discoveryCountry: 'Germany'
  });
  assert.equal(inferred.detectedCountry, 'Italy');
  assert.equal(inferred.status, 'CONFIRMED');
  const bounded = applyTargetCountryBoundary(asValidationResult(inferred), 'Germany');
  assert.equal(bounded.status, 'REJECTED');
  assert.match(bounded.rejectionReason || '', /does not match pinned discovery country Germany/);
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
