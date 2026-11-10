import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const navbar = readFileSync(new URL('../src/components/Navbar.tsx', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/components/ClassificationAudit.tsx', import.meta.url), 'utf8');

test('classification audit is reachable from the dashboard and uses authenticated calls', () => {
  assert.match(app, /ClassificationAudit/);
  assert.match(app, /activeTab === 'audit'/);
  assert.match(navbar, /id: 'audit'/);
  assert.match(ui, /apiFetch/);
  assert.match(ui, /classification-audit/);
});

test('audit UI shows raw evidence before the classifier suggestion and records independent labels', () => {
  assert.match(ui, /Raw evidence/);
  assert.match(ui, /Classifier suggestion \(not ground truth\)/);
  assert.match(ui, /TRADING_CONFIRMED/);
  assert.match(ui, /NON_TRADING/);
  assert.match(ui, /UNCERTAIN/);
  assert.match(ui, /Record label/);
});
