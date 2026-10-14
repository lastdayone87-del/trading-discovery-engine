/**
 * Regression tests for the staging-target guard (Sourcery review 5510815007).
 *
 * Pure unit tests — no database required. Run explicitly:
 *   npx tsx --test scripts/stagingTargetGuard.test.ts
 * This file runs in the normal automated workflow (`npm test` covers
 * scripts/ alongside server/ and tests/).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStagingIdentity,
  decodedQuery,
  hasHostOverrideParam,
  isLoopbackAddress,
  isLoopbackHost,
  parseTargetHost,
  pinLoopbackTarget,
  sslModeParam,
  sslModeParams,
  sslRootCertParams,
  tlsPoolConfig,
  verifyStagingTarget,
} from './stagingTargetGuard';

test('unlisted hosts are refused even with valid TLS parameters', () => {
  // A cloned database reached through a non-allowlisted host must fail even
  // when every other check would pass: identity comes from explicit listing,
  // never from in-database state alone.
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: undefined }, () => {
    const verdict = verifyStagingTarget('postgresql://u:p@10.0.1.8:5432/db?sslmode=require');
    assert.equal(verdict.ok, false);
  });
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'db-staging.internal, 10.0.1.8' }, () => {
    const verdict = verifyStagingTarget('postgresql://u:p@10.0.1.8:5432/db?sslmode=require');
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.ssl, { rejectUnauthorized: true });
  });
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('hostname parsing strips IPv6 brackets and fails closed on garbage', () => {
  assert.equal(parseTargetHost('postgresql://[::1]:5432/db'), '::1');
  assert.equal(parseTargetHost('postgresql://127.0.0.1:55433/postgres'), '127.0.0.1');
  assert.equal(parseTargetHost('postgresql:///dbname?host=remote'), '');
  assert.equal(parseTargetHost('not a url at all'), '');
});

test('loopback classification covers localhost, IPv4 and normalized IPv6', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), false);
  assert.equal(isLoopbackHost('10.0.1.8'), false);
  assert.equal(isLoopbackHost(''), false);
});

test('percent-encoded host parameters are decoded and rejected', () => {
  // pg-connection-string decodes parameter names: ?%68ost= is honored as
  // ?host= (verified empirically), so the guard must decode before checking.
  assert.equal(hasHostOverrideParam('postgresql:///db?%68ost=evil.example'), true);
  // Empty-authority rejection alone would also pass here, so assert the
  // valid-authority case: the verdict must refuse on the decoded parameter.
  // (Allowlisted: without it the default loopback-only list refuses first and
  // the parameter check is never exercised.)
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'dbhost' }, () => {
    assert.equal(verifyStagingTarget('postgresql://dbhost/db?%68ost=evil.example').ok, false);
    assert.equal(verifyStagingTarget('postgresql://dbhost/db?host=evil.example').ok, false);
  });
});

test('percent-encoded TLS downgrades are decoded and rejected', () => {
  // ?%73slmode=disable parses to ssl=false (verified empirically).
  assert.deepEqual(sslModeParams('postgresql://10.0.1.8/db?%73slmode=disable'), ['disable']);
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: '10.0.1.8' }, () => {
    assert.equal(verifyStagingTarget('postgresql://10.0.1.8/db?%73slmode=disable').ok, false);
  });
});

test('malformed percent-encoding fails closed', () => {
  assert.equal(decodedQuery('postgresql://h/db?%zz'), null);
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'h' }, () => {
    assert.equal(verifyStagingTarget('postgresql://h/db?%zz').ok, false);
  });
});

test('duplicate parameters resolve safely: host refused, conflicting sslmode refused', () => {
  // pg applies the LAST duplicate; conflicting values are refused instead of
  // guessing. Identical repeats are harmless.
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'h,a.example,b.example' }, () => {
    assert.equal(verifyStagingTarget('postgresql://h/db?host=a.example&host=b.example').ok, false);
    assert.equal(verifyStagingTarget('postgresql://h/db?sslmode=require&sslmode=disable').ok, false);
    assert.equal(verifyStagingTarget('postgresql://h/db?sslmode=disable&sslmode=require').ok, false);
  });
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'dbhost,h,10.0.1.8' }, () => {
    assert.equal(verifyStagingTarget('postgresql://h/db?sslmode=require&sslmode=require').ok, true);
  });
});

test('host override parameters are detected case-insensitively', () => {
  assert.equal(hasHostOverrideParam('postgresql:///db?host=evil'), true);
  assert.equal(hasHostOverrideParam('postgresql://h/db?x=1&HOST=evil'), true);
  assert.equal(hasHostOverrideParam('postgresql://h/db?sslmode=require'), false);
  assert.equal(hasHostOverrideParam('postgresql://h/db'), false);
});

test('sslmode extraction is case-insensitive and null when absent', () => {
  assert.equal(sslModeParam('postgresql://h/db?sslmode=require'), 'require');
  assert.equal(sslModeParam('postgresql://h/db?x=1&sslMode=Disable'), 'disable');
  assert.equal(sslModeParam('postgresql://h/db'), null);
});

test('empty authority hostname is refused (no implicit host fallback)', () => {
  const verdict = verifyStagingTarget('postgresql:///dbname');
  assert.equal(verdict.ok, false);
});

test('explicit host query parameter is refused', () => {
  const verdict = verifyStagingTarget('postgresql:///dbname?host=10.0.1.8');
  assert.equal(verdict.ok, false);
  // Non-empty authority: refusal must come from the parameter check itself,
  // not from the empty-authority rule.
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'dbhost' }, () => {
    assert.equal(verifyStagingTarget('postgresql://dbhost/db?host=10.0.1.8').ok, false);
  });
});

test('silent non-loopback target is upgraded to verified TLS, never plaintext', () => {
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'dbhost,h,10.0.1.8' }, () => {
    const verdict = verifyStagingTarget('postgresql://u:p@10.0.1.8:5432/db');
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.ssl, { rejectUnauthorized: true });
  });
});

test('PGSSL=disable never disables TLS for a remote target', () => {
  // No sslmode in the URL: the verdict must upgrade the silent remote target
  // to verified TLS on its own — PGSSL=disable applies to loopback only.
  withEnv({ PGSSL: 'disable', NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'dbhost,h,10.0.1.8' }, () => {
    const verdict = verifyStagingTarget('postgresql://u:p@10.0.1.8:5432/db');
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.ssl, { rejectUnauthorized: true });
  });
});

test('downgradable sslmodes are refused on remote targets', () => {
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'dbhost,h,10.0.1.8' }, () => {
    for (const mode of ['disable', 'allow', 'prefer']) {
      const verdict = verifyStagingTarget(`postgresql://u:p@10.0.1.8:5432/db?sslmode=${mode}`);
      assert.equal(verdict.ok, false, mode);
    }
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      const verdict = verifyStagingTarget(`postgresql://u:p@10.0.1.8:5432/db?sslmode=${mode}`);
      assert.equal(verdict.ok, true, mode);
      assert.deepEqual(verdict.ssl, { rejectUnauthorized: true });
    }
  });
});

test('loopback honors an explicit TLS request instead of PGSSL plaintext', () => {
  withEnv({ PGSSL: 'disable', NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: undefined }, () => {
    const verdict = verifyStagingTarget('postgresql://postgres:x@127.0.0.1:55433/postgres?sslmode=require');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.loopback, true);
    assert.deepEqual(verdict.ssl, { rejectUnauthorized: true });
  });
});

test('client-certificate parameters are refused, plain and encoded', () => {
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: undefined }, () => {
    assert.equal(verifyStagingTarget('postgresql://postgres:x@127.0.0.1:5432/db?sslcert=/c.pem&sslkey=/k.pem').ok, false);
    assert.equal(verifyStagingTarget('postgresql://postgres:x@127.0.0.1:5432/db?%73slcert=/c.pem').ok, false);
    assert.equal(verifyStagingTarget('postgresql://postgres:x@127.0.0.1:5432/db?%73slkey=/k.pem').ok, false);
  });
});

test('custom CA files are carried for explicit loading, conflicts refused', () => {
  assert.deepEqual(sslRootCertParams('postgresql://h/db?sslrootcert=/ca.pem'), ['/ca.pem']);
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: 'h' }, () => {
    const verdict = verifyStagingTarget('postgresql://u:p@h/db?sslmode=verify-full&sslrootcert=/ca.pem');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.caFile, '/ca.pem');
    assert.deepEqual(tlsPoolConfig(verdict, () => 'CA-CONTENTS'), { rejectUnauthorized: true, ca: 'CA-CONTENTS' });
    assert.throws(() => tlsPoolConfig(verdict, () => { throw new Error('unreadable'); }), /unreadable/);
    const conflicted = verifyStagingTarget('postgresql://u:p@h/db?sslmode=require&sslrootcert=/a.pem&sslrootcert=/b.pem');
    assert.equal(conflicted.ok, false);
    const contradictory = verifyStagingTarget('postgresql://postgres:x@127.0.0.1:5432/db?sslrootcert=/ca.pem');
    assert.equal(contradictory.ok, false);
  });
});

test('tlsPoolConfig passes through loopback and verified settings', () => {
  assert.equal(tlsPoolConfig({ ssl: false }), false);
  assert.equal(tlsPoolConfig({ ssl: undefined }), undefined);
  assert.deepEqual(tlsPoolConfig({ ssl: { rejectUnauthorized: true } }), { rejectUnauthorized: true });
});

test('loopback in production mode without TLS request is refused', () => {
  withEnv({ PGSSL: undefined, NODE_ENV: 'production', STAGING_TARGET_ALLOWLIST: undefined }, () => {
    const verdict = verifyStagingTarget('postgresql://postgres:x@127.0.0.1:55433/postgres');
    assert.equal(verdict.ok, false);
    const requested = verifyStagingTarget('postgresql://postgres:x@127.0.0.1:55433/postgres?sslmode=require');
    assert.equal(requested.ok, true);
    assert.deepEqual(requested.ssl, { rejectUnauthorized: true });
  });
});

test('loopback keeps application TLS semantics, including PGSSL=disable', () => {
  // Default allowlist already covers loopback; explicit listing unnecessary.
  withEnv({ PGSSL: 'disable', NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: undefined }, () => {
    const verdict = verifyStagingTarget('postgresql://postgres:x@127.0.0.1:55433/postgres');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.loopback, true);
    assert.equal(verdict.ssl, false);
  });
  withEnv({ PGSSL: undefined, NODE_ENV: undefined, STAGING_TARGET_ALLOWLIST: undefined }, () => {
    const verdict = verifyStagingTarget('postgresql://postgres:x@[::1]:5432/postgres');
    assert.equal(verdict.ok, true);
    assert.equal(verdict.loopback, true);
    assert.equal(verdict.ssl, undefined);
  });
});

test('loopback hostnames pin to verified loopback IPs', async () => {
  const pinned = await pinLoopbackTarget('postgresql://postgres:x@localhost:55433/postgres', async () => ['127.0.0.1']);
  assert.equal(pinned.address, '127.0.0.1');
  assert.ok(pinned.connectionString.includes('127.0.0.1'));
  // Poisoned resolver: one non-loopback address refuses the target.
  await assert.rejects(
    pinLoopbackTarget('postgresql://postgres:x@localhost:55433/postgres', async () => ['127.0.0.1', '10.0.1.8']),
    /non-loopback/
  );
  await assert.rejects(
    pinLoopbackTarget('postgresql://postgres:x@localhost:55433/postgres', async () => { throw new Error('no DNS'); }),
    /DNS resolution failed/
  );
});

test('loopback address classification is strict', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('10.0.1.8'), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), false);
});

test('work-pool identity re-check detects endpoint changes', async () => {
  const expected = { token: 'tok', serverAddr: '10.0.1.8', dbName: 'postgres' };
  const goodDb = {
    query: async () => ({ rows: [{ token: 'tok', addr: '10.0.1.8', db: 'postgres' }] }),
  };
  await assertStagingIdentity(goodDb, expected);
  const badToken = {
    query: async () => ({ rows: [{ token: 'other', addr: '10.0.1.8', db: 'postgres' }] }),
  };
  await assert.rejects(assertStagingIdentity(badToken, expected), /token mismatch/);
  const movedHost = {
    query: async () => ({ rows: [{ token: 'tok', addr: '10.0.1.9', db: 'postgres' }] }),
  };
  await assert.rejects(assertStagingIdentity(movedHost, expected), /server address changed/);
  const movedDb = {
    query: async () => ({ rows: [{ token: 'tok', addr: '10.0.1.8', db: 'prod' }] }),
  };
  await assert.rejects(assertStagingIdentity(movedDb, expected), /database changed/);
});
