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
  assert.match(ui, /aria-label="Refresh queue and evidence"/);
});

test('review console never submits a stale bundle for a newly selected channel',()=>{
  assert.match(ui, /setBundle\(null\);/);
  assert.match(ui, /canSubmitReviewForSelection/);
  assert.match(ui, /loadingBundle/);
  assert.match(ui, /aria-label="Other reason"/);
});

test('review console paginates without reloading on selection and shows creation focus evidence', () => {
  assert.match(ui, /parseReviewQueuePage/);
  assert.match(ui, /selectionAfterQueueLoad/);
  assert.match(ui, /reviewQueuePageState/);
  assert.match(ui, /creatorFocusSummary/);
  assert.match(ui, /refreshConsole/);
  assert.match(ui, /selectedRef/);
  assert.match(ui, /selectedRef\.current === target/);
  assert.match(ui, /if \(!loaded\) return/);
  assert.match(ui, /selectChannel/);
  assert.match(ui, /catalogError/);
  assert.match(ui, /await loadCatalog\(\)/);
  assert.match(ui, /if \(requestId === bundleRequest\.current\) setLoadingBundle\(false\)/);
  assert.match(ui, /bundleRequest\.current \+= 1;\n    setBundle\(null\);/);
  assert.match(ui, /bundleRequest\.current \+= 1/);
  assert.match(ui, /loadBundle\(selected\)/);
  assert.match(ui, /queue\.find\(item => item\.channelId === selected\)/);
  assert.doesNotMatch(ui, /\|\| bundle\?\.review/);
  assert.match(ui, /Previous/);
  assert.match(ui, /Next/);
  assert.match(ui, /creatorFocusSnapshot/);
  assert.match(ui, /creator_focus_distribution/);
  assert.match(ui, /creatorFocus\.lowerConfidenceBound/);
  assert.match(ui, /creatorFocus\.documentCount/);
  assert.match(ui, /creatorFocus\.assertionCount/);
  assert.match(navbar, /operationalSummary \? operationalSummary\.pendingReviews : '…'/);
});
