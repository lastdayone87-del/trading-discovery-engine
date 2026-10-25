import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The analytics implementation lives in dbCore.ts; db.ts is only the public
// re-export facade. Reading the facade made this contract silently vacuous.
const source = fs.readFileSync(path.join(process.cwd(), 'server/dbCore.ts'), 'utf8');

test('creator-size neighborhood analytics casts JSONB path keys to TEXT', () => {
  assert.match(source, /metadata->'size_band_breakdown'->\$1::text->>'attributed_quota'/);
  assert.match(source, /metadata->'size_band_breakdown'->\$1::text->>'quality_new_count'/);
  assert.match(source, /metadata->'size_band_breakdown'->\$1::text\) IS NOT NULL/);
});

test('creator-size query supplies exactly the one parameter it references', () => {
  const branch = source.slice(
    source.indexOf("seg.type === 'CREATOR_SIZE'\n      ? await db.query("),
    source.indexOf(': await db.query(', source.indexOf("seg.type === 'CREATOR_SIZE'\n      ? await db.query(")),
  );
  assert.ok(branch.length > 0, 'creator-size analytics query must remain discoverable');
  // PostgreSQL rejects a parameter with no determinable type: an unreferenced
  // $1 next to a referenced $2 is exactly the production failure.
  assert.match(branch, /\[\s*seg\.key\s*\]/);
  assert.doesNotMatch(branch, /\$2/);
});

test('dimension neighborhood analytics casts both segment parameters to TEXT', () => {
  assert.match(source, /\(\$1::text = 'COUNTRY' AND dn\.country = \$2::text\)/);
  assert.match(source, /\(\$1::text = 'NEIGHBORHOOD' AND dn\.neighborhood_key = \$2::text\)/);
});

test('neighborhood analytics formulas and bounded window remain present', () => {
  assert.match(source, /now\(\) - interval '30 days'/);
  assert.match(source, /INSERT INTO neighborhood_health_diagnostics/);
  assert.match(source, /calculateSegmentHealthFromHistory/);
});
