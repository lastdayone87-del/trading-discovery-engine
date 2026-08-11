import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./reviewStore.ts', import.meta.url), 'utf8');

test('review persistence pins the state parameter to the review_state enum everywhere it is reused', () => {
  assert.match(source, /state=\$2::review_state/);
  assert.match(source, /CASE WHEN \$2::review_state='PENDING'::review_state THEN NULL ELSE now\(\) END/);
  assert.match(source, /CASE WHEN \$2::review_state='PENDING'::review_state THEN now\(\) ELSE pending_since END/);
});

test('review persistence does not reuse an untyped state parameter in enum and text contexts', () => {
  assert.doesNotMatch(source, /state=\$2,review_version/);
  assert.doesNotMatch(source, /CASE WHEN \$2='PENDING'/);
});
