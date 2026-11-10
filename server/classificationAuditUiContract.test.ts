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
  assert.match(ui, /cohort hidden until labeled/);
  assert.doesNotMatch(ui, /videos\.slice\(0, 12\)/);
  assert.match(ui, /videos\.map/);
});

test('audit console supports corrections, filters, pagination, history and stale-response guards', () => {
  assert.match(ui, /Audit status filter/);
  assert.match(ui, /LABELED/);
  assert.match(ui, /Previous/);
  assert.match(ui, /Next/);
  assert.match(ui, /\/labels/);
  assert.match(ui, /Label history/);
  assert.match(ui, /Corrections create a new append-only label version/);
  assert.match(ui, /queueRequest/);
  assert.match(ui, /itemRequest/);
  assert.match(ui, /requestId !== queueRequest\.current/);
  assert.match(ui, /requestId !== itemRequest\.current/);
});
