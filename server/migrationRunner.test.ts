import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

test('standalone migration runner exits after successful completion', () => {
  const source = readFileSync(new URL('../scripts/runMigrations.ts', import.meta.url), 'utf8');
  assert.match(source, /process\.exit\(0\)/);
  assert.match(source, /process\.exit\(1\)/);
});

test('migration versions are unique before the runner checks applied state', () => {
  const files = readdirSync(new URL('./db/migrations/', import.meta.url)).filter(file => file.endsWith('.sql'));
  assert.ok(files.length > 0);
  const seen = new Map<number, string>();
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    assert.ok(Number.isInteger(version) && version > 0, `migration file must start with a version: ${file}`);
    const previous = seen.get(version);
    assert.equal(previous, undefined, `duplicate migration version ${version}: ${previous} and ${file}`);
    seen.set(version, file);
  }
});
