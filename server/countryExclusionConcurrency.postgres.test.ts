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
// read and the guarded write. The production writer is started while the
// shared lock is held and must not settle until the guarded transaction
// commits - a raw try-lock probe cannot prove that. Skipped unless a
// disposable test database is provided via PHASE10_POSTGRES_URL.
test('PostgreSQL concurrency: exclusion writers serialize with guarded shared-lock readers', {
  skip: databaseUrl ? false : 'PHASE10_POSTGRES_URL is required for PostgreSQL concurrency coverage'
}, async () => {
  process.env.DATABASE_URL = databaseUrl!;
  process.env.PGSSL = 'disable';
  const db = await getDb();
  const country = `ZZ-RACE-${Date.now()}-${process.pid}`;
  const first = await db.connect();
  const second = await db.connect();
  let writer: Promise<void> | null = null;
  try {
    // 1. A guarded reader takes the shared policy lock inside its transaction.
    await first.query('BEGIN');
    await lockExclusionPolicyForGuardedWrite(first);
    const before = await readExcludedCountries(first);
    assert.equal(before.some(row => row.country_name === country), false);

    // 2. While the guarded transaction holds the shared lock, start the real
    //    writer path (`addExcludedCountry`, which takes the EXCLUSIVE variant).
    //    It must stay blocked until the guarded transaction commits. A raw
    //    try-lock probe cannot prove this: the probe would still report
    //    contention even if the writer path dropped its exclusive lock
    //    entirely, because the holder is the guarded transaction.
    writer = addExcludedCountry({ country_name: country, reason: 'concurrency probe' });
    const settled = writer.then(() => true, () => true);
    const settledEarly = await Promise.race([
      settled,
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250))
    ]);
    assert.equal(settledEarly, false, 'the policy writer must block on the shared lock held by the guarded transaction');
    const midFlight = await readExcludedCountries(first);
    assert.equal(midFlight.some(row => row.country_name === country), false, 'no exclusion may commit between the guarded check and the guarded write');

    // 3. Committing the guarded transaction releases the shared lock: the
    //    writer acquires the exclusive lock, commits, and the exclusion exists.
    await first.query('COMMIT');
    await writer;
    writer = null;

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
    // Release both transactions before cleanup: the removal helper needs the
    // EXCLUSIVE policy lock, so a shared holder left open by a failed
    // assertion would deadlock the cleanup and hide the original failure.
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    first.release();
    second.release();
    if (writer) await writer.catch(() => undefined);
    await removeExcludedCountry(country).catch(() => undefined);
  }
});
