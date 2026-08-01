import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_COUNTRY_VOCABULARIES } from '../src/data/initial_countries';
import { planDiverseQueries, isCountryScriptCompatible } from './queryPlanner';
import { getLayeredKnowledgeContext } from './evidenceEngine/knowledgePacks';
import { inferChannelCountry } from './countryInference';

const added = ['Switzerland', 'Denmark', 'Sweden', 'United Arab Emirates', 'Singapore', 'New Zealand', 'Belgium', 'Luxembourg', 'Ireland'];

test('new production countries have vocabulary, query, classification, and validation coverage', () => {
  for (const country of added) {
    const vocabulary = INITIAL_COUNTRY_VOCABULARIES.find(item => item.country === country);
    assert.ok(vocabulary, `${country} vocabulary`);
    assert.ok(vocabulary.languages.length && vocabulary.native_trading_terminology.length && vocabulary.popular_instruments.length);
    assert.ok(planDiverseQueries({ country, count: 2, countryVocabulary: vocabulary, learnedVocabulary: [], existingQueries: [] }).length >= 2, `${country} queries`);
    assert.equal(getLayeredKnowledgeContext(country).countryKnowledge?.countryName, country);
  }
  assert.equal(inferChannelCountry({ officialCountry: 'CH' }).detectedCountry, 'Switzerland');
  assert.equal(inferChannelCountry({ officialCountry: 'SG' }).detectedCountry, 'Singapore');
});

test('Arabic and Singapore Han queries use their governed scripts', () => {
  assert.equal(isCountryScriptCompatible('United Arab Emirates', 'تحليل فني'), true);
  assert.equal(isCountryScriptCompatible('Singapore', '股票交易'), true);
  assert.equal(isCountryScriptCompatible('Sweden', '股票交易'), false);
});
