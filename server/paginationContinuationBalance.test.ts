import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const queue = readFileSync(new URL('./queueManager.ts', import.meta.url), 'utf8');
const pageStore = readFileSync(new URL('./autonomousPageStore.ts', import.meta.url), 'utf8');
const provider = readFileSync(new URL('./youtubeInnertubeProvider.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('./db/migrations/205_pagination_continuation_balance.sql', import.meta.url), 'utf8');
const arms = readFileSync(new URL('./queryDiscoveryArms.ts', import.meta.url), 'utf8');

test('InnerTube has no provider page cap and real continuation survives the safety ceiling', () => {
  assert.match(provider, /YOUTUBE_INNERTUBE_DEFAULT_MAX_PAGES = 50;/);
  assert.match(provider, /const hasMore = feed\?\.has_continuation === true;/);
  assert.doesNotMatch(provider, /pageNumber < YOUTUBE_INNERTUBE_MAX_PAGES/);
  assert.match(queue, /if \(providerKey === 'youtube-innertube'\) return Number\.MAX_SAFE_INTEGER/);
  assert.match(queue, /providerExhausted: \(providerKey === 'youtube-innertube' \|\| providerKey === 'brave-search'\)/);
  assert.doesNotMatch(queue, /providerExhausted:[\s\S]{0,200}pageNumber >= providerMaxPages/);
});

test('InnerTube deep pages resume from a persisted token instead of a page-1 rewalk', () => {
  assert.match(provider, /YOUTUBE_INNERTUBE_REWALK_SAFE_PAGES = 10;/);
  assert.match(queue, /fallbackState!\.pagesCompleted < YOUTUBE_INNERTUBE_REWALK_SAFE_PAGES/);
  assert.match(provider, /export const INNERTUBE_TOKEN_CURSOR_PREFIX = 'it1\.'/);
  assert.match(provider, /export function encodeInnertubeCursor/);
  assert.match(provider, /export function parseInnertubeCursorState/);
  assert.match(provider, /session\.actions\.execute\('search', \{\s*continuation: continuationToken/);
  assert.match(provider, /pacedTokenContinuation\(session, cursor\.continuationToken, deadlineAtMs\)/);
  assert.match(provider, /nextPageToken: hasMore\s*\? encodeInnertubeCursor\(pageNumber \+ 1, continuationToken\)/);
  assert.match(provider, /innertube_continuation_token_missing/);
  assert.match(provider, /innertubeCursorMode/);
});

test('the approved safety ceiling is aligned to 50 without lowering an operator value above it', () => {
  assert.match(migration, /SET setting_value = '50'/);
  assert.match(migration, /AND setting_value = '10'/);
  assert.match(migration, /query_arm_min_probe_runs/);
  assert.match(migration, /query_arm_min_probe_pages/);
});

test('linked continuation segments reconstruct prior page streaks through ancestry', () => {
  assert.match(pageStore, /WITH RECURSIVE lineage AS/);
  assert.match(pageStore, /parent\.id=NULLIF\(child_run\.continued_from_run_id,''\)::uuid/);
  assert.match(pageStore, /ORDER BY l\.depth ASC, o\.page_number DESC/);
  assert.match(pageStore, /LIMIT 200/);
});

test('provisional low-value stops wait for page admission settlement but hard stops do not', () => {
  assert.match(queue, /const ADMISSION_REVIEW_HARD_STOP_REASONS = new Set\(\[/);
  assert.match(queue, /'PAGE_CEILING'/);
  assert.match(queue, /'RUN_BUDGET_EXHAUSTED'/);
  assert.match(queue, /'PROVIDER_EXHAUSTED'/);
  assert.match(queue, /'NO_NEXT_PAGE'/);
  assert.match(queue, /'DUPLICATE_HEAVY'/);
  assert.match(queue, /const admissionPagePending = Number\(admissionPageOutcomes\?\.pending \|\| 0\) > 0/);
  assert.match(queue, /const admissionReviewEligible = admissionPagePending/);
  assert.match(queue, /deferAutonomousRunForAdmissionReview\(queryRunId, pageNumber/);
  assert.match(pageStore, /markAutonomousPageDeferredForAdmissionReview/);
  assert.match(pageStore, /deferred_reason='ADMISSION'/);
  assert.match(queue, /const recoveryOwnsStatus = !\['COMPLETE', 'FAILED', 'RESUME_UNAVAILABLE', 'DEFERRED_QUOTA', 'DEFERRED_TIME'\]/);
  assert.match(queue, /if \(paginationEnabled && recoveryOwnsStatus && observation\?\.deferredReason === 'ADMISSION'\)/);
  assert.match(queue, /PERSISTED_PAGE_ADMISSION_REVIEW/);
  assert.match(queue, /PERSISTED_PAGE_PROVISIONAL_STOP/);
  assert.match(queue, /observation\.shouldContinue === false/);
});

test('resume re-evaluates a settled provisional page before continuing or finalizing', () => {
  const start = queue.indexOf('if (lastObservation?.deferredReason === \'ADMISSION\')');
  assert.ok(start >= 0, 'resume admission-review branch exists');
  const end = queue.indexOf('if (lastObservation && lastObservation.shouldContinue === false)', start);
  assert.ok(end > start, 'resume branch has a bounded body');
  const body = queue.slice(start, end);
  assert.match(body, /getAutonomousPageMarginalMetrics\(run\.runId, run\.pagesCompleted\)/);
  assert.match(body, /const lowNoveltyStop =/);
  assert.match(body, /!lowNoveltyStop && Number\(settledMarginal\.marginalNewCreators/);
  assert.match(body, /const settledProductive =/);
  assert.match(body, /settleAutonomousPageAdmissionDeferral\(run\.runId, run\.pagesCompleted, true, null, \[\], true\)/);
  assert.match(body, /lastObservation\.stoppingReason \|\| lastObservation\.primaryReason/);
  assert.match(pageStore, /continuation_decision_v2=CASE/);
  assert.match(pageStore, /resetStreaks/);
  assert.match(pageStore, /'streaks',jsonb_build_object/);
});

test('arm cooldown requires enough probe evidence before a two-week lane penalty', () => {
  assert.match(arms, /export function armCooldownEligible/);
  assert.match(arms, /input\.runs >= Math\.max\(1, Math\.trunc\(input\.minRuns\)/);
  assert.match(arms, /input\.pages >= Math\.max\(1, Math\.trunc\(input\.minPages\)/);
  assert.match(arms, /query_arm_min_probe_runs/);
  assert.match(arms, /query_arm_min_probe_pages/);
});
