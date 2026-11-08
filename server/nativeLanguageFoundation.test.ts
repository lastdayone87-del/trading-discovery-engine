import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLanguage, languageScript } from './languageDetection';
import { detectCodeSwitching } from './countryNativeIntelligence';
import { isSearchableTradingTerm } from './terminologySearchability';

test('language detection identifies supported market languages from real local surfaces', () => {
  const cases: Array<[string, string, string]> = [
    ['analyse technique CAC 40', 'France', 'fr'],
    ['DAX Analyse Charttechnik', 'Germany', 'de'],
    ['日経225先物 デイトレード', 'Japan', 'ja'],
    ['análisis técnico IBEX 35', 'Spain', 'es'],
    ['analisi tecnica FTSE MIB', 'Italy', 'it'],
    ['technische analyse AEX', 'Netherlands', 'nl'],
    ['day trade mini índice', 'Brazil', 'pt'],
    ['teknisk analys OMXS30', 'Sweden', 'sv'],
    ['aktiehandel OMXC25', 'Denmark', 'da'],
    ['aksjehandel OBX', 'Norway', 'no'],
    ['technical analysis NQ futures', 'United States', 'en'],
  ];
  for (const [text, countryHint, expected] of cases) {
    const result = detectLanguage(text, { countryHint });
    assert.equal(result.language, expected, `${text} -> ${result.language}, expected ${expected}: ${JSON.stringify(result)}`);
    assert.ok(result.confidence > 0.3, `${text} confidence ${result.confidence}`);
  }
  assert.equal(detectLanguage('日経225先物', { countryHint: 'Japan' }).language, 'ja');
  assert.equal(detectLanguage('デイトレード').script, 'Jpan');
  assert.equal(detectLanguage('股票交易').language, 'zh');
  assert.equal(languageScript('ja'), 'Jpan');
  assert.equal(languageScript('fr'), 'Latn');
});

test('terminology observations no longer default an identifiable surface to und', () => {
  assert.equal(detectCodeSwitching('日経225先物', 'und', 'Japan').termLanguage, 'ja');
  assert.equal(detectCodeSwitching('analyse technique').termLanguage, 'fr');
  assert.equal(detectCodeSwitching('order flow').termLanguage, 'en');
  // An unknown short string still fails closed rather than inventing a language.
  assert.equal(detectCodeSwitching('xyzzy').termLanguage, 'und');
});

test('CJK compounds match reviewed semantics without space boundaries', () => {
  const cases = ['日経225先物', 'ドル円トレード', '板読みトレード', 'デイトレード手法', '東京セッション'];
  for (const term of cases) {
    const gate = isSearchableTradingTerm({ term, termType: 'TERMINOLOGY', country: 'Japan', language: 'ja' });
    assert.equal(gate.eligible, true, `${term}: ${gate.reasons.join(', ')}`);
  }
});

test('reviewed native terms pass the semantic and token gates', () => {
  const cases: Array<[string, string, string]> = [
    ['análisis bursátil', 'Spain', 'es'],
    ['estructura de mercado', 'Spain', 'es'],
    ['analisi ciclica', 'Italy', 'it'],
    ['analisi tecnica borsa italiana', 'Italy', 'it'],
    ['opties handelen', 'Netherlands', 'nl'],
    ['Marktstruktur', 'Germany', 'de'],
    ['Handelsstrategie', 'Germany', 'de'],
    ['structure du marché', 'France', 'fr'],
    ['analyse boursière', 'France', 'fr'],
  ];
  for (const [term, country, language] of cases) {
    const gate = isSearchableTradingTerm({ term, termType: 'TERMINOLOGY', country, language });
    assert.equal(gate.eligible, true, `${term}: ${gate.reasons.join(', ')}`);
  }
});

test('unrelated foreign terms remain ineligible after the CJK relaxation', () => {
  const gate = isSearchableTradingTerm({ term: 'Börsenanalyse', termType: 'TERMINOLOGY', country: 'Japan', language: 'ja' });
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes('no-trading-semantics'));
});
