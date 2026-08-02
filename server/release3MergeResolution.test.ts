import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const count = (source: string, value: string) => source.split(value).length - 1;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
      return sourceFiles(absolute);
    }
    return /\.(ts|tsx|sql)$/.test(entry.name) ? [absolute] : [];
  }));
  return nested.flat();
}

test('Release 3 merge contains no unresolved conflict markers', async () => {
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/m, file);
  }
});

test('classification diagnostics combines nomination lineage and evidence observation once', async () => {
  const source = await readFile(path.join(root, 'server/classificationDiagnostics.ts'), 'utf8');
  assert.equal(count(source, "import { persistClassificationEvidenceBundle }"), 1);
  assert.equal(count(source, 'INSERT INTO production_classification_diagnostics'), 1);
  assert.equal(count(source, 'nomination_id'), 1);
  assert.equal(count(source, 'persistClassificationEvidenceBundle('), 1);
  assert.match(source, /VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12\)/);
});

test('Release 1-3 routes and evidence exports are registered exactly once', async () => {
  const [server, index] = await Promise.all([
    readFile(path.join(root, 'server.ts'), 'utf8'),
    readFile(path.join(root, 'server/evidenceEngine/index.ts'), 'utf8')
  ]);
  for (const route of [
    '/api/discovery-nominations', '/api/admission/decisions', '/api/evidence-documents',
    '/api/creator-focus/shadow', '/api/investigations/gap-plans'
  ]) assert.equal(count(server, `'${route}'`), 1, route);
  for (const module of [
    './documentTypes', './documentProjection', './hypothesisTaxonomy',
    './documentSemanticProvider', './creatorFocusAggregation', './classifierV4'
  ]) assert.equal(count(index, `export * from '${module}'`), 1, module);
});
