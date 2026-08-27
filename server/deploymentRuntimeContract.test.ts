import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const railwayConfig = readFileSync(new URL('../railway.json', import.meta.url), 'utf8');

test('production runtime starts the app directly instead of blocking on a pre-start migration shell', () => {
  assert.match(dockerfile, /CMD \["npm", "run", "start"\]/);
  assert.doesNotMatch(dockerfile, /npm run migrate && npm run start/);
  assert.match(railwayConfig, /"builder": "DOCKERFILE"/);
  assert.match(railwayConfig, /"dockerfilePath": "Dockerfile"/);
  assert.match(railwayConfig, /"startCommand": "npm run start"/);
  assert.doesNotMatch(railwayConfig, /npm run migrate && npm run start/);
});

