import assert from 'node:assert/strict';
import test from 'node:test';
import {
  digestQueryTerminologyMetadata,
  resolveSavedTerminologyDisposition,
} from './terminologyRevalidation';

const eligible = { termId: 153, term: 'DAX', lifecycleStatus: 'SEARCH_TRIAL', searchEligible: true };
const proven = { termId: 154, term: 'Footprint Trading', lifecycleStatus: 'PROVEN_SEARCH_TERM', searchEligible: true };
const demoted = { termId: 153, term: 'DAX', lifecycleStatus: 'DEMOTED', searchEligible: false };

test('saved terminology dispositions preserve current terms and digest stale attribution', () => {
  assert.equal(resolveSavedTerminologyDisposition(eligible, true), 'CURRENT');
  assert.equal(resolveSavedTerminologyDisposition(proven, true), 'CURRENT');
  assert.equal(resolveSavedTerminologyDisposition(demoted, true), 'DIGEST');
  assert.equal(resolveSavedTerminologyDisposition(demoted, false), 'RETIRE');
  assert.equal(resolveSavedTerminologyDisposition(undefined, true), 'DIGEST');
  assert.equal(resolveSavedTerminologyDisposition(undefined, false), 'RETIRE');
});

test('digesting stale terminology keeps the genuine query metadata auditable', () => {
  const metadata = {
    queryTemplate: 'ANCHOR_LEARNED',
    terminologyId: 153,
    terminologyLifecycle: 'SEARCH_TRIAL',
    terminologyDecayedYield: 0.12,
    atoms: [{ term: 'Footprint Trading' }, { term: 'DAX' }],
  };
  const digested = digestQueryTerminologyMetadata(metadata, demoted, '2026-11-09T16:00:00.000Z');
  assert.equal(digested.queryTemplate, 'ANCHOR_LEARNED');
  assert.deepEqual(digested.atoms, metadata.atoms);
  assert.equal('terminologyId' in digested, false);
  assert.equal('terminologyLifecycle' in digested, false);
  assert.equal('terminologyDecayedYield' in digested, false);
  assert.deepEqual(digested.terminologyRevalidation, {
    disposition: 'DIGESTED',
    previousTermId: 153,
    previousTerm: 'DAX',
    previousLifecycle: 'SEARCH_TRIAL',
    previousSearchEligible: false,
    previousDecayedYield: 0.12,
    previousLearnedTerm: null,
    reason: 'TERMINOLOGY_NOT_CURRENTLY_ELIGIBLE',
    revalidatedAt: '2026-11-09T16:00:00.000Z',
  });
});

test('a missing term row is digested without inventing a term identity', () => {
  const digested = digestQueryTerminologyMetadata({ terminologyId: 999, terminologyLifecycle: 'SEARCH_TRIAL', terminologyDecayedYield: 0.2, learnedTerm: 'gone' }, undefined, '2026-11-09T16:00:00.000Z');
  assert.equal('terminologyId' in digested, false);
  assert.equal('terminologyLifecycle' in digested, false);
  assert.equal('terminologyDecayedYield' in digested, false);
  assert.equal('learnedTerm' in digested, false);
  const revalidation = digested.terminologyRevalidation as Record<string, unknown>;
  assert.equal(revalidation.reason, 'TERMINOLOGY_ROW_MISSING');
  assert.equal(revalidation.previousTerm, null);
});
