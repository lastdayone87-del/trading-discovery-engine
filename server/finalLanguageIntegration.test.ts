import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import { countrySearchHints, hasCountrySearchHint } from './countrySearchHints';
import { planCountryNativeProposalQuery } from './queryPlanner';
import { preferredLanguageFromQueryMetadata } from './queueManager';
import { admitNativeCandidates } from './queryIntelligence';
import { buildNoveltyBaseline } from './terminologyIntelligence';
import type { ChannelRecord } from '../src/types';
import type { LiteralSourceText } from './terminologyIntelligence';

function vocabulary(country: string) {
  const value = INITIAL_COUNTRY_VOCABULARIES.find(item => item.country === country);
  assert.ok(value, `missing authoritative vocabulary for ${country}`);
  return value;
}

function planned(country: string, language: string | null, locale: string | null) {
  const query = planCountryNativeProposalQuery({
    country,
    nativeTerm: country === 'Belgium' ? 'analyse boursière' : country === 'Switzerland' ? 'analisi tecnica' : 'analyse marché',
    countryVocabulary: vocabulary(country),
    targetIntent: 'strategy',
    language,
    locale,
    allocationLineage: {
      decisionId: 'decision-language-1',
      proposalId: 'proposal-language-1',
      evidenceChecksum: 'language-evidence-1'
    }
  });
  assert.ok(query, `planner did not construct a query for ${country}`);
  return query;
}

test('final integration: COUNTRY_NATIVE language evidence survives planned query metadata', () => {
  const belgian = planned('Belgium', 'fr', 'fr-BE');
  assert.equal(belgian.metadata.language, 'fr');
  assert.equal(belgian.metadata.locale, 'fr-BE');
  assert.equal(belgian.metadata.preferredLanguage, 'fr');
  assert.equal(preferredLanguageFromQueryMetadata(belgian.metadata), 'fr');

  const swiss = planned('Switzerland', 'it', 'it-CH');
  assert.equal(swiss.metadata.preferredLanguage, 'it');
  assert.equal(preferredLanguageFromQueryMetadata(swiss.metadata), 'it');

  const canadian = planned('Canada', 'French', 'fr-CA');
  assert.equal(canadian.metadata.preferredLanguage, 'fr');
  assert.equal(preferredLanguageFromQueryMetadata(canadian.metadata), 'fr');
});

test('final integration: language changes provider language but never country region', () => {
  const belgian = planned('Belgium', 'fr', 'fr-BE');
  const swiss = planned('Switzerland', 'it', 'it-CH');
  const canadian = planned('Canada', 'fr', 'fr-CA');

  assert.deepEqual(countrySearchHints('Belgium', vocabulary('Belgium').languages, String(belgian.metadata.preferredLanguage)), { regionCode: 'BE', relevanceLanguage: 'fr' });
  assert.deepEqual(countrySearchHints('Switzerland', vocabulary('Switzerland').languages, String(swiss.metadata.preferredLanguage)), { regionCode: 'CH', relevanceLanguage: 'it' });
  assert.deepEqual(countrySearchHints('Canada', vocabulary('Canada').languages, String(canadian.metadata.preferredLanguage)), { regionCode: 'CA', relevanceLanguage: 'fr' });
});

test('final integration: invalid language evidence falls back without changing region', () => {
  const query = planned('Belgium', 'xx', 'fr-BE');
  assert.equal(query.metadata.preferredLanguage, 'fr');
  assert.deepEqual(countrySearchHints('Belgium', vocabulary('Belgium').languages, String(query.metadata.preferredLanguage)), { regionCode: 'BE', relevanceLanguage: 'fr' });

  const noEvidence = planned('Switzerland', null, null);
  assert.equal(noEvidence.metadata.preferredLanguage, undefined);
  assert.equal(preferredLanguageFromQueryMetadata(noEvidence.metadata), undefined);
  assert.deepEqual(countrySearchHints('Switzerland', vocabulary('Switzerland').languages), { regionCode: 'CH', relevanceLanguage: 'de' });
});

test('final integration: newly covered supported countries use stable region and primary language hints', () => {
  assert.deepEqual(countrySearchHints('Luxembourg'), { regionCode: 'LU', relevanceLanguage: 'lb' });
  assert.deepEqual(countrySearchHints('United Arab Emirates'), { regionCode: 'AE', relevanceLanguage: 'ar' });
});

test('final integration: every normal extraction family receives explicit language fields', async () => {
  // Rule path: single direct observation call site forwards both fields
  // (the helper's default dependency delegates to the same detailed writer).
  // Bounded to the rule call's own line so later Gemini fields cannot satisfy it.
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  const ruleLines = source.split('\n').filter(line => line.includes('observeTerminologyDetailed({ term: hit.instrument'));
  assert.equal(ruleLines.length, 1, 'only the rule path observes directly; Gemini families share the admission helper');
  assert.match(ruleLines[0], /language: languageContext\?\.language/);
  assert.match(ruleLines[0], /locale: languageContext\?\.locale/);
  // Shared helper (all four Gemini families): behavioral coverage — one
  // literal candidate per family, every observation carries language+locale.
  const channel = { channel_id: 'ch-lang', channel_name: 'Analyse Kanal', country: 'Germany', discord_invite: null } as unknown as ChannelRecord;
  const sources: LiteralSourceText[] = [
    { kind: 'VIDEO_TITLE', index: 0, text: 'SMC entry model', videoId: 'vid-1' },
    { kind: 'VIDEO_TITLE', index: 1, text: 'P2P-Algo live session', videoId: 'vid-2' },
    { kind: 'DESCRIPTION', index: 0, text: 'Gold Analyse Wochenausblick' },
  ];
  const observed: Array<Record<string, unknown>> = [];
  const report = await admitNativeCandidates({
    channel,
    sources,
    parsed: {
      terminology: ['SMC'],
      instruments: ['Gold'],
      phrases: ['P2P-Algo live session'],
      formats: ['Gold Analyse Wochenausblick'],
    },
    baseline: buildNoveltyBaseline({ country: 'Germany', vocab: { country: 'Germany', languages: ['de'], native_trading_terminology: [], popular_instruments: [], local_market_phrases: [], common_content_format_names: [] }, vocabOk: true, existingTerms: [], existingOk: true }),
    language: 'de',
    locale: 'de-DE',
    humanApproved: false,
    humanObservation: 'ENRICHMENT',
    deps: {
      observeTerm: async (args) => { observed.push(args as unknown as Record<string, unknown>); return { termId: 1, observationInserted: true }; },
      saveTerm: async () => undefined,
    },
  });
  assert.equal(report.admitted, 4);
  assert.equal(observed.length, 4);
  assert.deepEqual(observed.map(entry => entry.termType), ['TERMINOLOGY', 'INSTRUMENT', 'PHRASE', 'FORMAT']);
  for (const entry of observed) {
    assert.equal(entry.language, 'de');
    assert.equal(entry.locale, 'de-DE');
  }
});

test('final integration: every authoritative supported country has an explicit provider hint', () => {
  for (const item of INITIAL_COUNTRY_VOCABULARIES) {
    assert.equal(hasCountrySearchHint(item.country), true, `${item.country} must remain covered by countrySearchHints`);
  }
});
