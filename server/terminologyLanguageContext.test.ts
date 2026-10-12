import assert from 'node:assert/strict';
import test from 'node:test';
import { selectExplicitTerminologyLanguageContext } from './terminologyLanguageContext';

test('final integration: highest-confidence explicit detected language is selected', () => {
  assert.deepEqual(selectExplicitTerminologyLanguageContext({
    detectedLanguages: [
      { language: 'fr', confidence: 72 },
      { language: 'de', confidence: 91 }
    ]
  }), { language: 'de' });
});

test('final integration: conflicting equally strong language evidence remains unknown', () => {
  assert.equal(selectExplicitTerminologyLanguageContext({
    detectedLanguages: [
      { language: 'de', confidence: 90 },
      { language: 'fr', confidence: 90 }
    ]
  }), undefined);
});

test('final integration: one explicit document language can supply context', () => {
  assert.deepEqual(selectExplicitTerminologyLanguageContext({
    videos: [{ language: 'fr' }, { language: 'fr-FR' }]
  }), { language: 'fr' });
});

test('final integration: und and absent language never become an inferred language', () => {
  assert.equal(selectExplicitTerminologyLanguageContext({ detectedLanguages: [{ language: 'und', confidence: 100 }] }), undefined);
  assert.equal(selectExplicitTerminologyLanguageContext({ videos: [{}, {}] }), undefined);
});

test('final integration: unanimous regional tags preserve the locale', () => {
  assert.deepEqual(selectExplicitTerminologyLanguageContext({
    detectedLanguages: [{ language: 'de-DE', confidence: 90 }]
  }), { language: 'de', locale: 'de-DE' });
  assert.deepEqual(selectExplicitTerminologyLanguageContext({
    videos: [{ language: 'pt-BR' }]
  }), { language: 'pt', locale: 'pt-BR' });
  assert.deepEqual(selectExplicitTerminologyLanguageContext({
    detectedLanguages: [{ language: 'en_us', confidence: 80 }]
  }), { language: 'en', locale: 'en-US' });
});

test('final integration: conflicting regional tags keep language but drop locale', () => {
  assert.deepEqual(selectExplicitTerminologyLanguageContext({
    detectedLanguages: [
      { language: 'de-DE', confidence: 90 },
      { language: 'de-AT', confidence: 90 }
    ]
  }), { language: 'de' });
  assert.deepEqual(selectExplicitTerminologyLanguageContext({
    videos: [{ language: 'fr' }, { language: 'fr-FR' }]
  }), { language: 'fr' });
});
