import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, addExcludedCountry, removeExcludedCountry } from './db';
import { lockExclusionPolicyForGuardedWrite, readExcludedCountries } from './countryExclusion';
import { COUNTRY_EXCLUSION_POLICY_LOCK } from './countryExclusionRules';

const databaseUrl = process.env.PHASE10_POSTGRES_URL;

// Real-PostgreSQL proof of the exclusion-policy lock protocol: a guarded
// transaction holds pg_advisory_xact_lock_shared for the whole check-then-write
// span, so an exclusion-list writer (the EXCLUSIVE variant, used by
// addExcludedCountry/removeExcludedCountry) cannot commit between the guarded
// read and the guarded write. Skipped unless a disposable test database is
// provided via PHASE10_POSTGRES_URL.
test('PostgreSQL concurrency: exclusion writers serialize with guarded shared-lock readers', {
  skip: databaseUrl ? false : 'PHASE10_POSTGRES_URL is required for PostgreSQL concurrency coverage'
}, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const country = `ZZ-RACE-${Date.now()}-${process.pid}`;
  const first = await db.connect();
  const second = await db.connect();
  try {
    // 1. A guarded reader takes the shared policy lock inside its transaction.
    await first.query('BEGIN');
    await lockExclusionPolicyForGuardedWrite(first);
    const before = await readExcludedCountries(first);
    assert.equal(before.some(row => row.country_name === country), false);

    // 2. While the guarded transaction runs, the exclusive lock is unavailable:
    //    a policy writer cannot commit an exclusion between check and write.
    await second.query('BEGIN');
    const blocked = await second.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`, [COUNTRY_EXCLUSION_POLICY_LOCK]);
    assert.equal(blocked.rows[0].acquired, false, 'exclusive policy lock must be blocked by an in-flight guarded read');
    await second.query('COMMIT');
    await first.query('COMMIT');

    // 3. The writer path commits the exclusion via the production helper.
    await addExcludedCountry({ country_name: country, reason: 'concurrency probe' });

    // 4. The exclusive lock is free again and a new guarded read observes the
    //    committed exclusion (post-change writes fail closed).
    await second.query('BEGIN');
    const free = await second.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`, [COUNTRY_EXCLUSION_POLICY_LOCK]);
    assert.equal(free.rows[0].acquired, true, 'exclusive lock is available once shared holders committed');
    await second.query('COMMIT');
    await first.query('BEGIN');
    await lockExclusionPolicyForGuardedWrite(first);
    const after = await readExcludedCountries(first);
    assert.ok(after.some(row => row.country_name === country), 'the committed exclusion is visible to guarded readers');
    await first.query('COMMIT');
  } finally {
    await removeExcludedCountry(country).catch(() => undefined);
    first.release();
    second.release();
  }
});
