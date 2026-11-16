import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextSeedSweepState,
  parseSeedRetryEntries,
  parseSelectedCountries,
} from './relationshipCanarySeeds';

test('relationship seed selection rejects malformed or non-string settings', () => {
  assert.deepEqual(parseSelectedCountries('["Ireland","New Zealand"]'), ['Ireland', 'New Zealand']);
  assert.throws(() => parseSelectedCountries('{'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.throws(() => parseSelectedCountries('{"country":"Ireland"}'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.throws(() => parseSelectedCountries('["Ireland",42]'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.throws(() => parseSelectedCountries('["Ireland",{"country":"France"}]'), /DISCOVERY_SCOPE_SELECTION_MALFORMED/);
  assert.deepEqual(parseSelectedCountries('["Ireland","ireland"]'), ['Ireland']);
  assert.deepEqual(parseSelectedCountries('["Not A Country"]'), []);
  // Known inference countries outside the supported production registry must
  // not become seed-sweep targets.
  assert.deepEqual(parseSelectedCountries('["South Korea"]'), []);
  assert.deepEqual(parseSelectedCountries('["Brazil","India"]'), []);
});

test('seed retry ledger is strict, supported-country scoped, and deduplicated', () => {
  assert.deepEqual(parseSeedRetryEntries('[]'), []);
  assert.deepEqual(parseSeedRetryEntries('[{"country":"Ireland","attempts":1},{"country":"ireland","attempts":2}]'), [
    { country: 'Ireland', attempts: 2 },
  ]);
  assert.deepEqual(parseSeedRetryEntries('[{"country":"South Korea","attempts":1}]'), []);
  assert.throws(() => parseSeedRetryEntries('{'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
  assert.throws(() => parseSeedRetryEntries('{}'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
  assert.throws(() => parseSeedRetryEntries('[{"country":42}]'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
  assert.throws(() => parseSeedRetryEntries('[{"country":"Ireland"}]'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
  assert.throws(() => parseSeedRetryEntries('[{"country":"Ireland","attempts":0}]'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
  assert.throws(() => parseSeedRetryEntries('[{"country":"Ireland","attempts":-1}]'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
  assert.throws(() => parseSeedRetryEntries('[{"country":"Ireland","attempts":1.5}]'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
  assert.throws(() => parseSeedRetryEntries('[{"country":"Ireland","attempts":"1"}]'), /RELATIONSHIP_SEED_RETRY_MALFORMED/);
});

test('a failed rotation country is retried without holding the cursor', () => {
  assert.deepEqual(nextSeedSweepState({
    currentRetry: [],
    rotationCountries: ['Ireland', 'New Zealand'],
    outcomes: [
      { country: 'Ireland', status: 'COMPLETED' },
      { country: 'New Zealand', status: 'FAILED' },
    ],
  }), {
    // The whole rotation window advances; New Zealand is carried as a retry
    // instead of being skipped or pinning the cursor.
    cursorAdvance: 2,
    retry: [{ country: 'New Zealand', attempts: 1 }],
  });
});

test('retry windows retry failures before new rotation and drop after three attempts', () => {
  assert.deepEqual(nextSeedSweepState({
    currentRetry: [{ country: 'Ireland', attempts: 1 }],
    rotationCountries: [],
    outcomes: [{ country: 'Ireland', status: 'FAILED' }],
  }), {
    cursorAdvance: 0,
    retry: [{ country: 'Ireland', attempts: 2 }],
  });

  assert.deepEqual(nextSeedSweepState({
    currentRetry: [{ country: 'Ireland', attempts: 2 }],
    rotationCountries: [],
    outcomes: [{ country: 'Ireland', status: 'FAILED' }],
  }), {
    cursorAdvance: 0,
    retry: [],
  });
});

test('a successful retry clears the ledger and unprocessed retries are preserved', () => {
  assert.deepEqual(nextSeedSweepState({
    currentRetry: [{ country: 'Ireland', attempts: 1 }],
    rotationCountries: [],
    outcomes: [{ country: 'Ireland', status: 'COMPLETED' }],
  }), {
    cursorAdvance: 0,
    retry: [],
  });

  assert.deepEqual(nextSeedSweepState({
    currentRetry: [
      { country: 'Ireland', attempts: 1 },
      { country: 'New Zealand', attempts: 2 },
    ],
    rotationCountries: [],
    outcomes: [{ country: 'Ireland', status: 'COMPLETED' }],
  }), {
    cursorAdvance: 0,
    retry: [{ country: 'New Zealand', attempts: 2 }],
  });
});
