import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'server/db.ts'), 'utf8');

test('creator-size neighborhood analytics casts JSONB path keys to TEXT', () => {
  assert.match(source, /metadata->'size_band_breakdown'->\$2::text->>'attributed_quota'/);
  assert.match(source, /metadata->'size_band_breakdown'->\$2::text->>'quality_new_count'/);
  assert.match(source, /metadata->'size_band_breakdown'->\$2::text\) IS NOT NULL/);
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
