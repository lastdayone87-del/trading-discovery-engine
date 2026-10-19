import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVIDENCE_SCREENING_POLICY_VERSION,
  SCREENING_REASONS,
  screenEvidenceCandidate,
  screenEvidenceCandidates,
  type EvidenceScreeningBaseline,
} from './evidenceScreening';
import {
  evidenceCandidateKeyForTerm,
  evidenceCanonicalIdentity,
  type EvidenceCandidate,
} from './evidenceExtraction';
import { normalizeTerm } from '../terminologyIntelligence';

function candidate(term: string): EvidenceCandidate {
  const normalized = normalizeTerm(term);
  return {
    rawTerm: term,
    normalizedTerm: normalized,
    signalKind: 'VIDEO_TAG',
    canonicalIdentity: evidenceCanonicalIdentity(normalized),
    canonicalCandidateKey: evidenceCandidateKeyForTerm(normalized),
    frequency: 1,
    provenance: [],
  };
}

function baseline(overrides: Partial<EvidenceScreeningBaseline> = {}): EvidenceScreeningBaseline {
  return {
    country: 'Germany',
    catalogOk: true,
    catalogTerms: [],
    stagedOk: true,
    stagedCanonicalKeys: [],
    vocabOk: true,
    vocabLanguages: null,
    curatedTerms: [],
    ...overrides,
  };
}

test('APPROVED D4: a country without a curated vocabulary row can reach PROBE_ELIGIBLE', () => {
  const result = screenEvidenceCandidate(candidate('Flux Orderflow Strategie'), baseline());
  assert.equal(result.decision, 'PROBE_ELIGIBLE');
  assert.ok(result.reasons.includes(SCREENING_REASONS.PASS));
  assert.ok(result.reasons.includes(SCREENING_REASONS.NO_CURATED_VOCABULARY));
  assert.equal(result.policyVersion, EVIDENCE_SCREENING_POLICY_VERSION);
});

test('a missing vocabulary row is not the same as a failed vocabulary lookup', () => {
  // Row absent (vocabOk=true, vocabLanguages=null) => eligible (D4).
  assert.equal(
    screenEvidenceCandidate(candidate('Flux Orderflow Strategie'), baseline()).decision,
    'PROBE_ELIGIBLE'
  );
  // Lookup failed (vocabOk=false) => fail closed.
  const failed = screenEvidenceCandidate(
    candidate('Flux Orderflow Strategie'),
    baseline({ vocabOk: false })
  );
  assert.equal(failed.decision, 'REJECT');
  assert.deepEqual(failed.reasons, [SCREENING_REASONS.BASELINE_LOOKUP_FAILED]);
});

test('catalog and staging lookup failures fail closed before any positive classification', () => {
  const noCatalog = screenEvidenceCandidate(candidate('Flux Orderflow Strategie'), baseline({ catalogOk: false }));
  assert.equal(noCatalog.decision, 'REJECT');
  assert.deepEqual(noCatalog.reasons, [SCREENING_REASONS.BASELINE_LOOKUP_FAILED]);

  const noStaging = screenEvidenceCandidate(candidate('Flux Orderflow Strategie'), baseline({ stagedOk: false }));
  assert.equal(noStaging.decision, 'REJECT');
  assert.deepEqual(noStaging.reasons, [SCREENING_REASONS.BASELINE_LOOKUP_FAILED]);
});

test('country vocabulary language profile rejects explicit mismatches and passes matches', () => {
  const germanProfile = baseline({ vocabLanguages: ['de'], curatedTerms: ['Börsenanalyse'] });
  const mismatch = screenEvidenceCandidate(candidate('Flux Orderflow Strategie'), {
    ...germanProfile,
    language: 'fr',
  });
  assert.equal(mismatch.decision, 'REJECT');
  assert.deepEqual(mismatch.reasons, [SCREENING_REASONS.LANGUAGE_MISMATCH]);

  const match = screenEvidenceCandidate(candidate('Flux Orderflow Strategie'), {
    ...germanProfile,
    language: 'de-CH',
  });
  assert.equal(match.decision, 'PROBE_ELIGIBLE');
  assert.ok(match.reasons.includes(SCREENING_REASONS.LANGUAGE_FIT_CHECKED));

  const unknownLanguage = screenEvidenceCandidate(candidate('Flux Orderflow Strategie'), germanProfile);
  assert.equal(unknownLanguage.decision, 'PROBE_ELIGIBLE');
  assert.ok(unknownLanguage.reasons.includes(SCREENING_REASONS.LANGUAGE_FIT_UNKNOWN));
});

test('spam signals reject with machine-readable codes (multilingual)', () => {
  const fr = screenEvidenceCandidate(candidate('Rejoignez mon canal Telegram signaux gratuits'), baseline());
  assert.equal(fr.decision, 'REJECT');
  assert.ok(fr.reasons.some(reason => reason.startsWith('SPAM:')), JSON.stringify(fr.reasons));

  const en = screenEvidenceCandidate(candidate('guaranteed 100x gains'), baseline());
  assert.equal(en.decision, 'REJECT');
  assert.ok(en.reasons.some(reason => reason.startsWith('SPAM:')));
});

test('generic terms reject: domain generics, known instruments, curated vocabulary', () => {
  const generic = screenEvidenceCandidate(candidate('trading'), baseline());
  assert.deepEqual([generic.decision, generic.reasons], ['REJECT', [SCREENING_REASONS.GENERIC_TERM]]);

  const instrument = screenEvidenceCandidate(candidate('DAX'), baseline());
  assert.deepEqual([instrument.decision, instrument.reasons], ['REJECT', [SCREENING_REASONS.GENERIC_TERM]]);

  const curated = screenEvidenceCandidate(
    candidate('Börsenanalyse'),
    baseline({ vocabLanguages: ['de'], curatedTerms: ['Börsenanalyse'] })
  );
  assert.deepEqual([curated.decision, curated.reasons], ['REJECT', [SCREENING_REASONS.GENERIC_TERM]]);
});

test('duplicates against the catalog and staged staging keys reject deterministically', () => {
  const duplicateCatalog = screenEvidenceCandidate(
    candidate('Order Flow'),
    baseline({ catalogTerms: ['order flow'] })
  );
  assert.deepEqual([duplicateCatalog.decision, duplicateCatalog.reasons], ['REJECT', [SCREENING_REASONS.DUPLICATE_CATALOG]]);

  const key = evidenceCandidateKeyForTerm(normalizeTerm('Order Flow'));
  const duplicateStaged = screenEvidenceCandidate(
    candidate('Order Flow'),
    baseline({ stagedCanonicalKeys: [key] })
  );
  assert.deepEqual([duplicateStaged.decision, duplicateStaged.reasons], ['REJECT', [SCREENING_REASONS.DUPLICATE_STAGED]]);
});

test('batches reject intra-batch duplicates after the first occurrence', () => {
  const first = candidate('Order Flow');
  const second = candidate('Order Flow');
  const screened = screenEvidenceCandidates([first, second], baseline());
  assert.equal(screened[0].decision, 'PROBE_ELIGIBLE');
  assert.equal(screened[1].decision, 'REJECT');
  assert.deepEqual(screened[1].reasons, [SCREENING_REASONS.DUPLICATE_BATCH]);
});

test('screening is deterministic for identical inputs', () => {
  const candidates = [candidate('Order Flow'), candidate('trading'), candidate('Rejoignez mon canal gratuit')];
  const subject = baseline({ vocabLanguages: ['en'], language: 'en' });
  assert.deepEqual(screenEvidenceCandidates(candidates, subject), screenEvidenceCandidates(candidates, subject));
});
