import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const db = fs.readFileSync(path.join(root, 'server/dbCore.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
const start = db.indexOf('export async function getLegacyCommunityRetryDiagnostics');
const end = db.indexOf('export async function getChannelListingRevision', start);
const diagnostic = db.slice(start, end);

test('legacy reconciliation diagnostic is protected, read-only, and aggregate-only', () => {
  assert.match(diagnostic, /export async function getLegacyCommunityRetryDiagnostics/);
  assert.match(server, /app\.get\('\/api\/reconciliation\/legacy-community-retries'/);
  assert.match(diagnostic, /COUNT\(\*\)::int AS count/);
  assert.doesNotMatch(diagnostic, /SELECT j\.id,j\.payload/);
  assert.doesNotMatch(diagnostic, /reconciliationHistory/);
  assert.match(diagnostic, /CASE\s+WHEN NULLIF\(btrim\(j\.payload->>'retryLifecycleVersion'/);
  assert.match(diagnostic, /WHEN btrim\(j\.payload->>'retryLifecycleVersion'\) ~ '\^\[0-9\]\+\$'/);
  assert.doesNotMatch(diagnostic, /\(j\.payload->>'retryLifecycleVersion'\)::int/);
  assert.doesNotMatch(diagnostic, /o\.surface/);
  assert.match(diagnostic, /o\.provenance->>'surface' AS surface/);
  assert.match(diagnostic, /WHEN 'INSPECTION' THEN 'INSPECTION'/);
  assert.match(diagnostic, /WHEN 'RECOVERY' THEN 'RECOVERY'/);
  assert.match(diagnostic, /WHEN 'LEGACY' THEN 'LEGACY'/);
  assert.match(diagnostic, /current_owner_class/);
});

test('legacy diagnostic cutoff is validated before database access', () => {
  const source = diagnostic;
  assert.match(source, /new Date\(legacyBefore\)/);
  assert.match(source, /INVALID_LEGACY_CUTOFF/);
  assert.match(source, /\$1::timestamptz/);
});
