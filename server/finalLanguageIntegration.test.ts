import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import { countrySearchHints, hasCountrySearchHint } from './countrySearchHints';
import { planCountryNativeProposalQuery } from './queryPlanner';
import { preferredLanguageFromQueryMetadata } from './queueManager';

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

test('final integration: every normal extraction family receives explicit language fields', () => {
  const source = readFileSync(new URL('./queryIntelligence.ts', import.meta.url), 'utf8');
  const calls = source.split('await observeTerminology({').slice(1);
  assert.equal(calls.length, 5, 'rule-based plus four Gemini extraction families must remain covered');
  for (const call of calls) {
    assert.match(call, /language: languageContext\?\.language/);
    assert.match(call, /locale: languageContext\?\.locale/);
  }
});

test('final integration: every authoritative supported country has an explicit provider hint', () => {
  for (const item of INITIAL_COUNTRY_VOCABULARIES) {
    assert.equal(hasCountrySearchHint(item.country), true, `${item.country} must remain covered by countrySearchHints`);
  }
});
