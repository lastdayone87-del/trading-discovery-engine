import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return /\.tsx?$/.test(entry.name) ? [absolute] : [];
  }));
  return files.flat();
}

function declaredValues(statement: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
    return statement.name ? [statement.name.text] : [];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap(declaration =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
    );
  }
  return [];
}

test('merge resolution leaves exactly one recordAdmissionShadow declaration', async () => {
  const file = path.resolve(import.meta.dirname, 'candidateAdmission/shadowEvaluator.ts');
  const source = await readFile(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declarations = parsed.statements.flatMap(declaredValues);
  assert.equal(declarations.filter(name => name === 'recordAdmissionShadow').length, 1);
});

test('merge resolution introduced no duplicate top-level value declarations', async () => {
  for (const file of await typescriptFiles(path.resolve(import.meta.dirname))) {
    const source = await readFile(file, 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const declarations = parsed.statements.flatMap(declaredValues);
    const duplicates = declarations.filter((name, index) => declarations.indexOf(name) !== index);
    assert.deepEqual([...new Set(duplicates)], [], file);
  }
});
