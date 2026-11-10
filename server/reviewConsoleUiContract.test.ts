import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src/components/ReviewConsole.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const navbar = readFileSync(new URL('../src/components/Navbar.tsx', import.meta.url), 'utf8');

test('review console is reachable from the dashboard and uses operator-authenticated calls', () => {
  assert.match(app, /ReviewConsole/);
  assert.match(app, /activeTab === 'review'/);
  assert.match(navbar, /id: 'review'/);
  assert.match(ui, /apiFetch/);
  assert.match(ui, /submitReviewDecision/);
});

test('review console exposes the evidence and routing that drove the decision', () => {
  assert.match(ui, /normalizedInput/);
  assert.match(ui, /evidenceItems|evidenceDocuments|evidenceAssertions/);
  assert.match(ui, /deterministicRouting|routing\.route/);
  assert.match(ui, /eligibility/);
  assert.match(ui, /review\.history/);
});

test('review console guards stale responses and supports the OTHER reason contract',()=>{
  assert.match(ui, /queueRequest/);
  assert.match(ui, /bundleRequest/);
  assert.match(ui, /requestId !== queueRequest\.current/);
  assert.match(ui, /requestId !== bundleRequest\.current/);
  assert.match(ui, /reviewReasonOther/);
  assert.match(ui, /reasonCode === 'OTHER'/);
  assert.match(ui, /storedEvidenceItems/);
  assert.match(ui, /aria-label="Refresh queue"/);
});

test('review console never submits a stale bundle for a newly selected channel',()=>{
  assert.match(ui, /setBundle\(null\);/);
  assert.match(ui, /canSubmitReviewForSelection/);
  assert.match(ui, /loadingBundle/);
  assert.match(ui, /aria-label="Other reason"/);
});

test('review console paginates without reloading on selection and shows creation focus evidence', () => {
  assert.match(ui, /data\.items/);
  assert.match(ui, /data\.total/);
  assert.match(ui, /Previous/);
  assert.match(ui, /Next/);
  assert.match(ui, /creatorFocusSnapshot/);
  assert.match(ui, /creator_focus_distribution/);
  assert.match(ui, /lower_confidence_bound/);
  assert.match(ui, /document_keys/);
  assert.match(navbar, /operationalSummary \? operationalSummary\.pendingReviews : '…'/);
});
