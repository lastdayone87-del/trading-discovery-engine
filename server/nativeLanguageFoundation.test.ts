import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLanguage, languageScript } from './languageDetection';
import { detectCodeSwitching } from './countryNativeIntelligence';
import { dashboardSearchEligibility, isSearchableTradingTerm, orderDashboardTerminologyRows } from './terminologySearchability';
import { buildQueryCandidate, evaluateQueryComposition } from './queryQuality/composition';
import { admitQueryRecord } from './queryQuality/admission';
import { evaluateAutonomousQueryAuthority } from './autonomousQueryAuthority';
import { planCountryNativeProposalQuery } from './queryPlanner';
import { resolveEvidenceDocumentLanguage } from './evidenceEngine/documentStore';
import type { QueryRecord } from '../src/types';

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

test('script detection requires a dominant non-Latin share', () => {
  const mixed = detectLanguage('technical analysis の chart');
  assert.equal(mixed.language, 'en');
  assert.equal(mixed.script, 'Latn');
  // An unsupported script must not be persisted as Latin.
  const thai = detectLanguage('ตลาดหุ้น');
  assert.equal(thai.script, 'Zyyy');
  assert.equal(thai.language, 'und');
  // Genuinely non-Latin surfaces still win.
  assert.equal(detectLanguage('日経225先物', { countryHint: 'Japan' }).language, 'ja');
  // Scripts are counted separately: one stray kana cannot override a
  // dominant Arabic surface or turn a mostly-Thai surface into Japanese.
  assert.equal(detectLanguage('مرحبا بالعالم の').language, 'ar');
  const thaiJapanese = detectLanguage('ตลาดหุ้น の');
  assert.equal(thaiJapanese.language, 'und');
  assert.equal(thaiJapanese.script, 'Zyyy');
  // A ticker inside a mostly unsupported-script surface must not make the
  // whole document look Latin either.
  assert.equal(detectLanguage('ตลาดหุ้น NQ').script, 'Zyyy');
});

test('country hints only resolve textual ties and never override clear evidence', () => {
  assert.equal(detectLanguage('technical market chart', { countryHint: 'Germany' }).language, 'en');
  assert.equal(detectLanguage('analyse', { countryHint: 'Japan' }).language, 'und');
  assert.equal(detectLanguage('action', { countryHint: 'Japan' }).language, 'und');
  // A shared English/Portuguese loanword stays und unless a tie-breaking
  // hint names one of the tied languages.
  assert.equal(detectLanguage('trade').language, 'und');
  assert.equal(detectLanguage('trade', { countryHint: 'Brazil' }).language, 'pt');
  // Luxembourg's authoritative primary language is French; hinting an
  // unsupported `lb` lexicon could never resolve a tie.
  assert.equal(detectLanguage('analyse', { countryHint: 'Luxembourg' }).language, 'fr');
});

test('evidence persistence carries the market hint into language detection', () => {
  assert.deepEqual(
    resolveEvidenceDocumentLanguage({ normalizedText: '日経225先物' }, 'Japan'),
    { language: 'ja', script: 'Hani' },
  );
  assert.deepEqual(
    resolveEvidenceDocumentLanguage({ normalizedText: '日経225先物' }),
    { language: 'zh', script: 'Hani' },
  );
  assert.deepEqual(
    resolveEvidenceDocumentLanguage({ normalizedText: '日経225先物', language: 'en', script: 'Latn' }, 'Japan'),
    { language: 'en', script: 'Latn' },
    'provider metadata always wins',
  );
});

test('terminology observations no longer default an identifiable surface to und', () => {
  assert.equal(detectCodeSwitching('日経225先物', 'und', 'Japan').termLanguage, 'ja');
  assert.equal(detectCodeSwitching('analyse technique').termLanguage, 'fr');
  assert.equal(detectCodeSwitching('order flow').termLanguage, 'en');
  // An unknown short string still fails closed rather than inventing a language.
  assert.equal(detectCodeSwitching('xyzzy').termLanguage, 'und');
  // German day-trading spelling must be in the lexicon (not `tagesrading`).
  assert.equal(detectLanguage('Tagestrading DAX', { countryHint: 'Germany' }).language, 'de');
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

test('dashboard eligibility reflects the planner gate, not a stale flag', () => {
  assert.equal(dashboardSearchEligibility({ canonical_term: '🔴', term_type: 'FORMAT', country: 'United States', language: 'en', lifecycle_status: 'SEARCH_TRIAL', search_eligible: true }).search_eligible, false);
  assert.equal(dashboardSearchEligibility({ canonical_term: '#daytrading', term_type: 'FORMAT', country: 'United States', language: 'en', lifecycle_status: 'SEARCH_TRIAL', search_eligible: true }).search_eligible, false);
  assert.equal(dashboardSearchEligibility({ canonical_term: 'ICT', term_type: 'TERMINOLOGY', country: 'United States', language: 'en', lifecycle_status: 'SEARCH_TRIAL', search_eligible: true }).search_eligible, true);
  assert.equal(dashboardSearchEligibility({ canonical_term: 'ICT', term_type: 'TERMINOLOGY', country: 'United States', language: 'en', lifecycle_status: 'DEMOTED', search_eligible: false }).search_eligible, false);
  assert.equal(dashboardSearchEligibility({ canonical_term: 'ICT', term_type: 'TERMINOLOGY', country: 'United States', language: 'en', lifecycle_status: 'OBSERVED', search_eligible: true }).search_eligible, false);
  assert.equal(dashboardSearchEligibility({ canonical_term: 'Footprint Trading', term_type: 'TERMINOLOGY', country: 'United States', language: 'en', lifecycle_status: 'PROVEN_SEARCH_TERM', search_eligible: true }).search_eligible, true);
});

test('dashboard ordering uses computed eligibility', () => {
  const rows = [
    { canonical_term: '🔴', term_type: 'FORMAT', country: 'United States', language: 'en', lifecycle_status: 'SEARCH_TRIAL', search_eligible: true },
    { canonical_term: 'ICT', term_type: 'TERMINOLOGY', country: 'United States', language: 'en', lifecycle_status: 'SEARCH_TRIAL', search_eligible: true },
    { canonical_term: 'Footprint Trading', term_type: 'TERMINOLOGY', country: 'United States', language: 'en', lifecycle_status: 'PROVEN_SEARCH_TERM', search_eligible: true },
    { canonical_term: 'Gold', term_type: 'INSTRUMENT', country: 'United States', language: 'en', lifecycle_status: 'DEMOTED', search_eligible: false },
  ];
  const ordered = orderDashboardTerminologyRows(rows.map(row => ({ ...row, ...dashboardSearchEligibility(row) })));
  assert.equal(ordered[0].canonical_term, 'ICT');
  assert.equal(ordered[ordered.length - 1].canonical_term, 'Gold');
  // A stale false flag on an active, gate-passing term must not hide it.
  assert.equal(dashboardSearchEligibility({ canonical_term: 'ICT', term_type: 'TERMINOLOGY', country: 'United States', language: 'en', lifecycle_status: 'SEARCH_TRIAL', search_eligible: false }).search_eligible, true);
});

test('unrelated foreign terms remain ineligible after the CJK relaxation', () => {
  const gate = isSearchableTradingTerm({ term: 'Börsenanalyse', termType: 'TERMINOLOGY', country: 'Japan', language: 'ja' });
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.includes('no-trading-semantics'));
});

test('boundary-free matching admits only unspaced native semantics', () => {
  // Latin/ticker fragments inside a CJK term keep word boundaries, and
  // denied compounds are stripped even inside longer or punctuated phrases.
  for (const term of [
    'cooking動画', '株tradingcard', 'DOM操作', '日本pocket',
    'トレードオフ', 'トレードオフ分析', 'トレード・オフ', 'トレードマーク分析',
  ]) {
    const gate = isSearchableTradingTerm({ term, termType: 'TERMINOLOGY', country: 'Japan', language: 'ja' });
    assert.equal(gate.eligible, false, `${term} unexpectedly passed: ${gate.reasons.join(', ')}`);
  }
  // Intended Japanese compounds continue to pass, including a surface where
  // a denied reading and a separate genuine trading semantic coexist.
  for (const term of ['ドル円トレード', '板読みトレード', 'デイトレード手法', '東京セッション', 'トレードオフトレード']) {
    const gate = isSearchableTradingTerm({ term, termType: 'TERMINOLOGY', country: 'Japan', language: 'ja' });
    assert.equal(gate.eligible, true, `${term}: ${gate.reasons.join(', ')}`);
  }
});

test('a reviewed native phrase is admissible as one bounded whole query', () => {
  const query = 'analisi tecnica borsa italiana';
  const candidate = buildQueryCandidate({
    query,
    country: 'Italy',
    language: 'it',
    atoms: [{
      term: query,
      role: 'ANCHOR',
      type: 'TERMINOLOGY',
      country: 'Italy',
      language: 'it',
      provenance: 'COUNTRY_VOCABULARY',
    }],
    source: 'COUNTRY_VOCABULARY',
  });
  const decision = evaluateQueryComposition(candidate, { scopeAuthorized: true });
  assert.equal(decision.eligible, true, decision.reasonCodes.join(', '));
  assert.equal(decision.tier, 'LICENSED_UNSEEN');

  // The COUNTRY_NATIVE planner path must produce the same runnable surface
  // instead of rejecting it before admission.
  const planned = planCountryNativeProposalQuery({
    country: 'Italy',
    nativeTerm: query,
    targetIntent: 'education',
    allocationLineage: { decisionId: 'native-phrase-decision', proposalId: 'native-phrase-proposal' },
  });
  assert.ok(planned);
  assert.equal(planned.query, query);
  const admitted = admitQueryRecord({
    query: planned.query,
    country: 'Italy',
    primary_term: planned.primaryTerm,
    generation_metadata: planned.metadata,
  }, { scopeAuthorized: true });
  assert.equal(admitted.eligible, true, admitted.reasonCodes.join(', '));

  // Execution authority must accept the same bounded surface; otherwise it
  // would be quarantined before quota spend.
  const record: QueryRecord = {
    id: 1,
    query: planned.query,
    country: 'Italy',
    collection: 'EXPERIMENTAL',
    intent: planned.intent,
    times_executed: 0,
    total_channels_found: 0,
    unique_channels_found: 0,
    quality_channels_found: 0,
    community_channels_found: 0,
    avg_quality_score: 0,
    performance_score: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    status: 'ACTIVE',
    primary_term: planned.primaryTerm,
    // Italy is dormant; simulate the live scope selection that authorizes
    // execution. The token/provenance gates are what this assertion covers.
    generation_metadata: { ...planned.metadata, scopePromoted: true },
  };
  const authority = evaluateAutonomousQueryAuthority(record, { scopePromotionActive: true });
  assert.equal(authority.eligible, true, authority.reasonCodes.join(', '));
});
