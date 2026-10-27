/**
 * P1 rendered-interaction coverage regressions (report section 3.4).
 *
 * Confirmed defect: a rendered run that failed to click (or skipped by the
 * control budget) an evidence-bearing control — e.g. a "Join Discord" toggle,
 * tab, or accordion — could still resolve as a clean "no community found".
 * An invite can live behind the unexecuted click, so the run must stay
 * incomplete and retryable.
 *
 * Covered here: rendered completion state (interactionGap forces incomplete),
 * cached-coverage sufficiency (gap never counts as rendered coverage), and the
 * outcome classifier source contracts that keep FOUND/CLEAN results from
 * absorbing the gap.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planRevealedRenderedClickTargets, partitionRenderedClickTargets, remainingRenderedClickBudget, resolveRenderedCompletionState, runRenderedClickLoop } from './browserCommunityFallback';
import { isSufficientRenderedCoverage } from './siteInspectionCache';
import { FOUND_GAP_RETRYABLE_FAILURE_CLASSES } from './communityRetryPolicy';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const zeroTelemetry = () => ({
  requestsStarted: 1,
  requestsFinished: 1,
  requestsFailed: 0,
  navigationTimeouts: 0,
  blockedRequests: 0,
  rateLimitedRequests: 0,
  transientRequests: 0,
  unresolvedFailedRequests: 0,
  hostBackoffsApplied: 0,
  clicksStarted: 1,
  clicksSucceeded: 0,
  clicksFailed: 1,
  clickFailureClasses: { BLOCKED: 0, RATE_LIMITED: 0, TRANSIENT: 0, OTHER: 1 },
  lastLifecycleStage: 'PAGE_PROCESSED' as const,
});

const renderedButton = (index: number, marker: string) => ({
  index,
  marker,
  text: 'Join Discord',
  href: null,
  tag: 'button' as const,
});

test('an evidence-bearing interaction gap keeps a processed run incomplete and retryable', () => {
  const gapped = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: zeroTelemetry(),
    interactionGap: true,
  });
  assert.equal(gapped.complete, false, 'interaction gap is not complete coverage');
  assert.equal(gapped.retryable, true);

  const clean = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: zeroTelemetry(),
    interactionGap: false,
  });
  assert.equal(clean.complete, true, 'without a gap the processed run still resolves clean');
  assert.equal(clean.retryable, false);
});

test('the evaluation window rotates over the full matched-control pool so control 65 is reachable', () => {
  const controls = Array.from({ length: 70 }, (_, index) => renderedButton(index, `oc-${index + 1}`));
  const firstWindow = partitionRenderedClickTargets(controls, 'https://creator.example/', 4, 0);
  assert.equal(firstWindow.evaluationWindow.length, 64);
  assert.deepEqual(firstWindow.toClick.map(target => target.marker), ['oc-1', 'oc-2', 'oc-3', 'oc-4']);

  const rotatedWindow = partitionRenderedClickTargets(controls, 'https://creator.example/', 4, 64);
  assert.equal(rotatedWindow.evaluationWindow.length, 64);
  assert.deepEqual(
    rotatedWindow.toClick.map(target => target.marker),
    ['oc-65', 'oc-66', 'oc-67', 'oc-68'],
    'the durable retry offset reaches controls beyond the first 64',
  );

  // 64-control regression: a full window still wraps to the first control and
  // never invents a 65th target.
  const sixtyFour = controls.slice(0, 64);
  const wrapped = partitionRenderedClickTargets(sixtyFour, 'https://creator.example/', 4, 64);
  assert.equal(wrapped.evaluationWindow.length, 64);
  assert.deepEqual(wrapped.toClick.map(target => target.marker), ['oc-1', 'oc-2', 'oc-3', 'oc-4']);
});

test('revealed controls reserve the click slots for already-queued controls', () => {
  // Three controls are queued under a four-click cap. After the first click,
  // two original controls are still waiting, so only one slot remains for the
  // two controls that click revealed; the second must be counted as skipped.
  assert.equal(remainingRenderedClickBudget(4, 1, 2), 1);
  const revealed = [
    { index: 3, marker: 'oc-revealed-3', text: 'Join Discord', href: null, tag: 'button' as const },
    { index: 4, marker: 'oc-revealed-4', text: 'Open community', href: null, tag: 'button' as const },
  ];
  const plan = planRevealedRenderedClickTargets(revealed, 'https://creator.example/', 4, 1, 2);
  assert.equal(plan.remainingClickBudget, 1);
  assert.deepEqual(plan.toClick.map(target => target.marker), ['oc-revealed-3']);
  assert.deepEqual(plan.skipped.map(target => target.marker), ['oc-revealed-4'], 'the over-budget disclosure is a coverage gap, not silently queued');
  assert.equal(remainingRenderedClickBudget(4, 0, 0), 4);
  assert.equal(remainingRenderedClickBudget(4, 2, 5), 0);
});

test('controls revealed by the final permitted click are counted as skipped', () => {
  // The fourth click consumes the cap and has no slot for a disclosed control,
  // but its disclosure still has to become an interaction-gap obligation.
  assert.equal(remainingRenderedClickBudget(4, 4, 0), 0);
  const revealed = [
    { index: 5, marker: 'oc-final-button', text: 'Join Discord', href: null, tag: 'button' as const },
    { index: 6, marker: 'oc-final-anchor', text: 'Community', href: '/community', tag: 'anchor' as const },
  ];
  const plan = planRevealedRenderedClickTargets(revealed, 'https://creator.example/', 4, 4, 0);
  assert.deepEqual(plan.toClick, [], 'no click slot remains after the final permitted click');
  assert.deepEqual(plan.skipped.map(target => target.marker), ['oc-final-button'], 'click-only disclosure is a coverage gap');
  // The navigable anchor remains enqueue-handled, not a click skip.
  assert.equal(plan.skipped.some(target => target.marker === 'oc-final-anchor'), false);
});

test('executing click loop reserves queued slots when a click reveals too many controls', async () => {
  const initial = [
    renderedButton(0, 'oc-initial-0'),
    renderedButton(1, 'oc-initial-1'),
    renderedButton(2, 'oc-initial-2'),
  ];
  const revealed = [
    renderedButton(3, 'oc-revealed-3'),
    renderedButton(4, 'oc-revealed-4'),
  ];
  let clicks = 0;
  let enumerations = 0;
  const result = await runRenderedClickLoop({
    targets: initial,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { clicks++; return true; },
    enumerate: async () => {
      enumerations++;
      const controls = [...initial, ...revealed];
      return { controls, total: controls.length };
    },
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(clicks, 4, 'the loop uses the full four-click cap');
  assert.equal(enumerations, 4, 're-enumeration runs after every click');
  assert.equal(result.evidenceControlsClicked, 4);
  assert.equal(result.evidenceControlsSkipped, 1, 'one revealed control exceeded the reserved budget');
  assert.equal(result.interactionGap, true, 'the unexamined control keeps the page incomplete');
});

test('executing click loop marks a control revealed by the final permitted click as skipped', async () => {
  const initial = [0, 1, 2, 3].map(index => renderedButton(index, `oc-initial-${index}`));
  const finalDisclosure = renderedButton(4, 'oc-final-disclosure');
  let clicks = 0;
  let enumerations = 0;
  const result = await runRenderedClickLoop({
    targets: initial,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { clicks++; return true; },
    enumerate: async () => {
      enumerations++;
      // The fourth click is the only one that reveals another control.
      const controls = clicks === 4 ? [...initial, finalDisclosure] : initial;
      return { controls, total: controls.length };
    },
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(clicks, 4);
  assert.equal(enumerations, 4, 'the final permitted click still re-enumerates');
  assert.equal(result.evidenceControlsClicked, 4);
  assert.equal(result.evidenceControlsSkipped, 1);
  assert.equal(result.interactionGap, true);
  const completion = resolveRenderedCompletionState({
    inspectedPages: 1,
    timedOut: false,
    telemetry: zeroTelemetry(),
    interactionGap: result.interactionGap,
  });
  assert.equal(completion.complete, false, 'final-click disclosure cannot resolve as a clean no-match');
  assert.equal(completion.retryable, true);
});

test('executing click loop counts queued controls left beyond the click cap', async () => {
  const targets = [0, 1, 2, 3, 4].map(index => renderedButton(index, `oc-cap-${index}`));
  let clicks = 0;
  const result = await runRenderedClickLoop({
    targets,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { clicks++; return true; },
    enumerate: async () => ({ controls: targets, total: targets.length }),
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(clicks, 4);
  assert.equal(result.evidenceControlsClicked, 4);
  assert.equal(result.evidenceControlsSkipped, 1, 'the fifth queued control is a coverage gap');
  assert.equal(result.interactionGap, true);
});

test('executing click loop fails closed when post-click re-enumeration throws', async () => {
  const result = await runRenderedClickLoop({
    targets: [renderedButton(0, 'oc-detached')],
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => true,
    enumerate: async () => { throw new Error('document changed during enumeration'); },
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(result.evidenceControlsClicked, 1);
  assert.equal(result.evidenceControlsFailed, 0);
  assert.equal(result.evidenceControlsSkipped, 0);
  assert.equal(result.interactionGap, true, 'unknown disclosures must make coverage incomplete');
});

test('revealed-control planning rotates with the durable retry offset', () => {
  const controls = [
    renderedButton(0, 'oc-a'),
    renderedButton(1, 'oc-b'),
    renderedButton(2, 'oc-c'),
  ];
  const plan = planRevealedRenderedClickTargets(controls, 'https://creator.example/', 4, 3, 0, 2);
  assert.equal(plan.remainingClickBudget, 1);
  assert.deepEqual(plan.toClick.map(target => target.marker), ['oc-c'], 'retry offset selects a later revealed control');
  assert.deepEqual(plan.skipped.map(target => target.marker), ['oc-a', 'oc-b']);
});

test('an interaction gap never counts as sufficient rendered coverage for the site cache', () => {
  assert.equal(isSufficientRenderedCoverage({ complete: true, timedOut: false, interactionGap: true }, true), false);
  assert.equal(isSufficientRenderedCoverage({ complete: true, timedOut: false }, true), true);
  assert.equal(isSufficientRenderedCoverage({ complete: true, timedOut: true }, true), false);
  assert.equal(isSufficientRenderedCoverage({ complete: true }, false), false, 'attempted is not processed');
  assert.equal(isSufficientRenderedCoverage({}, true), false);
});

test('FOUND results keep the interaction gap as a retryable failure class', () => {
  assert.ok(FOUND_GAP_RETRYABLE_FAILURE_CLASSES.has('RENDERED_INTERACTION_GAP'));
});

test('outcome classifier source contracts: gap outranks clean resolution and never resolves as absence', () => {
  const source = readFileSync(fileURLToPath(new URL('./inspector.ts', import.meta.url)), 'utf8');
  // FOUND with an interaction gap carries the retryable gap class.
  assert.match(
    source,
    /if \(interactionGap\) return \{outcome:'FOUND',failureClass:rendered\.timedOut\?'RENDERED_TIMEOUT':'RENDERED_INTERACTION_GAP',gapRetryable:true\};/,
  );
  // Required-link coverage never absorbs the gap into a clean absence.
  assert.match(source, /if \(requiredCovered && !interactionGap\) return \{outcome:'INSPECTED_NO_MATCH'\};/);
  assert.match(source, /if\(rendered\.complete&&renderedProcessed&&!interactionGap\)return\{outcome:'INSPECTED_NO_MATCH'\};/);
  // Partial/acquisition-failed runs keep the gap class visible for retry.
  assert.match(source, /failureClass:timeoutClass\|\|interactionClass\|\|'RENDERED_PARTIAL_COVERAGE'/);
});

test('zero-candidate interaction gaps stay retryable even with permanent-only link failures', () => {
  const source = readFileSync(fileURLToPath(new URL('./inspector.ts', import.meta.url)), 'utf8');
  assert.match(
    source,
    /if \(interactionGap\) return\{outcome:rendered\.inspectedPages>0\?'PARTIALLY_INSPECTED':'ACQUISITION_FAILED',failureClass:rendered\.timedOut\?'RENDERED_TIMEOUT':'RENDERED_INTERACTION_GAP',gapRetryable:true\};/,
    'interaction gap must precede the permanent-only return',
  );
});

test('rendered control coverage counts overflow and uses stable markers across DOM mutations', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.match(source, /return \{ controls, total: matched\.length \}/, 'the complete matched set is returned with its total');
  assert.doesNotMatch(source, /matched\.slice\(0, 64\)/, 'enumeration must not truncate before the retry rotation');
  assert.match(source, /RENDERED_CONTROL_EVALUATION_WINDOW = 64/);
  assert.match(source, /const evaluationWindow = rotated\.slice\(0, windowSize\)/, 'the evaluation window is applied after rotating the full matched pool');
  assert.match(source, /recordControlEnumeration\(firstEnumeration\.total\)/);
  assert.match(source, /data-oc-control/);
  assert.match(source, /partitionRenderedClickTargets\(controls, page\.url\(\), limits\.maxClicksPerPage, limits\.clickOffset\)/, 'the retry offset rotates the full pool before the cap');
  assert.match(source, /const pendingQueuedTargets = Math\.max\(0, clickTargets\.length - clickIndex - 1\)/, 'queued-but-unclicked controls consume the remaining budget');
  assert.match(source, /const freshPlan = planRevealedRenderedClickTargets\(\s*unqueued,\s*input\.pageUrl\(\),\s*input\.maxClicksPerPage,\s*clickedThisPage,\s*pendingQueuedTargets,\s*input\.clickOffset,?\s*\)/, 'revealed controls are planned against the truly remaining slots and retry offset');
  assert.match(source, /const clickLoop = await runRenderedClickLoop\(\{[\s\S]*?enumerate: enumerateControls,[\s\S]*?onEnumerated: recordControlEnumeration,?\s*\}\);/, 'the handler executes the extracted loop after every click');
  assert.doesNotMatch(source, /clickedThisPage < limits\.maxClicksPerPage && Date\.now\(\) - startedAt < limits\.totalTimeoutMs\) \{/, 'the old final-click guard must not return');
  assert.match(source, /freshDropped\+\+/, 're-enumerated controls beyond the remaining budget are counted as skipped');
  assert.match(source, /drops\.count\('control-slice', clickLoop\.evidenceControlsSkipped\)/, 'revealed-control slices are recorded');
  assert.match(source, /interactionGap:interactionGap\|\|undefined/, 'throw paths retain the interaction gap');
  assert.match(source, /if \(clickedThisPage >= input\.maxClicksPerPage\) \{[\s\S]*?clickTargets\.slice\(clickIndex\)/,
    'queued controls beyond the click cap are counted as skipped');
  assert.match(source, /if \(!input\.deadlineExceeded\(\)\) \{[\s\S]*?const refreshed = await input\.enumerate\(\)/,
    'the loop re-enumerates after every click, including the final permitted click');
  assert.match(source, /telemetry\.evidenceControlsTotal = evidenceControlsSeen \|\| undefined/);
  assert.match(source, /telemetry\.evidenceControlsSkipped = evidenceControlsSkipped \|\| undefined/);
});

test('shared rendered evidence stays fail-closed: gapped/timed-out lenders never enter inventory', () => {
  const source = readFileSync(fileURLToPath(new URL('./inspector.ts', import.meta.url)), 'utf8');
  assert.match(
    source,
    /if\(rendered\.complete!==true\|\|rendered\.timedOut===true\|\|rendered\.interactionGap===true\)return;/,
    'only complete, non-timed-out, gapless rendered runs are reusable',
  );
  assert.match(source, /const rec=recs&&recs\[0\];if\(!rec\|\|rec\.complete!==true\)return null;/);
});
