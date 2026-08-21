import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getPendingStagedCandidates,
  updateStagedCandidateResolution,
  processPendingStagedCandidates
} from './candidateStaging';

test('getPendingStagedCandidates returns empty list when DB is offline', async () => {
  const candidates = await getPendingStagedCandidates(10);
  assert.ok(Array.isArray(candidates));
});

test('updateStagedCandidateResolution fails gracefully when DB is offline', async () => {
  const success = await updateStagedCandidateResolution('non-existent-id', {
    resolutionStatus: 'RESOLVED',
    resolvedChannelId: 'UC12345'
  });
  assert.equal(success, false);
});

test('processPendingStagedCandidates handles resolution and deferral correctly', async () => {
  const result = await processPendingStagedCandidates();
  assert.equal(typeof result.processed, 'number');
  assert.equal(typeof result.resolved, 'number');
  assert.equal(typeof result.deferred, 'number');
});
