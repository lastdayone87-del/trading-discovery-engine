import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessChannelCountry,
  voteVideoDescriptionLanguage,
  aggregateContentLanguage,
  AGGREGATED_CONTENT_LANGUAGES,
} from './countryInference';
import { creatorLevelCountryEvidence } from './countryValidator';
import {
  parseAggregatedLanguageRejection,
  classifyReconciliationState,
} from './countryBoundaryRecovery';

const EXCLUDED = [
  { country_name: 'Vietnam', reason: 't' },
  { country_name: 'Philippines', reason: 't' },
  { country_name: 'India', reason: 't' },
  { country_name: 'Bangladesh', reason: 't' },
  { country_name: 'Pakistan', reason: 't' },
  { country_name: 'Nigeria', reason: 't' },
];

const VI = 'Phân tích kỹ thuật chứng khoán hôm nay với biểu đồ giao dịch thị trường cổ phiếu đầu tư';
const HI = 'यह शेयर बाज़ार विश्लेषण वीडियो ट्रेडिंग रणनीति समझाता है';
const EN = 'Day trading scalp tutorial with entries, exits and risk management';
const AR = 'تحليل فني للأسواق المالية وتوصيات التداول اليوم';
const UR = 'پاکستان اسٹاک مارکیٹ تجارت11 خبر اور منافع بینک'; // Urdu-specific chars + keywords
const BN = 'শেয়ার বাজার বিশ্লেষণ ট্রেডিং কৌশল আজকের আপডেট';
const TL = 'Ang mga kalakalan ngayon ay mainam para sa lahat ng tao';

function descriptions(text: string, count: number, filler: string = EN): string[] {
  const out = Array(count).fill(text);
  while (out.length < 10) out.push(filler);
  return out;
}

function assess(input: Record<string, unknown>, exclusions = EXCLUDED) {
  // assessChannelCountry reads officialCountry (the validator maps
  // locationTag onto it); translate the convenient alias here.
  const { locationTag, ...rest } = input;
  return assessChannelCountry(
    {
      channelName: 'Test Channel',
      aboutBio: '',
      videoTitles: [],
      ...rest,
      ...(typeof locationTag === 'string' ? { officialCountry: locationTag } : {}),
    } as never,
    exclusions as never,
    [],
  );
}

// ---------------------------------------------------------------------------
// Voter unit behavior
// ---------------------------------------------------------------------------

test('voter attributes scripts and abstains on worldwide or empty text', () => {
  assert.equal(voteVideoDescriptionLanguage(''), null);
  assert.equal(voteVideoDescriptionLanguage('   '), null);
  assert.equal(voteVideoDescriptionLanguage(EN), null);
  assert.equal(voteVideoDescriptionLanguage(AR), null);
  assert.equal(voteVideoDescriptionLanguage(HI), 'Hindi');
  assert.equal(voteVideoDescriptionLanguage(BN), 'Bengali');
  assert.equal(voteVideoDescriptionLanguage(UR), 'Urdu');
  assert.equal(voteVideoDescriptionLanguage(VI), 'Vietnamese');
  assert.equal(voteVideoDescriptionLanguage(TL), 'Tagalog');
  assert.equal(voteVideoDescriptionLanguage(`${VI} ${HI}`), null);
});

test('approved language map covers exactly the five eligible languages', () => {
  assert.deepEqual(Object.keys(AGGREGATED_CONTENT_LANGUAGES).sort(), ['Bengali', 'Hindi', 'Tagalog', 'Urdu', 'Vietnamese']);
  assert.deepEqual(AGGREGATED_CONTENT_LANGUAGES.Bengali.countries, ['Bangladesh', 'India']);
  assert.deepEqual(AGGREGATED_CONTENT_LANGUAGES.Urdu.countries, ['Pakistan', 'India']);
});

test('every map entry is rejection-capable on its own: countries plus at least one signal group', () => {
  // Data-driven contract: extending coverage to a new excluded-country
  // language must only add a complete entry here — no code branches. An
  // entry without signals (or without countries) can never vote, and adding
  // a sixth language intentionally updates this test after separate validation.
  // Worldwide languages (English, French, Spanish, Portuguese, Arabic,
  // Bahasa) must never appear as entries.
  for (const [language, definition] of Object.entries(AGGREGATED_CONTENT_LANGUAGES)) {
    assert.ok(definition.countries.length >= 1, `${language} needs candidate countries`);
    const hasSignals = Boolean(
      (definition.scripts && definition.scripts.length > 0) ||
      definition.diacritics ||
      (definition.phraseKeywords && definition.phraseKeywords.length > 0) ||
      definition.wordKeywords ||
      definition.arabicMarkers,
    );
    assert.ok(hasSignals, `${language} needs at least one signal group`);
  }
  for (const worldwide of ['English', 'French', 'Spanish', 'Portuguese', 'Arabic', 'Bahasa']) {
    assert.ok(!(worldwide in AGGREGATED_CONTENT_LANGUAGES), `${worldwide} must stay non-decisive`);
  }
});

// ---------------------------------------------------------------------------
// Thresholds: 8/10 boundary, <8 usable, mixed, worldwide
// ---------------------------------------------------------------------------

test('10/10 and 8/10 Vietnamese reject; 7/10 processes', () => {
  const full = assess({ videoDescriptions: descriptions(VI, 10) });
  assert.equal(full.countryStatus, 'REJECTED');
  assert.equal(full.gateDisposition, 'REJECT_EXCLUDED');
  assert.equal(full.detectedCreatorCountry, 'Vietnam');
  const eight = assess({ videoDescriptions: descriptions(VI, 8) });
  assert.equal(eight.countryStatus, 'REJECTED');
  const seven = assess({ videoDescriptions: descriptions(VI, 7) });
  assert.notEqual(seven.countryStatus, 'REJECTED');
});

test('below-minimum samples never reject regardless of share', () => {
  assert.notEqual(assess({ videoDescriptions: [VI, VI, VI, VI] }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: [VI, VI, VI, VI, VI] }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: [] }).countryStatus, 'REJECTED');
});

test('Hindi thresholds: 10/9/8 reject, 7 processes', () => {
  assert.equal(assess({ videoDescriptions: descriptions(HI, 10) }).countryStatus, 'REJECTED');
  assert.equal(assess({ videoDescriptions: descriptions(HI, 9) }).countryStatus, 'REJECTED');
  assert.equal(assess({ videoDescriptions: descriptions(HI, 8) }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(HI, 7) }).countryStatus, 'REJECTED');
});

test('mixed languages without dominance process', () => {
  const mixed = [...Array(5).fill(HI), ...Array(5).fill(EN)];
  assert.notEqual(assess({ videoDescriptions: mixed }).countryStatus, 'REJECTED');
  const split = [...Array(5).fill(HI), ...Array(5).fill(VI)];
  assert.notEqual(assess({ videoDescriptions: split }).countryStatus, 'REJECTED');
});

test('worldwide language dominance never rejects', () => {
  assert.notEqual(assess({ videoDescriptions: descriptions(EN, 10) }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(AR, 10) }).countryStatus, 'REJECTED');
});

test('second eligible language with 2 votes voids dominance', () => {
  const withDissent = [...Array(8).fill(VI), ...Array(2).fill(HI)];
  assert.notEqual(assess({ videoDescriptions: withDissent }).countryStatus, 'REJECTED');
});

// ---------------------------------------------------------------------------
// Higher-priority protection and website interaction (no website logic in voter)
// ---------------------------------------------------------------------------

test('conclusive P1/P2 evidence skips the language path', () => {
  assert.notEqual(
    assess({ videoDescriptions: descriptions(VI, 10), locationTag: 'US' }).countryStatus,
    'REJECTED',
  );
  const bio = assess({ videoDescriptions: descriptions(VI, 10), aboutBio: 'based in the United States' });
  assert.equal(bio.countryStatus, 'CONFIRMED');
  assert.equal(bio.detectedCreatorCountry, 'United States');
});

test('agreeing website stays unanimous; disagreeing website blocks language rejection', () => {
  const agree = assess({
    videoDescriptions: descriptions(VI, 10),
    officialWebsiteLinks: ['https://example.vn'],
  });
  assert.equal(agree.countryStatus, 'REJECTED');
  const disagree = assess({
    videoDescriptions: descriptions(VI, 10),
    officialWebsiteLinks: ['https://example.pk'],
  });
  assert.notEqual(disagree.countryStatus, 'REJECTED');
});

test('multi-country website interaction follows unanimity without website logic in voter', () => {
  // Urdu emits representative India; a .pk website says Pakistan -> not
  // unanimous -> no language-driven REJECT (correction: website must not
  // enable rejection).
  const pk = assess({
    videoDescriptions: descriptions(UR, 9, EN),
    officialWebsiteLinks: ['https://example.pk'],
  });
  assert.notEqual(pk.countryStatus, 'REJECTED');
  const de = assess({
    videoDescriptions: descriptions(UR, 9, EN),
    officialWebsiteLinks: ['https://example.de'],
  });
  assert.notEqual(de.countryStatus, 'REJECTED');
});

test('Urdu and Bengali reject alone with set recorded', () => {
  const urdu = assess({ videoDescriptions: descriptions(UR, 9, EN) });
  assert.equal(urdu.countryStatus, 'REJECTED');
  assert.equal(urdu.detectedCreatorCountry, 'India');
  const item = urdu.countryEvidence.find(e => e.source === 'AGGREGATED_CONTENT_LANGUAGE');
  assert.ok(item);
  assert.deepEqual(item.candidateCountries, ['Pakistan', 'India']);
  const bengali = assess({ videoDescriptions: descriptions(BN, 8, EN) });
  assert.equal(bengali.countryStatus, 'REJECTED');
});

test('Tagalog 10/10 rejects as Philippines', () => {
  const tl = assess({ videoDescriptions: descriptions(TL, 10) });
  assert.equal(tl.countryStatus, 'REJECTED');
  assert.equal(tl.detectedCreatorCountry, 'Philippines');
});

test('set member leaving the live list disables language rejection', () => {
  const withoutIndia = EXCLUDED.filter(e => e.country_name !== 'India');
  assert.notEqual(assess({ videoDescriptions: descriptions(HI, 10) }, withoutIndia).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(UR, 9, EN) }, withoutIndia).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(BN, 8, EN) }, withoutIndia).countryStatus, 'REJECTED');
});

test('playlist veto blocks dominance without deciding', () => {
  const vetoed = assess({
    videoDescriptions: descriptions(VI, 8, EN),
    playlists: [{ name: HI, description: HI }],
  });
  assert.notEqual(vetoed.countryStatus, 'REJECTED');
});

test('pre-enrichment shape stays uncertain', () => {
  const res = assess({});
  assert.equal(res.countryStatus, 'UNCERTAIN');
});

test('validator threads descriptions without touching the provenance boundary', () => {
  const evidence = creatorLevelCountryEvidence({
    channelName: 'Test',
    description: '',
    videoDescriptions: descriptions(VI, 10),
    playlists: [],
  });
  assert.deepEqual(evidence.videoDescriptions, descriptions(VI, 10));
  assert.deepEqual(evidence.videoTitles, []);
  assert.equal(evidence.aboutBio, '');
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function languageRow(set: string[], representative: string): Record<string, unknown> {
  return {
    channel_id: 'UCtesttesttesttesttest01',
    channel_name: 'Test',
    country: representative,
    country_status: 'REJECTED',
    trading_status: 'UNKNOWN',
    inspection_trail: [
      {
        step: 'COUNTRY_VALIDATION',
        title: 'Country Validation',
        status: 'REJECTED',
        details: `  [P3] AGGREGATED_CONTENT_LANGUAGE: ${representative} (86/100) — 9/10 recent video descriptions in Urdu (candidate countries [${set.join(', ')}], all currently excluded). [field: videoDescriptions]`,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

test('parser reads representative and set from the language trail line', () => {
  const parsed = parseAggregatedLanguageRejection(languageRow(['Pakistan', 'India'], 'India') as never);
  assert.deepEqual(parsed, { representative: 'India', countries: ['Pakistan', 'India'] });
  assert.equal(parseAggregatedLanguageRejection({ inspection_trail: [] } as never), null);
});

test('removing a non-representative member restores the row', () => {
  const row = languageRow(['Pakistan', 'India'], 'India');
  const kept = classifyReconciliationState(row as never, EXCLUDED as never, []);
  assert.equal(kept.state, 'RETAIN_EXCLUDED');
  const withoutPakistan = EXCLUDED.filter(e => e.country_name !== 'Pakistan');
  const restored = classifyReconciliationState(row as never, withoutPakistan as never, []);
  assert.equal(restored.state, 'RECOVERABLE_NON_EXCLUDED');
});

test('explicit rejections honor the live list instead of short-circuiting blindly', () => {
  const row = {
    channel_id: 'UCtesttesttesttesttest02',
    channel_name: 'Test',
    country: 'India',
    country_status: 'REJECTED',
    trading_status: 'UNKNOWN',
    inspection_trail: [],
  };
  const kept = classifyReconciliationState(row as never, EXCLUDED as never, []);
  assert.equal(kept.state, 'LEGITIMATE_REJECTION');
  const withoutIndia = EXCLUDED.filter(e => e.country_name !== 'India');
  const reevaluated = classifyReconciliationState(row as never, withoutIndia as never, []);
  assert.notEqual(reevaluated.state, 'LEGITIMATE_REJECTION');
});
