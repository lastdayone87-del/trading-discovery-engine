import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { nextUtcQuotaReset, QuotaAllocationExhaustedError } from './quotaCapacity';

test('allocation exhaustion carries a next-UTC-reset retry without consuming queue attempts', () => {
  const now = new Date('2026-07-29T23:59:59.000Z');
  assert.equal(nextUtcQuotaReset(now), Date.parse('2026-07-30T00:00:00.000Z'));
  const error = new QuotaAllocationExhaustedError('ENRICHMENT', nextUtcQuotaReset(now));
  assert.equal(error.code, 'QUOTA_ALLOCATION_EXHAUSTED');
  assert.equal(error.retryAt, Date.parse('2026-07-30T00:00:00.000Z'));
});

test('manual session and page-one job are committed transactionally with a stable idempotency key', () => {
  const source = fs.readFileSync(new URL('./manualSearchStore.ts', import.meta.url), 'utf8');
  assert.match(source, /BEGIN[\s\S]*INSERT INTO manual_search_sessions[\s\S]*INSERT INTO jobs[\s\S]*COMMIT/);
  assert.match(source, /manual-page:\$\{args\.id\}:1/);
  assert.match(source, /ON CONFLICT\(idempotency_key\) DO NOTHING/);
});

test('quota reservation admission performs race-safe UTC rollover before reading usage', () => {
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  const reservation = source.slice(source.indexOf('export async function tryReserveQuota'));
  assert.match(reservation, /BEGIN[\s\S]*INSERT INTO quota_tracker[\s\S]*ON CONFLICT\(id\) DO UPDATE[\s\S]*FOR UPDATE/);
  assert.match(reservation, /last_reset<>excluded\.last_reset THEN 0/);
});

test('shared capacity is not stranded behind hard allocation partitions', () => {
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  const reservation = source.slice(source.indexOf('export async function tryReserveQuota'), source.indexOf('export async function finishQuotaReservation'));
  assert.match(reservation, /actual_used \+ row\.reserved_total \+ args\.units > args\.dailyBudget/);
  assert.doesNotMatch(reservation, /allocation_used \+ args\.units/);
});

test('every autonomous page reserves at worker execution rather than producer scheduling', () => {
  const queue = fs.readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  const db = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  assert.match(queue, /if\(queryRunId\)\{[^\n]+tryReserveQuota\(\{operationType:'AUTONOMOUS_QUERY_PAGE'/);
  assert.doesNotMatch(db, /VALUES\('SEARCH_YOUTUBE',\$1,'AUTONOMOUS',100/);
});

test('manual and enrichment allocation capacity uses retryAt while genuine enrichment failures remain terminal', () => {
  const source = fs.readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
  assert.match(source, /throw new QuotaAllocationExhaustedError\('MANUAL'\)/);
  assert.match(source, /throw new QuotaAllocationExhaustedError\('ENRICHMENT'\)/);
  assert.match(source, /throw new QuotaAllocationExhaustedError\('AUTONOMOUS'\)/);
  assert.match(source, /job\.attempts >= job\.max_attempts && !isQuotaCapacityError\(err\)/);
});

test('capacity retryAt returns durable work to pending without spending its retry budget', () => {
  const source = fs.readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
  const failJob = source.slice(source.indexOf('export async function failJob'), source.indexOf('export async function recoverStaleJobs'));
  assert.match(failJob, /providerRetryAt/);
  assert.match(failJob, /status='PENDING'/);
  assert.match(failJob, /attempts=GREATEST\(0,attempts-1\)/);
  assert.match(failJob, /run_after=\$3/);
});
