import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const navbar = readFileSync(new URL('../src/components/Navbar.tsx', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/components/ClassificationResolution.tsx', import.meta.url), 'utf8');
const inspection = readFileSync(new URL('../src/components/InspectionModal.tsx', import.meta.url), 'utf8');
const results = readFileSync(new URL('../src/components/ResultsTable.tsx', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const dbCore = readFileSync(new URL('./dbCore.ts', import.meta.url), 'utf8');

test('classification resolution is reachable from the dashboard', () => {
  assert.match(app, /ClassificationResolution/);
  assert.match(app, /activeTab === 'resolution'/);
  assert.match(navbar, /id: 'resolution'/);
  assert.match(navbar, /Classification Resolution/);
});

test('the resolution panel follows routing, enrichment, recovery, review and quota', () => {
  assert.match(ui, /\/api\/classification\/resolution/);
  assert.match(ui, /Due enrichment/);
  assert.match(ui, /Orphan|orphanPending/);
  assert.match(ui, /Generic failures/);
  assert.match(ui, /Eligible without review/);
  assert.match(ui, /Quota protected/);
  assert.match(ui, /capped at/);
  assert.match(ui, /Routes/);
  assert.match(ui, /Alerts/);
});

test('the existing channel views expose route, fallback and semantic attempt details', () => {
  assert.match(inspection, /Classification Route/);
  assert.match(inspection, /routing_fallback_reason/);
  assert.match(inspection, /semantic_attempted/);
  assert.match(results, /classification_route/);
});

test('the resolution endpoint is an explicit operator read route', () => {
  assert.match(server, /app\.get\('\/api\/classification\/resolution', requireReviewer/);
});


test('the resolution panel ignores superseded loads and announces failures', () => {
  assert.match(ui, /requestId\.current/);
  assert.match(ui, /if \(id === requestId\.current\) setData/);
  assert.match(ui, /role="alert"/);
});

test('the channel listing actually selects the route metadata the table renders', () => {
  const listingStart = dbCore.indexOf('export async function listChannelsPage');
  const listing = dbCore.slice(listingStart, dbCore.indexOf('export async function getLegacyCommunityRetryDiagnostics', listingStart));
  assert.match(listing, /trading_relevance_breakdown/);
});

test('the channel table shows semantic and fallback state without hover', () => {
  assert.match(results, /semantic used/);
  assert.match(results, /routing_fallback_reason\.replaceAll/);
});
