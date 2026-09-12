import assert from 'node:assert/strict';
import test from 'node:test';
import { assessLanguageCapability, canonicalLanguage, canonicalLocale, detectScripts, observeLanguageField } from './globalLanguageModel';

test('normalizes BCP 47 identity independently from country and market region', () => {
  assert.equal(canonicalLanguage('SR_cyrl_RS'), 'sr');
  assert.equal(canonicalLocale('sr_cyrl_rs'), 'sr-Cyrl-RS');
  const decision = assessLanguageCapability(
    [{ field: 'title', text: 'Анализа трговања', language: 'sr-Cyrl' }],
    { creatorCountry: 'Germany', declaredPlatformCountry: 'DE', contentLanguage: 'sr-Cyrl', contentScript: 'Cyrl', targetAudienceLocale: 'sr-RS', marketRegions: ['US'], providerRegion: 'EU' }
  );
  assert.equal(decision.disposition, 'SUPPORTED');
  assert.equal(decision.context.creatorCountry, 'Germany');
  assert.deepEqual(decision.context.marketRegions, ['US']);
  assert.match(decision.provenanceChecksum, /^[a-f0-9]{64}$/);
});

test('models multiscript, transliterated, and code-switched content explicitly', () => {
  assert.deepEqual(detectScripts('تعليم trading'), ['Arab', 'Latn']);
  const mixed = observeLanguageField('bio', 'تعليم trading', 'ar');
  assert.equal(mixed.codeSwitched, true);
  const transliterated = observeLanguageField('title', 'tahlil al aswaq', 'ar');
  assert.equal(transliterated.transliterated, true);
});

test('unknown languages and declared-script mismatches abstain deterministically', () => {
  assert.equal(assessLanguageCapability([{ field: 'title', text: 'trading' }], {}).disposition, 'ABSTAIN');
  const mismatch = assessLanguageCapability([{ field: 'title', text: 'торговля', language: 'ru' }], { contentLanguage: 'ru', contentScript: 'Latn' });
  assert.equal(mismatch.disposition, 'ABSTAIN');
  assert.ok(mismatch.reasonCodes.includes('DECLARED_DETECTED_SCRIPT_MISMATCH'));
});

test('Arabic, Cyrillic, Devanagari, and Hangul can enter pinned controlled trials', () => {
  for (const [language, script, text] of [['ar', 'Arab', 'تداول'], ['ru', 'Cyrl', 'трейдинг'], ['hi', 'Deva', 'ट्रेडिंग'], ['ko', 'Hang', '트레이딩']] as const) {
    const decision = assessLanguageCapability([{ field: 'query', text, language }], { contentLanguage: language, contentScript: script }, { controlledTrial: true });
    assert.equal(decision.disposition, 'CONTROLLED_TRIAL');
  }
});

test('Vietnamese/Tagalog Latin-script content is not flagged transliterated', () => {
  // Forensic: vi/tl/ms/id defaulted to Latn via fallback; pin explicit mapping
  // so diacritic-heavy Vietnamese is never treated as transliterated Latin.
  const vi = observeLanguageField('title', 'phân tích kỹ thuật chứng khoán', 'vi');
  assert.equal(vi.transliterated, false);
  assert.ok(vi.scripts.includes('Latn'));
  const tl = observeLanguageField('title', 'pamilihan ng stock trading pilipinas', 'tl');
  assert.equal(tl.transliterated, false);
});
