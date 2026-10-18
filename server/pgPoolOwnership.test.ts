import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { isConnectionPool } from './pgPoolOwnership';

// Pool ownership must be explicit: pg.Client also exposes connect() but is the
// queryable itself, so shape-only detection ("has connect(), no release()")
// misclassifies a standalone client as a pool, making callers check out and
// release a client they do not own.
test('pool ownership: real pools are pools, standalone clients are not', async () => {
  assert.equal(isConnectionPool(new Pool()), true, 'a real pg.Pool owns connections');
  const runtimePg = (await import('pg')) as any;
  const RuntimeClient = runtimePg.Client ?? runtimePg.default?.Client;
  assert.equal(typeof RuntimeClient, 'function', 'the pg runtime must expose Client');
  assert.equal(isConnectionPool(new RuntimeClient()), false, 'a standalone pg.Client is itself the queryable');
});

test('pool ownership: doubles and checked-out clients are classified by ownership', () => {
  assert.equal(isConnectionPool({ connect: async () => ({}) }), true, 'connect-only doubles stand in for pools');
  assert.equal(isConnectionPool({ query: async () => ({ rows: [] }) }), false, 'query-only runners are reused directly');
  assert.equal(isConnectionPool({ connect: async () => ({}), query: async () => ({ rows: [] }) }), false, 'client-shaped doubles (connect + query) are reused directly');
  assert.equal(isConnectionPool({ connect: async () => ({}), query: async () => ({ rows: [] }), release: () => undefined }), false, 'a checked-out PoolClient keeps the caller transaction');
  assert.equal(isConnectionPool(null), false);
  assert.equal(isConnectionPool(undefined), false);
});
