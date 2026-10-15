import assert from 'node:assert/strict';
import test from 'node:test';
import { snippetLanguage } from './youtube';
import { selectExplicitTerminologyLanguageContext } from './terminologyLanguageContext';

test('snippetLanguage prefers per-video audio language, then default language', () => {
  assert.equal(snippetLanguage({ defaultAudioLanguage: 'de-DE', defaultLanguage: 'en' }), 'de-DE');
  assert.equal(snippetLanguage({ defaultLanguage: 'fr' }), 'fr');
  assert.equal(snippetLanguage({}), undefined);
  assert.equal(snippetLanguage(null), undefined);
  assert.equal(snippetLanguage(undefined), undefined);
  assert.equal(snippetLanguage({ defaultLanguage: '' }), undefined);
  assert.equal(snippetLanguage({ defaultLanguage: '   ' }), undefined);
  assert.equal(snippetLanguage({ defaultLanguage: 42 }), undefined);
});

test('provider-shaped video unanimity supplies context; conflict stays unknown', () => {
  // Unanimous video languages (undated/unknown entries carry no vote).
  assert.deepEqual(
    selectExplicitTerminologyLanguageContext({ videos: [{ language: 'de' }, { language: 'de-DE' }] }),
    { language: 'de' }
  );
  // Conflicting video languages never resolve: fail closed, never guessed.
  assert.equal(
    selectExplicitTerminologyLanguageContext({ videos: [{ language: 'de' }, { language: 'en' }] }),
    undefined
  );
  assert.equal(selectExplicitTerminologyLanguageContext({ videos: [] }), undefined);
  assert.equal(selectExplicitTerminologyLanguageContext({}), undefined);
});

test('channel-level detected language applies only as a single fallback signal', () => {
  assert.deepEqual(
    selectExplicitTerminologyLanguageContext({ detectedLanguages: [{ language: 'de' }] }),
    { language: 'de' }
  );
  // Invalid provider tags are dropped, never fabricated into a language.
  // (Note: 'xx-!!' normalizes to the shape-valid code 'xx' by the pre-existing
  // normalizer — out of scope here; provider tags are BCP 47 in practice.)
  assert.equal(selectExplicitTerminologyLanguageContext({ detectedLanguages: [{ language: '!!!' }] }), undefined);
  assert.equal(selectExplicitTerminologyLanguageContext({ detectedLanguages: [{ language: '' }] }), undefined);
});
