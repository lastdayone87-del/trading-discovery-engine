import fs from 'node:fs';
import ts from 'typescript';

const fileName = 'server/db.ts';
const sourceText = fs.readFileSync(fileName, 'utf8');
const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const exportedNames = new Map();

function record(name, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const locations = exportedNames.get(name) || [];
  locations.push(line);
  exportedNames.set(name, locations);
}

function isExported(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

for (const statement of sourceFile.statements) {
  if (isExported(statement) && statement.name?.text) {
    record(statement.name.text, statement);
  }

  if (isExported(statement) && ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) record(declaration.name.text, declaration);
    }
  }

  if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    for (const element of statement.exportClause.elements) {
      record(element.name.text, element);
    }
  }
}

const duplicates = [...exportedNames.entries()].filter(([, locations]) => locations.length > 1);
if (duplicates.length > 0) {
  for (const [name, locations] of duplicates) {
    console.error(`Duplicate export '${name}' in ${fileName} at lines ${locations.join(', ')}`);
  }
  process.exit(1);
}

console.log(`Verified ${exportedNames.size} unique exports in ${fileName}.`);
