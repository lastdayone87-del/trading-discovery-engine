import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('standalone migration runner exits after successful completion', () => {
  const source = readFileSync(new URL('../scripts/runMigrations.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.exit\(0\)/);
  assert.match(source, /process\.exit\(1\)/);
});

