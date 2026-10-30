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
import { combineRenderedControlOffsetAdvances, isNavigableOnlyControlWindow, planRevealedRenderedClickTargets, partitionRenderedClickTargets, remainingRenderedClickBudget, renderedClickOffsetAdvance, resolveRenderedCompletionState, runRenderedClickLoop, type RenderedControlEnumeration } from './browserCommunityFallback';
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

/**
 * Complete P0.2 enumeration shape for loop fixtures. `total` is the pre-filter
 * denominator; these fixtures are all hint-matched, so hint-rejected and the
 * structural/icon counters are zero.
 */
const renderedEnumeration = (
  controls: RenderedControlEnumeration['controls'],
  total = controls.length,
): RenderedControlEnumeration => ({
  controls,
  total,
  hintRejected: Math.max(0, total - controls.length),
  structuralNavigation: 0,
  structuralHintRejected: 0,
  iconLabelRecovered: 0,
  popupTargets: 0,
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

test('an all-navigable evaluation window is certified for durable rotation', () => {
  // A 70-control page whose first window contains only same-host navigable
  // anchors attempts zero clicks. Without an explicit certificate the durable
  // offset would never advance and control 65 would be unreachable forever.
  const anchors = Array.from({ length: 70 }, (_, index) => ({
    index,
    marker: `oc-${index + 1}`,
    text: `Community link ${index + 1}`,
    href: `https://creator.example/community-${index + 1}`,
    tag: 'anchor' as const,
  }));
  const plan = partitionRenderedClickTargets(anchors, 'https://creator.example/', 4, 0);
  assert.equal(plan.toClick.length, 0, 'navigable anchors are enqueue-handled, not clicked');
  assert.equal(plan.skippedNavigableAnchors, 64);
  assert.equal(isNavigableOnlyControlWindow(plan, 4), true, 'a fully examined navigable window advances the rotation');
  assert.equal(isNavigableOnlyControlWindow(plan, 0), false, 'a zero click budget did not examine the window');
  assert.equal(renderedClickOffsetAdvance(plan, 0, 4), 64, 'a certified all-navigable window advances one full window');
  assert.equal(renderedClickOffsetAdvance(plan, 0, 0), 0, 'a zero click budget never advances the rotation');

  const clickable = partitionRenderedClickTargets(
    Array.from({ length: 70 }, (_, index) => renderedButton(index, `oc-${index + 1}`)),
    'https://creator.example/',
    4,
    0,
  );
  assert.equal(isNavigableOnlyControlWindow(clickable, 4), false, 'a window with clickable controls is not certified as navigable-only');
  assert.equal(renderedClickOffsetAdvance(clickable, 0, 4), 0, 'an uncertified zero-click window (deadline/crash) must not advance');
  assert.equal(renderedClickOffsetAdvance(clickable, 2, 4), 2, 'a partial click window advances past the last attempted control');
});

test('retry offsets advance past anchors before clicked controls instead of repeating them', () => {
  // Four navigable anchors precede eight buttons. The offset indexes the full
  // matched pool, so advancing by the raw click count (4) would land back on
  // button 1; it must advance past the last attempted button (position 7).
  const anchors = Array.from({ length: 4 }, (_, index) => ({
    index,
    marker: `oc-a${index + 1}`,
    text: `Community link ${index + 1}`,
    href: `https://creator.example/community-${index + 1}`,
    tag: 'anchor' as const,
  }));
  const buttons = Array.from({ length: 8 }, (_, index) => renderedButton(index + 4, `oc-b${index + 1}`));
  const controls = [...anchors, ...buttons];

  const first = partitionRenderedClickTargets(controls, 'https://creator.example/', 4, 0);
  assert.deepEqual(first.toClick.map(target => target.marker), ['oc-b1', 'oc-b2', 'oc-b3', 'oc-b4']);
  assert.equal(renderedClickOffsetAdvance(first, 4, 4), 8, 'the offset lands just past the last clicked control');

  const second = partitionRenderedClickTargets(controls, 'https://creator.example/', 4, 8);
  assert.deepEqual(
    second.toClick.map(target => target.marker),
    ['oc-b5', 'oc-b6', 'oc-b7', 'oc-b8'],
    'the retry examines the next buttons instead of repeating the first four',
  );
  assert.equal(renderedClickOffsetAdvance(second, 4, 4), 4, 'the next page-relative advance covers the four attempted buttons');

  // Anchors after the clickable controls do not change the position advance.
  const buttonsFirst = [...buttons, ...anchors.map((anchor, index) => ({ ...anchor, index: index + 8, marker: `oc-tail-a${index + 1}` }))];
  const firstButtonsFirst = partitionRenderedClickTargets(buttonsFirst, 'https://creator.example/', 4, 0);
  assert.deepEqual(firstButtonsFirst.toClick.map(target => target.marker), ['oc-b1', 'oc-b2', 'oc-b3', 'oc-b4']);
  assert.equal(renderedClickOffsetAdvance(firstButtonsFirst, 4, 4), 4);
  const secondButtonsFirst = partitionRenderedClickTargets(buttonsFirst, 'https://creator.example/', 4, 4);
  assert.deepEqual(secondButtonsFirst.toClick.map(target => target.marker), ['oc-b5', 'oc-b6', 'oc-b7', 'oc-b8']);
});

test('failed controls stop retry rotation before their unexamined content', async () => {
  const anchors = Array.from({ length: 4 }, (_, index) => ({
    index,
    marker: `oc-fa${index + 1}`,
    text: `Community link ${index + 1}`,
    href: `https://creator.example/community-${index + 1}`,
    tag: 'anchor' as const,
  }));
  const buttons = Array.from({ length: 8 }, (_, index) => renderedButton(index + 4, `oc-fb${index + 1}`));
  const controls = [...anchors, ...buttons];
  const plan = partitionRenderedClickTargets(controls, 'https://creator.example/', 4, 0);
  let attempts = 0;
  const result = await runRenderedClickLoop({
    targets: plan.toClick,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    // The first two clicks succeed; the third fails; the fourth succeeds.
    click: async () => { attempts++; return attempts !== 3; },
    enumerate: async () => renderedEnumeration(controls),
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(result.evidenceControlsClicked, 3);
  assert.equal(result.evidenceControlsFailed, 1);
  assert.equal(result.firstFailedTargetIndex, 2, 'the failed control is identified by queue position');
  // Four anchors precede the buttons. The failed button is at full-pool
  // position 6; the offset must stop there, not move past it to position 7.
  assert.equal(
    renderedClickOffsetAdvance(plan, result.evidenceControlsClicked + result.evidenceControlsFailed, 4, result.firstFailedTargetIndex),
    6,
    'the next retry starts at the failed control',
  );
  const next = partitionRenderedClickTargets(controls, 'https://creator.example/', 4, 6);
  assert.deepEqual(next.toClick.map(target => target.marker), ['oc-fb3', 'oc-fb4', 'oc-fb5', 'oc-fb6']);
});

test('a failed first control cannot freeze the retry rotation', async () => {
  const buttons = Array.from({ length: 8 }, (_, index) => renderedButton(index, `oc-hf${index + 1}`));
  const plan = partitionRenderedClickTargets(buttons, 'https://creator.example/', 4, 0);
  let attempts = 0;
  const result = await runRenderedClickLoop({
    targets: plan.toClick,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    // The first control is disabled/hidden and always fails; the next three
    // clicks succeed. A position-zero failure must not pin every retry to the
    // same window.
    click: async () => { attempts++; return attempts !== 1; },
    enumerate: async () => renderedEnumeration(buttons),
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(result.evidenceControlsFailed, 1);
  assert.equal(result.firstFailedTargetIndex, 0);
  assert.equal(
    renderedClickOffsetAdvance(plan, result.evidenceControlsClicked + result.evidenceControlsFailed, 4, result.firstFailedTargetIndex),
    4,
    'the attempted window advances instead of freezing at zero',
  );
  const next = partitionRenderedClickTargets(buttons, 'https://creator.example/', 4, 4);
  assert.deepEqual(next.toClick.map(target => target.marker), ['oc-hf5', 'oc-hf6', 'oc-hf7', 'oc-hf8']);
});

test('shared retry offset advances by the smallest page progress, never the largest', () => {
  // A seed page with 64 navigable anchors advances 64 on its own, while a
  // child page with clickable buttons advances 4. Saving the largest advance
  // would rotate the child's pool back to its first buttons (64 % 64 = 0) and
  // leave later buttons permanently unclicked.
  assert.equal(combineRenderedControlOffsetAdvances(undefined, 64), 64);
  assert.equal(combineRenderedControlOffsetAdvances(64, 4), 4, 'the navigable seed cannot skip the clickable child');
  assert.equal(combineRenderedControlOffsetAdvances(4, 8), 4, 'a later page never increases the shared advance');
  assert.equal(combineRenderedControlOffsetAdvances(4, 0), 4, 'a page with no progress does not erase prior progress');
  assert.equal(combineRenderedControlOffsetAdvances(undefined, 0), undefined, 'no progress stays sparse');
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
      return renderedEnumeration(controls);
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
      return renderedEnumeration(controls);
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
    enumerate: async () => renderedEnumeration(targets),
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
  assert.match(source, /return \{\s*controls,\s*total: nodes\.length,/, 'the complete matched set is returned with its pre-filter total');
  assert.match(source, /hintRejected: Math\.max\(0, nodes\.length - controls\.length\)/, 'hint-rejected is the pre-filter denominator minus matched controls');
  assert.match(source, /structuralNavigation,/, 'structural navigation controls are counted for P1.1');
  assert.match(source, /iconLabelRecovered,/, 'icon/label recovery is counted for P1.2');
  assert.match(source, /popupTargets,/, 'popup targets are counted for P1.3');
  assert.doesNotMatch(source, /matched\.slice\(0, 64\)/, 'enumeration must not truncate before the retry rotation');
  assert.match(source, /RENDERED_CONTROL_EVALUATION_WINDOW = 64/);
  assert.match(source, /const evaluationWindow = rotated\.slice\(0, windowSize\)/, 'the evaluation window is applied after rotating the full matched pool');
  assert.match(source, /recordControlEnumeration\(firstEnumeration\)/);
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
  assert.match(source, /combineRenderedControlOffsetAdvances\(\s*evidenceControlsOffsetAdvance,\s*offsetAdvance,?\s*\)/, 'the crawl aggregates per-page progress conservatively');
  assert.match(source, /evidenceControlsUncertified = true/, 'an unexamined clickable page blocks shared offset advancement');
  assert.match(source, /telemetry\.evidenceControlsUncertified = evidenceControlsUncertified \|\| undefined/);
  assert.match(source, /clickLoop\.firstFailedTargetIndex/, 'the crawl stops rotation at the first failed control');
  assert.match(source, /if \(pageClickWindowPending\) evidenceControlsUncertified = true/, 'a throw during a clickable page leaves the seed uncertified');
  assert.match(source, /scrollCapReachedStillGrowing = true/, 'the scroll cap records when the page was still growing');
  assert.match(source, /page\.evaluate\(collectRenderedPageContext\)/, 'frame/shadow/base-href context is collected per page');
  assert.match(source, /telemetry\.coverageReason = resolveRenderedCoverageReason\(/, 'the crawl publishes a diagnostic coverage reason');
  assert.match(source, /telemetry\.controlsEnumeratedTotal = controlsEnumeratedTotal \|\| undefined/, 'pre-filter control totals are persisted');
  assert.match(source, /telemetry\.navigationPolicyExcluded = /, 'navigation policy exclusions are persisted');
  assert.equal(
    (source.match(/publishEvidenceControlCertificate\(/g) || []).length,
    2,
    'both the success and catch paths publish the control certificate to telemetry',
  );
});

test('P0.2 coverage counters stay coherent, bounded, and preserved on error paths', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.match(source, /if \(!pageSnapshotRecorded \|\| enumeration\.total > pageControlsEnumeratedTotal\) \{[\s\S]*?pageHintRejected = enumeration\.hintRejected/, 'the denominator and hint-rejected counts come from one enumeration snapshot');
  assert.match(source, /aggregatePageCountersOnError\?\.\(\)/, 'the handler catch preserves counters from an already-enumerated page');
  assert.match(source, /if \(pageCountersAggregated\) return;/, 'the error and success aggregations cannot double-count a page');
  assert.match(source, /await recordPageContext\(\);\s*\/\/ Page-end aggregation/, 'context counters refresh after the click loop');
  assert.match(source, /Math\.max\(0, pagePopupTargets - examinedPopups\)/, 'popups examined by the click loop are not reported as unexamined context');
  assert.match(source, /document\.getElementsByTagName\(frameTags\[tagIndex\]\)/, 'frame counting uses live collections instead of materializing every match');
  assert.doesNotMatch(source, /querySelectorAll\('iframe,frame,object,embed'\)/, 'the unbounded materializing frame query is gone');
  assert.match(source, /const labelText = /, 'structural classification uses the control own label text');
  assert.doesNotMatch(source, /resources\|support\|explore\|more/, 'generic content words no longer classify a control as structural navigation');
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
