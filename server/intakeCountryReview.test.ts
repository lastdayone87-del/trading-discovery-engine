import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assessChannelCountry, inferChannelCountry } from './countryInference';
import { INITIAL_EXCLUDED_COUNTRIES } from '../src/data/initial_countries';

const INDIA = [{ country_name: 'India', reason: 'test exclusion' }];

function assess(input: Record<string, unknown>, exclusions = INDIA) {
  return assessChannelCountry({
    channelName: 'Test Channel',
    aboutBio: '',
    videoTitles: [],
    videoDescriptionsAuthoritative: true,
    ...input,
  } as never, exclusions as never, []);
}

const MARATHI = 'शेअर बाजार तांत्रिक विश्लेषण आणि गुंतवणूक मार्गदर्शन आहे आणि मराठी मध्ये उपलब्ध आहे';
const GUJARATI = 'શેર બજાર ટેકનિકલ વિશ્લેષણ અને રોકાણ માર્ગદર્શન';
const VIETNAMESE = 'Phân tích kỹ thuật chứng khoán hôm nay với biểu đồ giao dịch thị trường cổ phiếu đầu tư';

function samples(text: string, count: number, filler = 'Day trading scalp tutorial with risk management') {
  return Array.from({ length: count }, () => text).concat(Array.from({ length: Math.max(0, 10 - count) }, () => filler));
}

test('mention-grade excluded-country evidence is LIKELY/NEEDS_REVIEW, never CONFIRMED/ALLOW', () => {
  const result = inferChannelCountry({
    channelName: 'SmartPip Academy',
    aboutBio: 'Charts, liquidity and order block breakdowns, session timing in New York and India time, risk management and trading mistakes.',
    discoveryCountry: 'Germany',
  }, INDIA);
  assert.equal(result.detectedCountry, 'India');
  assert.equal(result.status, 'LIKELY');
  assert.equal(result.gateDisposition, 'NEEDS_REVIEW');
  assert.notEqual(result.status, 'REJECTED');
  assert.equal(result.evidence.some(item => item.source === 'EXCLUSION_POLICY'), false);
});

test('strong domicile evidence for an excluded country still rejects', () => {
  const result = inferChannelCountry({
    channelName: 'Delhi Trader',
    aboutBio: 'I am an Indian trader based in India, trading NIFTY and Bank Nifty.',
    discoveryCountry: 'Singapore',
  }, INDIA);
  assert.equal(result.detectedCountry, 'India');
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.gateDisposition, 'REJECT_EXCLUDED');
});

test('excluded-country market references alone never reject a creator', () => {
  const result = inferChannelCountry({
    channelName: 'Global Nifty Desk',
    aboutBio: 'I trade NIFTY, NSE and Indian stocks from Singapore. Market coverage, not my domicile.',
    discoveryCountry: 'Singapore',
  }, INDIA);
  assert.notEqual(result.status, 'REJECTED');
});

test('a known non-excluded country is not overridden by excluded-language content', () => {
  const result = assess({
    officialCountry: 'United States',
    videoDescriptions: samples(VIETNAMESE, 10),
  });
  assert.equal(result.detectedCreatorCountry, 'United States');
  assert.notEqual(result.countryStatus, 'REJECTED');
});

test('dominant Marathi/Gujarati evidence with enough samples rejects under the language policy', () => {
  const marathi = assess({
    aboutBio: MARATHI,
    videoDescriptions: samples(MARATHI, 8),
  });
  assert.equal(marathi.countryStatus, 'REJECTED');
  assert.equal(marathi.detectedCreatorCountry, 'India');
  assert.equal(marathi.gateDisposition, 'REJECT_EXCLUDED');

  const gujarati = assess({
    aboutBio: GUJARATI,
    videoDescriptions: samples(GUJARATI, 8),
  });
  assert.equal(gujarati.countryStatus, 'REJECTED');
  assert.equal(gujarati.countryEvidence.some(item => item.source === 'AGGREGATED_CONTENT_LANGUAGE'), true);
});

test('mixed Marathi/Hindi samples abstain rather than guess', () => {
  const mixed = [
    ...samples(MARATHI, 4),
    ...samples('यह शेयर बाज़ार विश्लेषण वीडियो ट्रेडिंग रणनीति समझाता है', 4),
    MARATHI,
    'यह शेयर बाज़ार विश्लेषण',
  ];
  const result = assess({ videoDescriptions: mixed });
  assert.notEqual(result.countryStatus, 'REJECTED');
});

test('all configured excluded countries reject strong domicile evidence', () => {
  for (const entry of INITIAL_EXCLUDED_COUNTRIES) {
    const country = String((entry as { country_name?: string; country?: string }).country_name
      || (entry as { country?: string }).country
      || '');
    if (!country) continue;
    const result = inferChannelCountry({
      channelName: `${country} Trader`,
      aboutBio: `I am a trader based in ${country}, trading local stocks and forex.`,
      discoveryCountry: 'Germany',
    }, [{ country_name: country, reason: 'test exclusion' }]);
    assert.equal(result.status, 'REJECTED', `${country}: ${result.status} ${result.reasoning}`);
  }
});
