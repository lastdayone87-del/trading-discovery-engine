import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('rate-pressure diagnostics remain redacted and do not change the pacing ceiling',()=>{
  const source=fs.readFileSync(new URL('./youtubeRequestScheduler.ts',import.meta.url),'utf8');
  assert.match(source,/runtime-rate-pressure-diagnostic/);
  assert.match(source,/providerFingerprint/);
  assert.match(source,/recent-429s-/);
  assert.match(source,/affected-providers=/);
  assert.match(source,/actual-spacing-ms=/);
  assert.match(source,/YOUTUBE_MAX_ADAPTIVE_REQUEST_INTERVAL_MS/);
  assert.match(source,/5_000/);
  assert.doesNotMatch(source,/slice\(-4\)/);
});
