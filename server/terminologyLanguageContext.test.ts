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
