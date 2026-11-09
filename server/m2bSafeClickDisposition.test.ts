import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RENDERED_CONTROL_SELECTOR } from './browserCommunityFallback';

test('M2b adds no new rendered click class and excludes form/download controls', () => {
  const source = readFileSync(new URL('./browserCommunityFallback.ts', import.meta.url), 'utf8');
  assert.match(source, /submitsOrResetsForm/);
  assert.match(source, /downloadsFile/);
  assert.match(source, /effectiveType === 'submit'/);
  assert.match(source, /effectiveType === 'reset'/);
  assert.match(source, /effectiveType === 'image'/);
  assert.match(source, /inputSubmitLike/);
  assert.match(source, /excludedInputType/);
  assert.match(source, /inputSubmitLike\n\s*\|\| \(!!associatedForm/);
  assert.match(source, /element\.hasAttribute\('download'\)/);
  assert.match(source, /if \(submitsOrResetsForm \|\| downloadsFile\)/);

  // M2b must not add form-action/meta/arbitrary-onclick controls to the
  // rendered click set, and must not submit forms programmatically.
  assert.doesNotMatch(source, /formaction/i);
  assert.doesNotMatch(source, /requestSubmit\(/i);
  assert.doesNotMatch(source, /\.submit\(\)/);
  assert.match(RENDERED_CONTROL_SELECTOR, /input\[type="submit"\]/);
  assert.match(RENDERED_CONTROL_SELECTOR, /input\[type="image"\]/);
  assert.match(RENDERED_CONTROL_SELECTOR, /input\[type="reset"\]/);
  assert.doesNotMatch(RENDERED_CONTROL_SELECTOR, /(?:^|,)\s*(?:form|select|textarea|meta)(?:[\s,\[]|$)/i);
});

test('M2b disposition is documented as deferred with a never-click boundary', () => {
  const doc = readFileSync(new URL('../docs/phase-1-m2b-safe-click-disposition.md', import.meta.url), 'utf8');
  assert.match(doc, /Status:\*\* DEFERRED/);
  assert.match(doc, /does not add clicking behavior/i);
  assert.match(doc, /Never-click boundary/i);
  assert.match(doc, /Enforced by this change/i);
  assert.match(doc, /Policy boundary — not newly enforced/i);
  assert.match(doc, /real residual risk/i);
  assert.match(doc, /Submit\/image\/reset inputs are excluded unconditionally/i);
  assert.match(doc, /always skipped and never clicked/i);
  assert.match(doc, /type is\s+`submit` or `reset`/i);
  assert.match(doc, /<input type="submit">/i);
  assert.match(doc, /<input type="image">/i);
  assert.match(doc, /<input type="reset">/i);
  assert.match(doc, /trigger a download/i);
  assert.match(doc, /Revisit conditions/i);
});
