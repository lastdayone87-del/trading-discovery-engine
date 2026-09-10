import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import { runChannelInspection } from './inspector';
import { extractDiscoveredChannels } from './youtube';
import { mapInnertubeVideosToRaw } from './youtubeInnertubeProvider';

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
const ES = 'Análisis bursátil del mercado con estrategia de sesión intradía';
const PT = 'Análise técnica do mercado financeiro brasileiro de hoje';
const ID = 'Analisis teknikal pasar saham hari ini untuk pemula';
const UR = 'پاکستان اسٹاک مارکیٹ تجارت11 خبر اور منافع بینک'; // Urdu-specific chars + keywords
const BN = 'শেয়ার বাজার বিশ্লেষণ ট্রেডিং কৌশল আজকের আপডেট';
const TL = 'Ang mga kalakalan ngayon ay mainam para sa lahat ng tao';
// Representative ordinary French: shared â/ê/ô/û/é/è characters, no Vietnamese signals.
const FR1 = 'Le bêta, le coût et le côté du marché financier';
const FR2 = 'Analyse technique du marché boursier français avec des données hebdomadaires sur les actions';
// Nepali: Devanagari script with Nepali-specific markers (veto) or script alone.
const NE_VETO = 'नेप्से बजार विश्लेषण आजको अपडेट छ लगानीकर्ताको लागि महत्त्वपूर्ण छ';
const NE_SCRIPT_ONLY = 'नेपाल स्टक एक्सचेन्ज बजार समाचार अपडेट';
// Devanagari script alone, without Hindi-specific function words.
const DEVANAGARI_ONLY = 'शेयर बाजार अपडेट';

function descriptions(text: string, count: number, filler: string = EN): string[] {
  const out = Array(count).fill(text);
  while (out.length < 10) out.push(filler);
  return out;
}

function assess(input: Record<string, unknown>, exclusions = EXCLUDED) {
  // assessChannelCountry reads officialCountry (the validator maps
  // locationTag onto it); translate the convenient alias here. Descriptions
  // default to authoritative recent-channel provenance; pass
  // videoDescriptionsAuthoritative: false explicitly for search-selected /
  // stale samples that must never vote.
  const { locationTag, videoDescriptionsAuthoritative, ...rest } = input as {
    locationTag?: string;
    videoDescriptionsAuthoritative?: boolean;
    [key: string]: unknown;
  };
  return assessChannelCountry(
    {
      channelName: 'Test Channel',
      aboutBio: '',
      videoTitles: [],
      videoDescriptionsAuthoritative: videoDescriptionsAuthoritative ?? true,
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
  assert.equal(voteVideoDescriptionLanguage(ES), null);
  assert.equal(voteVideoDescriptionLanguage(PT), null);
  assert.equal(voteVideoDescriptionLanguage(ID), null);
  assert.equal(voteVideoDescriptionLanguage(HI), 'Hindi');
  assert.equal(voteVideoDescriptionLanguage(BN), 'Bengali');
  assert.equal(voteVideoDescriptionLanguage(UR), 'Urdu');
  assert.equal(voteVideoDescriptionLanguage(VI), 'Vietnamese');
  assert.equal(voteVideoDescriptionLanguage(TL), 'Tagalog');
  assert.equal(voteVideoDescriptionLanguage(`${VI} ${HI}`), null);
});

test('ordinary French text never votes Vietnamese', () => {
  assert.equal(voteVideoDescriptionLanguage(FR1), null);
  assert.equal(voteVideoDescriptionLanguage(FR2), null);
  // Shared Latin diacritics (â/ê/ô/…) are not Vietnamese signals on their own.
  assert.equal(voteVideoDescriptionLanguage('Le rôle du réseau crée un système très hétérogène'), null);
});

test('Vietnamese-specific character set excludes French-shared diacritics', () => {
  const chars = AGGREGATED_CONTENT_LANGUAGES.Vietnamese.diacritics?.chars || '';
  for (const shared of ['â', 'ê', 'ô', 'Â', 'Ê', 'Ô']) {
    assert.ok(!chars.includes(shared), `shared character ${shared} must not vote Vietnamese alone`);
  }
});

test('Nepali content never votes Hindi', () => {
  assert.equal(voteVideoDescriptionLanguage(NE_VETO), null);
  assert.equal(voteVideoDescriptionLanguage(NE_SCRIPT_ONLY), null);
});

test('Devanagari script alone never votes Hindi', () => {
  assert.equal(voteVideoDescriptionLanguage(DEVANAGARI_ONLY), null);
});

test('approved language map covers exactly the five eligible languages', () => {
  assert.deepEqual(Object.keys(AGGREGATED_CONTENT_LANGUAGES).sort(), ['Bengali', 'Hindi', 'Tagalog', 'Urdu', 'Vietnamese']);
  assert.deepEqual(AGGREGATED_CONTENT_LANGUAGES.Bengali.countries, ['Bangladesh', 'India']);
  assert.deepEqual(AGGREGATED_CONTENT_LANGUAGES.Urdu.countries, ['Pakistan', 'India']);
  // Hindi maps to India only: Nepali is distinguished by evidence, never
  // blurred into the candidate set.
  assert.deepEqual(AGGREGATED_CONTENT_LANGUAGES.Hindi.countries, ['India']);
  // Shared-script guardrails stay data-driven on the Hindi entry.
  assert.equal(AGGREGATED_CONTENT_LANGUAGES.Hindi.scriptNeedsCorroboration, true);
  assert.ok((AGGREGATED_CONTENT_LANGUAGES.Hindi.vetoWords || []).length > 0);
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

test('Vietnamese 10/10, 9/10 and 8/10 reject; 7/10 processes', () => {
  const full = assess({ videoDescriptions: descriptions(VI, 10) });
  assert.equal(full.countryStatus, 'REJECTED');
  assert.equal(full.gateDisposition, 'REJECT_EXCLUDED');
  assert.equal(full.detectedCreatorCountry, 'Vietnam');
  assert.equal(assess({ videoDescriptions: descriptions(VI, 9) }).countryStatus, 'REJECTED');
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

test('Nepali 10/10 never triggers Hindi/India rejection', () => {
  assert.notEqual(assess({ videoDescriptions: descriptions(NE_VETO, 10) }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(NE_SCRIPT_ONLY, 10) }).countryStatus, 'REJECTED');
});

test('French 10/10 never triggers Vietnamese rejection', () => {
  assert.notEqual(assess({ videoDescriptions: descriptions(FR1, 10) }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(FR2, 10) }).countryStatus, 'REJECTED');
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
  assert.notEqual(assess({ videoDescriptions: descriptions(ES, 10) }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(PT, 10) }).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(ID, 10) }).countryStatus, 'REJECTED');
});

test('second eligible language with 2 votes voids dominance', () => {
  const withDissent = [...Array(8).fill(VI), ...Array(2).fill(HI)];
  assert.notEqual(assess({ videoDescriptions: withDissent }).countryStatus, 'REJECTED');
});

// ---------------------------------------------------------------------------
// Authoritative provenance: search-selected / stale samples cannot vote
// ---------------------------------------------------------------------------

test('search-selected videos cannot manufacture a rejection', () => {
  const searchSelected = assess({ videoDescriptions: descriptions(VI, 10), videoDescriptionsAuthoritative: false });
  assert.notEqual(searchSelected.countryStatus, 'REJECTED');
  const unset = assess({ videoDescriptions: descriptions(VI, 10), videoDescriptionsAuthoritative: undefined as never });
  // Helper defaults unset to authoritative; explicit direct call without the
  // flag must process instead.
  assert.equal(unset.countryStatus, 'REJECTED');
  const direct = assessChannelCountry(
    { channelName: 'Test Channel', aboutBio: '', videoTitles: [], videoDescriptions: descriptions(VI, 10) } as never,
    EXCLUDED as never,
    [],
  );
  assert.notEqual(direct.countryStatus, 'REJECTED');
});

test('old or unrepresentative videos without authoritative provenance cannot manufacture a rejection', () => {
  const stale = assess({ videoDescriptions: descriptions(HI, 10), videoDescriptionsAuthoritative: false });
  assert.notEqual(stale.countryStatus, 'REJECTED');
});

test('authoritative recent-channel descriptions trigger the intended rejection', () => {
  const res = assess({ videoDescriptions: descriptions(VI, 8), videoDescriptionsAuthoritative: true });
  assert.equal(res.countryStatus, 'REJECTED');
  assert.equal(res.detectedCreatorCountry, 'Vietnam');
  assert.equal(res.decisiveEvidence[0]?.source, 'AGGREGATED_CONTENT_LANGUAGE');
});

test('discovery VIDEO-lane and innertube mappings are non-authoritative by construction', () => {
  const videoLane = extractDiscoveredChannels(
    [{ snippet: { channelId: 'UCxxxxxxxxxxxxxxxxxxxxxx', channelTitle: 'Ch', title: 'T', description: VI } }],
    'VIDEO',
    'query',
  );
  assert.equal(videoLane[0]?.videoDescriptionsAuthoritative, false);
  const innertube = mapInnertubeVideosToRaw([
    { author: { id: 'UCyyyyyyyyyyyyyyyyyyyyyy', name: 'Ch' }, video_id: 'v1', title: 'T', description_snippet: { runs: [{ text: VI }] } },
  ] as never);
  assert.equal(innertube[0]?.videoDescriptionsAuthoritative, false);
});

test('playlist-adapter observations are non-authoritative by construction', () => {
  const source = readFileSync(new URL('./playlistAdapterWorker.ts', import.meta.url), 'utf8');
  assert.match(source, /videoDescriptionsAuthoritative:false/);
});

test('Gate 1 threads description provenance at every validation call', () => {
  const source = readFileSync(new URL('./ingestionPipeline.ts', import.meta.url), 'utf8');
  const matches = source.match(/videoDescriptionsAuthoritative:\s*candidate\.videoDescriptionsAuthoritative/g) || [];
  assert.equal(matches.length, 3);
});

test('channel enrichment produces the authoritative recent-channel sample', () => {
  const source = readFileSync(new URL('./youtube.ts', import.meta.url), 'utf8');
  assert.match(source, /videoDescriptionsAuthoritative: true/);
});

// ---------------------------------------------------------------------------
// Retry / live-revalidation data flow: fresh descriptions reach the validator
// ---------------------------------------------------------------------------

test('inspection exposes fresh channel-sampled descriptions, excluding preloaded search snippets', async () => {
  const preloaded = Array.from({ length: 5 }, (_, i) => `stale search snippet ${i + 1}`);
  // Ten distinct channel-sampled descriptions (deduped downstream, so each
  // entry must be unique, as real recent-upload fetches are).
  const fresh = Array.from({ length: 10 }, (_, i) => `${VI} — bản tin ${i + 1}`);
  const result = await runChannelInspection({
    channelId: 'UCzzzzzzzzzzzzzzzzzzzzzz',
    channelName: 'Test Channel',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: preloaded,
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => fresh,
  });
  assert.deepEqual(result.observedVideoDescriptions, fresh.slice(0, 10));
  assert.equal(result.observedVideoDescriptionsAuthoritative, true);
  for (const snippet of preloaded) {
    assert.ok(!(result.observedVideoDescriptions || []).includes(snippet));
  }
  // The freshly acquired sample drives the intended rejection…
  const live = assess({ videoDescriptions: result.observedVideoDescriptions || [], videoDescriptionsAuthoritative: result.observedVideoDescriptionsAuthoritative });
  assert.equal(live.countryStatus, 'REJECTED');
  assert.equal(live.detectedCreatorCountry, 'Vietnam');
  // …while the stale search-selected input alone cannot.
  const stale = assess({ videoDescriptions: preloaded, videoDescriptionsAuthoritative: false });
  assert.notEqual(stale.countryStatus, 'REJECTED');
});

test('inspection without fresh acquisition leaves the voter with nothing to evaluate', async () => {
  const result = await runChannelInspection({
    channelId: 'UCwwwwwwwwwwwwwwwwwwwwww',
    channelName: 'Test Channel',
    channelBio: 'Trading creator',
    channelLinks: [],
    videoDescriptions: Array(5).fill(EN),
    creatorLikelyTrading: true,
    recentVideoDescriptionsLoader: async () => [],
  });
  assert.deepEqual(result.observedVideoDescriptions, []);
  assert.equal(result.observedVideoDescriptionsAuthoritative, false);
});

test('queue live revalidation consumes the inspection-observed sample, not stale rawDetails', () => {
  const source = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /videoDescriptions:inspection\.observedVideoDescriptions \|\| \[\]/);
  assert.match(source, /videoDescriptionsAuthoritative:inspection\.observedVideoDescriptionsAuthoritative \|\| false/);
});

// ---------------------------------------------------------------------------
// Higher-priority protection and website independence
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

test('website agreement does not decide: language rejects on its own evidence', () => {
  const agree = assess({
    videoDescriptions: descriptions(VI, 10),
    officialWebsiteLinks: ['https://example.vn'],
  });
  assert.equal(agree.countryStatus, 'REJECTED');
  assert.equal(agree.detectedCreatorCountry, 'Vietnam');
  assert.equal(agree.decisiveEvidence[0]?.source, 'AGGREGATED_CONTENT_LANGUAGE');
});

test('website disagreement does NOT block language rejection', () => {
  const disagree = assess({
    videoDescriptions: descriptions(VI, 10),
    officialWebsiteLinks: ['https://example.pk'],
  });
  assert.equal(disagree.countryStatus, 'REJECTED');
  assert.equal(disagree.detectedCreatorCountry, 'Vietnam');
  const unrelated = assess({
    videoDescriptions: descriptions(VI, 10),
    officialWebsiteLinks: ['https://example.de'],
  });
  assert.equal(unrelated.countryStatus, 'REJECTED');
  assert.equal(unrelated.detectedCreatorCountry, 'Vietnam');
});

test('website cannot select a member of a multi-country language set', () => {
  // Urdu emits the full {Pakistan, India} set; a .pk website must neither
  // resolve the set nor block the rejection.
  const pk = assess({
    videoDescriptions: descriptions(UR, 9, EN),
    officialWebsiteLinks: ['https://example.pk'],
  });
  assert.equal(pk.countryStatus, 'REJECTED');
  const item = pk.decisiveEvidence.find(e => e.source === 'AGGREGATED_CONTENT_LANGUAGE');
  assert.ok(item);
  assert.deepEqual(item.candidateCountries, ['Pakistan', 'India']);
  const de = assess({
    videoDescriptions: descriptions(UR, 9, EN),
    officialWebsiteLinks: ['https://example.de'],
  });
  assert.equal(de.countryStatus, 'REJECTED');
});

test('Urdu and Bengali reject alone with the full candidate set recorded', () => {
  const urdu = assess({ videoDescriptions: descriptions(UR, 9, EN) });
  assert.equal(urdu.countryStatus, 'REJECTED');
  assert.equal(urdu.detectedCreatorCountry, 'India');
  const item = urdu.decisiveEvidence.find(e => e.source === 'AGGREGATED_CONTENT_LANGUAGE');
  assert.ok(item);
  assert.deepEqual(item.candidateCountries, ['Pakistan', 'India']);
  const urduEight = assess({ videoDescriptions: descriptions(UR, 8, EN) });
  assert.equal(urduEight.countryStatus, 'REJECTED');
  const bengali = assess({ videoDescriptions: descriptions(BN, 8, EN) });
  assert.equal(bengali.countryStatus, 'REJECTED');
  const bnItem = bengali.decisiveEvidence.find(e => e.source === 'AGGREGATED_CONTENT_LANGUAGE');
  assert.ok(bnItem);
  assert.deepEqual(bnItem.candidateCountries, ['Bangladesh', 'India']);
});

test('Tagalog 10/10 rejects as Philippines', () => {
  const tl = assess({ videoDescriptions: descriptions(TL, 10) });
  assert.equal(tl.countryStatus, 'REJECTED');
  assert.equal(tl.detectedCreatorCountry, 'Philippines');
});

test('any set member leaving the live list disables language rejection', () => {
  const withoutIndia = EXCLUDED.filter(e => e.country_name !== 'India');
  assert.notEqual(assess({ videoDescriptions: descriptions(HI, 10) }, withoutIndia).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(UR, 9, EN) }, withoutIndia).countryStatus, 'REJECTED');
  assert.notEqual(assess({ videoDescriptions: descriptions(BN, 8, EN) }, withoutIndia).countryStatus, 'REJECTED');
  const withoutPakistan = EXCLUDED.filter(e => e.country_name !== 'Pakistan');
  assert.notEqual(assess({ videoDescriptions: descriptions(UR, 9, EN) }, withoutPakistan).countryStatus, 'REJECTED');
  const withoutBangladesh = EXCLUDED.filter(e => e.country_name !== 'Bangladesh');
  assert.notEqual(assess({ videoDescriptions: descriptions(BN, 8, EN) }, withoutBangladesh).countryStatus, 'REJECTED');
  const withoutVietnam = EXCLUDED.filter(e => e.country_name !== 'Vietnam');
  assert.notEqual(assess({ videoDescriptions: descriptions(VI, 10) }, withoutVietnam).countryStatus, 'REJECTED');
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

test('validator threads descriptions and provenance without touching the boundary', () => {
  const evidence = creatorLevelCountryEvidence({
    channelName: 'Test',
    description: '',
    videoDescriptions: descriptions(VI, 10),
    videoDescriptionsAuthoritative: true,
    playlists: [],
  });
  assert.deepEqual(evidence.videoDescriptions, descriptions(VI, 10));
  assert.equal(evidence.videoDescriptionsAuthoritative, true);
  assert.deepEqual(evidence.videoTitles, []);
  assert.equal(evidence.aboutBio, '');
  const search = creatorLevelCountryEvidence({
    channelName: 'Test',
    description: '',
    videoDescriptions: descriptions(VI, 10),
    videoDescriptionsAuthoritative: false,
  });
  assert.equal(search.videoDescriptionsAuthoritative, false);
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function languageRow(set: string[], representative: string, language = 'Urdu', votes = '9/10'): Record<string, unknown> {
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
        details: `  [P3] AGGREGATED_CONTENT_LANGUAGE: ${representative} (86/100) — ${votes} recent video descriptions in ${language} (candidate countries [${set.join(', ')}], all currently excluded). [field: videoDescriptions]`,
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

test('parser selects the latest rejected validation record, not a flattened trail', () => {
  const channel = {
    channel_id: 'UCtesttesttesttesttest03',
    channel_name: 'Test',
    country: 'Bangladesh',
    country_status: 'REJECTED',
    trading_status: 'UNKNOWN',
    inspection_trail: [
      {
        step: 'COUNTRY_VALIDATION',
        title: 'Country Validation',
        status: 'REJECTED',
        details: '  [P3] AGGREGATED_CONTENT_LANGUAGE: India (86/100) — 9/10 recent video descriptions in Urdu (candidate countries [Pakistan, India], all currently excluded). [field: videoDescriptions]',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        step: 'VIDEO_DESCRIPTIONS',
        title: 'Step 3 — Latest Video Descriptions',
        status: 'FOUND',
        details: 'unrelated discord step mentioning AGGREGATED_CONTENT_LANGUAGE: Vietnam (candidate countries [Vietnam]) in passing',
        timestamp: '2026-01-02T00:00:00.000Z',
      },
      {
        step: 'COUNTRY_VALIDATION',
        title: 'Country Validation (Bangladesh) — Live About',
        status: 'REJECTED',
        details: '  [P3] AGGREGATED_CONTENT_LANGUAGE: Bangladesh (86/100) — 8/10 recent video descriptions in Bengali (candidate countries [Bangladesh, India], all currently excluded). [field: videoDescriptions]',
        timestamp: '2026-01-03T00:00:00.000Z',
      },
    ],
  };
  // A flattened-trail parser would mix the first representative (India) with
  // the first set ([Pakistan, India]); the record-scoped parser returns the
  // latest rejected validation's own evidence.
  const parsed = parseAggregatedLanguageRejection(channel as never);
  assert.deepEqual(parsed, { representative: 'Bangladesh', countries: ['Bangladesh', 'India'] });
});

test('a newer non-language rejected validation yields no language parse', () => {
  const channel = {
    channel_id: 'UCtesttesttesttesttest04',
    channel_name: 'Test',
    country: 'India',
    country_status: 'REJECTED',
    trading_status: 'UNKNOWN',
    inspection_trail: [
      {
        step: 'COUNTRY_VALIDATION',
        title: 'Country Validation',
        status: 'REJECTED',
        details: '  [P3] AGGREGATED_CONTENT_LANGUAGE: India (86/100) — 9/10 recent video descriptions in Urdu (candidate countries [Pakistan, India], all currently excluded). [field: videoDescriptions]',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        step: 'COUNTRY_VALIDATION',
        title: 'Country Validation (India) — Live About',
        status: 'REJECTED',
        details: "  [P1] OFFICIAL_YOUTUBE_METADATA: India (100/100) — YouTube's official channel country field identifies India. [field: locationTag]",
        timestamp: '2026-01-03T00:00:00.000Z',
      },
    ],
  };
  assert.equal(parseAggregatedLanguageRejection(channel as never), null);
});

test('removing a non-representative member restores the row', () => {
  const row = languageRow(['Pakistan', 'India'], 'India');
  const kept = classifyReconciliationState(row as never, EXCLUDED as never, []);
  assert.equal(kept.state, 'RETAIN_EXCLUDED');
  const withoutPakistan = EXCLUDED.filter(e => e.country_name !== 'Pakistan');
  const restored = classifyReconciliationState(row as never, withoutPakistan as never, []);
  assert.equal(restored.state, 'RECOVERABLE_NON_EXCLUDED');
  assert.equal(restored.detectedCountry, null);
});

test('single-country language rejection honors live-list edits', () => {
  const row = languageRow(['Vietnam'], 'Vietnam', 'Vietnamese', '10/10');
  const kept = classifyReconciliationState(row as never, EXCLUDED as never, []);
  assert.equal(kept.state, 'RETAIN_EXCLUDED');
  assert.equal(kept.detectedCountry, 'Vietnam');
  const withoutVietnam = EXCLUDED.filter(e => e.country_name !== 'Vietnam');
  const restored = classifyReconciliationState(row as never, withoutVietnam as never, []);
  assert.equal(restored.state, 'RECOVERABLE_NON_EXCLUDED');
  assert.equal(restored.detectedCountry, null);
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

test('still-excluded legitimate language rows remain excluded', () => {
  const row = languageRow(['Pakistan', 'India'], 'India');
  const kept = classifyReconciliationState(row as never, EXCLUDED as never, []);
  assert.equal(kept.state, 'RETAIN_EXCLUDED');
  assert.equal(kept.detectedCountry, 'India');
});

test('recovery clears the stale representative so the restored row is genuinely visible', () => {
  const source = readFileSync(new URL('./countryBoundaryRecovery.ts', import.meta.url), 'utf8');
  // Null-country branch: no replacement country is projected, the stale
  // excluded representative is cleared, and the row reopens as UNCERTAIN.
  assert.match(source, /channel\.country = null/);
  assert.match(source, /channel\.country_status = 'UNCERTAIN'/);
});

test('human-rejected rows are never machine-restored', () => {
  const source = readFileSync(new URL('./countryBoundaryRecovery.ts', import.meta.url), 'utf8');
  assert.match(source, /channel\.trading_status === 'HUMAN_REJECTED'/);
});
