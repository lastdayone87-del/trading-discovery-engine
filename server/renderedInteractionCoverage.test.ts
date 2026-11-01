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
import { combineRenderedControlOffsetAdvances, isCrossHostnameStructuralNavigation, isNavigableOnlyControlWindow, isSameSeedDocument, isUnrecoveredStructuralNavigation, mergeRenderedCoverageGapCounters, planRevealedRenderedClickTargets, partitionRenderedClickTargets, reconcileClickDestinationContext, remainingRenderedClickBudget, renderedClickOffsetAdvance, renderedControlOverflowTargets, renderedRequestControlTotalsDelta, resolveRenderedCompletionState, resolveUnexaminedPopupTargets, runRenderedClickLoop, trackRenderedPopupCoverage, type RenderedControlEnumeration, type RenderedRequestControlTotals } from './browserCommunityFallback';
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
  structuralDisclosure: 0,
  structuralUnrecovered: 0,
  structuralUnrecoveredHrefs: [],
  structuralUnrecoveredOverflow: false,
  iconLabelRecovered: 0,
  popupTargets: 0,
  popupMarkers: controls.filter(control => control.popup && control.marker).map(control => control.marker as string),
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

test('over-budget generic disclosures do not make an otherwise clean page retryable', async () => {
  const controls = Array.from({ length: 5 }, (_, index) => ({
    ...renderedButton(index, `oc-disclosure-${index}`),
    text: 'Open menu',
    origin: 'disclosure' as const,
  }));
  let clicks = 0;
  const result = await runRenderedClickLoop({
    targets: controls,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { clicks++; return true; },
    enumerate: async () => renderedEnumeration(controls),
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(clicks, 4, 'disclosures still consume available click budget');
  assert.equal(result.evidenceControlsSkipped, 1);
  assert.equal(result.interactionGap, false, 'an unclicked generic disclosure is opportunistic, not a retryable gap');
});

test('a failed generic disclosure stays diagnostic while failed evidence controls keep the gap', async () => {
  const run = async (control: ReturnType<typeof renderedButton> & { origin: 'hint' | 'icon' | 'disclosure' }) =>
    runRenderedClickLoop({
      targets: [control],
      maxClicksPerPage: 4,
      deadlineExceeded: () => false,
      click: async () => false,
      enumerate: async () => renderedEnumeration([control]),
      pageUrl: () => 'https://creator.example/',
    });
  const disclosure = await run({ ...renderedButton(0, 'oc-menu'), text: 'Open menu', origin: 'disclosure' });
  assert.equal(disclosure.evidenceControlsFailed, 1);
  assert.equal(disclosure.interactionGap, false, 'a failed generic disclosure is opportunistic, not a retryable gap');
  for (const origin of ['hint', 'icon'] as const) {
    const result = await run({ ...renderedButton(0, `oc-${origin}`), origin });
    assert.equal(result.evidenceControlsFailed, 1);
    assert.equal(result.interactionGap, true, `a failed ${origin} control remains a retryable gap`);
  }
});

test('an unclicked hint/icon control still makes the page retryable', async () => {
  const controls = [
    { ...renderedButton(0, 'oc-hint'), origin: 'hint' as const },
    ...Array.from({ length: 4 }, (_, index) => ({
      ...renderedButton(index + 1, `oc-disclosure-${index}`),
      text: 'Open menu',
      origin: 'disclosure' as const,
    })),
  ];
  const result = await runRenderedClickLoop({
    targets: controls,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => true,
    enumerate: async () => renderedEnumeration(controls),
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(result.evidenceControlsSkipped, 1);
  assert.equal(result.interactionGap, false, 'the skipped control is only a disclosure');

  const fiveHints = controls.map((control, index) => ({ ...control, marker: `oc-hint-${index}`, origin: 'hint' as const }));
  const hinted = await runRenderedClickLoop({
    targets: fiveHints,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => true,
    enumerate: async () => renderedEnumeration(fiveHints),
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(hinted.evidenceControlsSkipped, 1);
  assert.equal(hinted.interactionGap, true, 'an unclicked evidence control remains a retryable gap');
});

test('an over-budget icon-recovery control also makes the page retryable', async () => {
  const controls = Array.from({ length: 5 }, (_, index) => ({
    ...renderedButton(index, `oc-icon-${index}`),
    origin: 'icon' as const,
  }));
  let clicks = 0;
  const result = await runRenderedClickLoop({
    targets: controls,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { clicks++; return true; },
    enumerate: async () => renderedEnumeration(controls),
    pageUrl: () => 'https://creator.example/',
  });
  assert.equal(clicks, 4, 'icon recoveries consume the click budget');
  assert.equal(result.evidenceControlsSkipped, 1);
  assert.equal(result.interactionGap, true, 'an unclicked icon recovery is evidence-bearing, not opportunistic');
});

test('a replaced document only gaps on unexamined hint/icon leftovers', async () => {
  const disclosures = Array.from({ length: 3 }, (_, index) => ({
    ...renderedButton(index, `oc-left-${index}`),
    origin: 'disclosure' as const,
  }));
  const url = { value: 'https://creator.example/start' };
  const disclosureOnly = await runRenderedClickLoop({
    targets: disclosures,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { url.value = 'https://creator.example/next'; return true; },
    enumerate: async () => renderedEnumeration(disclosures),
    pageUrl: () => url.value,
  });
  assert.equal(disclosureOnly.evidenceControlsSkipped, 2);
  assert.equal(disclosureOnly.interactionGap, false, 'disclosure-only leftovers stay opportunistic');

  url.value = 'https://creator.example/start';
  const withHint = await runRenderedClickLoop({
    targets: [disclosures[0], { ...renderedButton(1, 'oc-hint'), origin: 'hint' as const }, disclosures[2]],
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { url.value = 'https://creator.example/next'; return true; },
    enumerate: async () => renderedEnumeration(disclosures),
    pageUrl: () => url.value,
  });
  assert.equal(withHint.evidenceControlsSkipped, 2);
  assert.equal(withHint.interactionGap, true, 'a stranded hint control is a retryable gap');
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

test('a click that replaces the document stops the loop and counts remaining controls as skipped', async () => {
  const targets = [0, 1, 2].map(index => renderedButton(index, `oc-nav-${index}`));
  let url = 'https://creator.example/start';
  let enumerations = 0;
  const result = await runRenderedClickLoop({
    targets,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { url = 'https://creator.example/replaced'; return true; },
    enumerate: async () => { enumerations++; return renderedEnumeration(targets); },
    pageUrl: () => url,
  });
  assert.equal(result.evidenceControlsClicked, 1);
  assert.equal(result.evidenceControlsSkipped, 2, 'old-document controls are unexamined after navigation');
  assert.equal(result.interactionGap, true, 'navigation away leaves the interaction plan incomplete');
  assert.equal(enumerations, 0, 'the replaced document is not re-enumerated as the original page');
});

test('a hash-only change is an in-place disclosure, not document navigation', async () => {
  const targets = [renderedButton(0, 'oc-hash')];
  let url = 'https://creator.example/start';
  let enumerations = 0;
  const result = await runRenderedClickLoop({
    targets,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { url = 'https://creator.example/start#menu'; return true; },
    enumerate: async () => { enumerations++; return renderedEnumeration(targets); },
    pageUrl: () => url,
  });
  assert.equal(result.evidenceControlsSkipped, 0);
  assert.equal(result.interactionGap, false);
  assert.equal(enumerations, 1, 'hash-only changes still re-enumerate the same document');
});

test('a final click that navigates does not invent a gap', async () => {
  const targets = [renderedButton(0, 'oc-final-nav')];
  let url = 'https://creator.example/start';
  const result = await runRenderedClickLoop({
    targets,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { url = 'https://discord.gg/example'; return true; },
    enumerate: async () => renderedEnumeration(targets),
    pageUrl: () => url,
  });
  assert.equal(result.evidenceControlsClicked, 1);
  assert.equal(result.evidenceControlsSkipped, 0);
  assert.equal(result.interactionGap, false, 'no original-page control was left unexamined');
});

test('only terminal success satisfies required coverage', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.match(source, /inspectedPageKeys\.add\(inspectedVisitKey\)/, 'an inspected page is tracked separately from caller-supplied visited evidence');
  assert.doesNotMatch(source, /alreadyVisitedSet\.add\(inspectedVisitKey\)/, 'a merely inspected page never becomes shared successful evidence');
  assert.match(source, /structuralVisitedKeys\.add\(inspectedVisitKey\)/, 'the inspected page still counts for structural-navigation deduplication');
  assert.match(source, /for \(const identity of terminalSuccessUrls\)[\s\S]{0,160}?sharedCoveredKeys\.add\(key\)/, 'required coverage borrows only terminal-success identities');
  assert.match(source, /renderedTerminalSuccessIdentities\(\{[\s\S]{0,260}?inspectedDocumentUrl: clickLoop\.processedDocumentUrl,[\s\S]{0,200}?documentReplacedByClick: clickLoop\.documentReplaced,/, 'a click-committed replacement document is not borrowed as terminal success, while same-document updates are kept');
  assert.match(source, /classifyRequiredCoverage\(\{[\s\S]{0,200}?sharedCoveredKeys,/, 'classification receives only terminal-success shared evidence');
});

test('a seed retry refreshes its own document identity and required links', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.match(source, /const seedRequestKey = normalizeVisitUrl\(seedUrl\)/, 'the seed request is identified once for the crawl');
  assert.match(source, /if \(seedRequestKey && normalizeVisitUrl\(request\.url\) === seedRequestKey\)/, 'the snapshot is refreshed for each seed attempt, not only the first');
  assert.match(source, /for \(const link of discoverRequiredSeedLinks\(await page\.content\(\), page\.url\(\)\)\) known\.add\(link\)/, 'retry-discovered links merge with earlier seed links');
});

test('required-link snapshot follows the seed document across a same-document query change', () => {
  assert.equal(
    isSameSeedDocument(
      'document-1',
      'document-1',
      'https://creator.example/start',
      'https://creator.example/start?menu=open',
    ),
    true,
    'a history-only query change keeps the seed document and its newly revealed required links',
  );
  assert.equal(
    isSameSeedDocument(
      'document-1',
      'document-2',
      'https://creator.example/start',
      'https://creator.example/start',
    ),
    false,
    'a replaced document never contributes required obligations to the seed',
  );
  assert.equal(
    isSameSeedDocument(
      null,
      null,
      'https://creator.example/start',
      'https://creator.example/start?menu=open',
    ),
    false,
    'identity read failure falls back to the fail-closed URL comparison',
  );
  assert.equal(
    isSameSeedDocument(
      null,
      null,
      'https://creator.example/start',
      'https://creator.example/start',
    ),
    true,
  );
});

test('structural navigation is a coverage gap only when enqueue will not follow it', () => {
  const pageUrl = 'https://creator.example/';
  const visited = new Set<string>();
  assert.equal(
    isUnrecoveredStructuralNavigation('https://creator.example/resources', pageUrl, visited),
    true,
    'same-origin, admissible, hint-rejected: neither clicked nor enqueued',
  );
  assert.equal(
    isUnrecoveredStructuralNavigation('https://creator.example/contact', pageUrl, visited),
    false,
    'the enqueue path owns and follows community-hint destinations',
  );
  assert.equal(
    isUnrecoveredStructuralNavigation('https://other.example/resources', pageUrl, visited),
    false,
    'cross-origin destinations are represented by the cross-origin policy counter',
  );
  assert.equal(
    isUnrecoveredStructuralNavigation('mailto:creator@example.com', pageUrl, visited),
    false,
    'format rejections are not unexamined navigation',
  );
  assert.equal(
    isUnrecoveredStructuralNavigation('https://creator.example/logo.png', pageUrl, visited),
    false,
    'asset rejections are not unexamined navigation',
  );
  assert.equal(
    isUnrecoveredStructuralNavigation(
      'https://creator.example/resources',
      pageUrl,
      new Set(['https://creator.example/resources']),
    ),
    false,
    'an already-visited destination was examined',
  );
});

test('cross-hostname structural anchors are classified for the rendered policy ledger', () => {
  assert.equal(
    isCrossHostnameStructuralNavigation('https://other.example/resources', 'https://creator.example/'),
    true,
  );
  assert.equal(
    isCrossHostnameStructuralNavigation('https://creator.example/resources', 'https://creator.example/start'),
    false,
  );
  assert.equal(
    isCrossHostnameStructuralNavigation('http://creator.example/resources', 'https://creator.example/'),
    false,
    'the same-hostname enqueue strategy follows a scheme switch',
  );
  assert.equal(
    isCrossHostnameStructuralNavigation('https://creator.example:8443/resources', 'https://creator.example/'),
    false,
    'the same-hostname enqueue strategy ignores the port',
  );
  assert.equal(
    isCrossHostnameStructuralNavigation('mailto:creator@example.com', 'https://creator.example/'),
    false,
    'format rejections are not cross-hostname navigation',
  );
  assert.equal(isCrossHostnameStructuralNavigation('', 'https://creator.example/'), false);
});

test('overflow targets follow the durable rotation and expose only unexamined controls', () => {
  const controls = Array.from({ length: 6 }, (_, index) => renderedButton(index, `oc-${index}`));
  assert.deepEqual(renderedControlOverflowTargets(controls, 0, 4).map(c => c.marker), ['oc-4', 'oc-5']);
  assert.deepEqual(
    renderedControlOverflowTargets(controls, 4, 4).map(c => c.marker),
    ['oc-2', 'oc-3'],
    'the unexamined set rotates with the durable offset',
  );
  assert.deepEqual(renderedControlOverflowTargets(controls.slice(0, 4), 0, 4), [], 'a page inside the window has no overflow');
});

test('a same-document query change continues the click loop and reaches revealed controls', async () => {
  const targets = [renderedButton(0, 'oc-push')];
  const revealed = renderedButton(1, 'oc-revealed');
  let url = 'https://creator.example/start';
  let clicks = 0;
  let enumerations = 0;
  const result = await runRenderedClickLoop({
    targets,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => {
      clicks++;
      if (clicks === 1) url = 'https://creator.example/start?menu=open';
      return true;
    },
    enumerate: async () => {
      enumerations++;
      return renderedEnumeration([...targets, revealed]);
    },
    pageUrl: () => url,
    documentIdentity: async () => 'same-document',
  });
  assert.equal(result.evidenceControlsClicked, 2, 'the revealed control is still clicked');
  assert.equal(result.evidenceControlsSkipped, 0);
  assert.equal(result.interactionGap, false);
  assert.equal(enumerations, 2, 'the same document is re-enumerated after the query change');
});

test('a later replacement keeps the last processed URL as inspected evidence', async () => {
  const targets = [renderedButton(0, 'oc-push'), renderedButton(1, 'oc-nav')];
  let url = 'https://creator.example/start';
  let clicks = 0;
  const result = await runRenderedClickLoop({
    targets,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => {
      clicks++;
      url = clicks === 1
        ? 'https://creator.example/start?menu=open'
        : 'https://creator.example/community';
      return true;
    },
    enumerate: async () => renderedEnumeration(targets),
    pageUrl: () => url,
    documentIdentity: async () => (url.includes('community') ? 'document-2' : 'document-1'),
  });
  assert.equal(result.documentReplaced, true);
  assert.equal(
    result.processedDocumentUrl,
    'https://creator.example/start?menu=open',
    'the same-document update before the replacement remains inspected evidence',
  );
});

test('a changed document identity stops the loop even when the URL is unchanged', async () => {
  const targets = [renderedButton(0, 'oc-identity-1'), renderedButton(1, 'oc-identity-2')];
  let identity = 'document-1';
  let enumerations = 0;
  const result = await runRenderedClickLoop({
    targets,
    maxClicksPerPage: 4,
    deadlineExceeded: () => false,
    click: async () => { identity = 'document-2'; return true; },
    enumerate: async () => { enumerations++; return renderedEnumeration(targets); },
    pageUrl: () => 'https://creator.example/start',
    documentIdentity: async () => identity,
  });
  assert.equal(result.evidenceControlsClicked, 1);
  assert.equal(result.evidenceControlsSkipped, 1, 'the replaced document leaves the queued control unexamined');
  assert.equal(result.interactionGap, true);
  assert.equal(enumerations, 0, 'a replaced document is never re-enumerated as the original page');
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
  assert.match(source, /hintRejected: Math\.max\(0, nodes\.length - baseMatchedCount\)/, 'hint-rejected stays measured against the original filter');
  assert.match(source, /structuralNavigation,/, 'structural navigation controls are counted for P1.1');
  assert.match(source, /structuralDisclosure,/, 'in-place structural disclosures are counted for P1.1');
  assert.match(source, /structuralUnrecovered,/, 'structural controls left to the enqueue path are counted');
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
  assert.match(source, /(?:const\s+)?clickLoop = await runRenderedClickLoop\(\{[\s\S]*?enumerate: enumerateControls,[\s\S]*?onEnumerated: recordControlEnumeration,?\s*\}\);/, 'the handler executes the extracted loop after every click');
  assert.doesNotMatch(source, /clickedThisPage < limits\.maxClicksPerPage && Date\.now\(\) - startedAt < limits\.totalTimeoutMs\) \{/, 'the old final-click guard must not return');
  assert.match(source, /freshDropped\+\+/, 're-enumerated controls beyond the remaining budget are counted as skipped');
  assert.match(source, /const sliceSkippedTargets = clickPlan\.evaluationWindow\.filter/, 'slice accounting identifies the skipped targets');
  assert.match(source, /renderedControlSkipsNeedInteractionGap\(sliceSkippedTargets\)/, 'only hint/icon skips make the initial plan retryable');
  assert.match(source, /origin: baseMatched \? 'hint' : extendedMatched \? 'icon' : 'disclosure'/, 'enumeration records why a control entered the click set');
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
  assert.match(source, /telemetry\.evidenceControlsUncertified = \(evidenceControlsUncertified \|\| uncertifiedRequestKeys\.size > 0\) \|\| undefined/);
  assert.match(source, /clickLoop\.firstFailedTargetIndex/, 'the crawl stops rotation at the first failed control');
  assert.match(source, /if \(pageClickWindowPending\) evidenceControlsUncertified = true/, 'a throw during a clickable page leaves the seed uncertified');
  assert.match(source, /if \(i === limits\.maxScrollsPerPage - 1\) pageScrollCapThisAttempt = true/, 'the scroll cap records when the page was still growing');
  assert.match(source, /pageScrollCapByRequest\.set\(requestKey, pageScrollCapThisAttempt\)/, 'scroll-cap growth is stored per request attempt');
  assert.match(source, /scrollCapReachedStillGrowing = \[\.\.\.pageScrollCapByRequest\.values\(\)\]\.some\(Boolean\)/, 'a successful retry replaces the stale scroll-cap flag');
  assert.match(source, /baseHrefPresent = \[\.\.\.pageControlTotalsByRequest\.values\(\)\]\.some\(entry => entry\.baseHrefPresent === true\)/, 'base-href presence reflects the latest attempt per request');
  assert.match(source, /recordClickDestinationContext\(page\.url\(\), \{/, 'a clicked destination is observed by identity instead of mutating the request counters');
  assert.doesNotMatch(source, /admittedEnqueueKeys/, 'admission is not evidence of inspection: it cannot suppress a click-only sample');
  assert.match(source, /reconcileClickDestinationContext\(\{[\s\S]{0,160}?observations: clickDestinationContextByKey,[\s\S]{0,120}?inspectedKeys: inspectedDocumentKeys,/, 'click-only context is reconciled against inspected documents at publish time');
  assert.match(source, /if \(input\.inspectedKeys\.has\(key\)\) continue;/, 'a destination its own request inspected is not counted twice');
  assert.match(source, /frameCount: frameCount \+ clickDestinationContext\.frameCount,[\s\S]{0,200}?shadowRootCount: shadowRootCount \+ clickDestinationContext\.shadowRootCount,/, 'the coverage reason sees the same click-only context that telemetry publishes');
  assert.match(source, /for \(const identity of visitIdentityKeys\(request\.url, page\.url\(\)\)\) \{\s*inspectedDocumentKeys\.add\(identity\);/, 'every request records the document it actually inspected');
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
  assert.match(source, /if \(previous && !pageSnapshotRecorded\) \{[\s\S]{0,1400}?frameCount: Math\.max\(previous\.frameCount \|\| 0, pageFrameCount\),[\s\S]{0,200}?shadowRootCount: Math\.max\(previous\.shadowRootCount \|\| 0, pageShadowRootCount\),[\s\S]{0,200}?baseHrefPresent: previous\.baseHrefPresent \|\| pageBaseHrefPresent,[\s\S]{0,900}?return;/, 'a retry that never enumerated keeps the earlier control snapshot and merges every context count');
  assert.match(source, /aggregatePageCountersOnError\?\.\(\)/, 'the handler catch preserves counters from an already-enumerated page');
  assert.match(source, /if \(pageCountersAggregated\) return;/, 'the error and success aggregations cannot double-count a page');
  assert.match(source, /await recordPageContext\(\);\s*\/\/ Page-end aggregation/, 'context counters refresh after the click loop');
  assert.match(source, /const clickOutcome = await attemptRenderedControlClick[\s\S]{0,1200}?\n\s+queuePageContextProbe\(\);\n\s+if \(clickOutcome\.ok/, 'a context sample is queued after each click before the next can replace the DOM');
  assert.match(source, /const pendingContextProbes: Array<Promise<void>> = \[\];/, 'per-click probes are not awaited on the click path');
  assert.match(source, /await flushPageContextProbes\(\);\s*\n\s*await recordPageContext\(\);/, 'pending samples are flushed before page-end aggregation');
  assert.match(source, /await flushPageContextProbesOnError\?\.\(\);/, 'pending samples are flushed before error aggregation');
  assert.match(source, /const initialPageContext = await page\.evaluate\(collectRenderedPageContext\)\.catch\(\(\) => null\);/, 'the baseline identity and context counts are captured together before any counter sample');
  assert.match(source, /pageDocumentIdentity = initialPageContext\.documentTimeOrigin \?\? null;/, 'the baseline identity comes from that first evaluation');
  assert.doesNotMatch(source, /pageDocumentIdentity = currentIdentity;/, 'a later probe never redefines the inspected document');
  assert.match(source, /const capMs = Math\.max\(0, Math\.min\(250, remainingMs\)\);/, 'probe flushing has a short cap bounded by the remaining crawl budget');
  assert.match(source, /contextMeasurementAbandoned = true;/, 'abandoned context sampling is recorded at crawl level');
  assert.match(source, /contextUnknown: contextMeasurementAbandoned/, 'abandoned context sampling prevents a COMPLETE coverage reason');
  assert.match(source, /const sameDocument = pageDocumentIdentity !== null && currentIdentity !== null[\s\S]{0,260}?currentIdentity === pageDocumentIdentity/, 'the identity comparison gates the guard that permits counter updates');
  assert.match(source, /if \(!sameDocument && !sameUrl\) \{[\s\S]{0,900}?recordClickDestinationContext\(page\.url\(\), \{[\s\S]{0,400}?return;/, 'a click-reached destination contributes context but never leaks another document into the request counters');
  assert.match(source, /pagePopupMarkers = trackRenderedPopupCoverage\(pagePopupMarkers, enumeration\)/, 'popup identities are tracked across every enumeration');
  assert.match(source, /popupCount: resolveUnexaminedPopupTargets\(pagePopupMarkers, examinedPopupMarkers\)/, 'only popups actually examined are excluded; a replacement cannot be cancelled by an earlier click');
  assert.match(source, /popupTargets \+= delta\.popupCount/, 'the same-request retry delta adjusts the popup contribution');
  assert.match(source, /pageControlTotalsByRequest\.set\(requestKey, current\)/, 'a retried request replaces its last-attempt counters');
  assert.match(source, /if \(pageClickWindowPending\) evidenceControlsUncertified = true;/, 'a thrown handler certifies a pending click window before Crawlee retries');
  assert.match(source, /document\.getElementsByTagName\(frameTags\[tagIndex\]\)/, 'frame counting uses live collections instead of materializing every match');
  assert.doesNotMatch(source, /querySelectorAll\('iframe,frame,object,embed'\)/, 'the unbounded materializing frame query is gone');
  assert.match(source, /const extendedText = `\$\{baseText\} \$\{title\} \$\{labelledByText\} \$\{childAlt\} \$\{dataLabel\} \$\{dataTooltip\} \$\{svgTitle\} \$\{hiddenText\}`/, 'structural classification reads the control own text plus bounded label attributes');
  assert.match(source, /const unrecoveredStructuralNavigation = excludedStructuralNavigation\s*&& \(explicitStructural \|\| extendedMatched\)/, 'only explicit menu semantics or a hint-recovered label turn a navigable anchor into a coverage gap');
  assert.doesNotMatch(source, /const labelText = `\$\{element\.innerText \|\| ''\} \$\{ariaLabel\} \$\{title\}/, 'title text alone cannot be the only classification input');
  const aggregateRegistration = source.indexOf('aggregatePageCountersOnError = aggregatePageControlCounters;');
  const scrollLoop = source.indexOf('for (let i = 0; i < limits.maxScrollsPerPage; i++)');
  assert.ok(aggregateRegistration !== -1 && scrollLoop !== -1, 'the error aggregator and scroll loop both exist');
  assert.ok(aggregateRegistration < scrollLoop, 'the error aggregator is registered before scrolling so a scroll throw keeps measured context counts');
  assert.match(source, /mergeRenderedCoverageGapCounters\(/, 'later enumerations merge their coverage-gap observations');
  assert.match(source, /pageStructuralHintRejected = gapCounters\.structuralHintRejected/, 'a later smaller enumeration cannot discard a structural coverage gap');
  assert.match(source, /popupWindowsThisClick\.size === 0/, 'a click that opened a new window is not treated as an examined popup');
  assert.match(source, /clickPageContext\?\.off\?\.\('page', onPopupWindow\)/, 'the popup listener does not outlive the click loop');
});

test('a control hidden by an earlier click is skipped instead of timing out', async () => {
  const clicked: string[] = [];
  const result = await runRenderedClickLoop({
    targets: [renderedButton(0, 'oc-hidden'), renderedButton(1, 'oc-visible')],
    maxClicksPerPage: 1,
    deadlineExceeded: () => false,
    isVisible: async target => target.marker !== 'oc-hidden',
    click: async target => {
      clicked.push(String(target.marker));
      return true;
    },
    enumerate: async () => renderedEnumeration([]),
    pageUrl: () => 'https://creator.example/',
  });
  assert.deepEqual(clicked, ['oc-visible'], 'the remaining budget goes to a control that can still be clicked');
  assert.equal(result.evidenceControlsClicked, 1);
  assert.equal(result.evidenceControlsSkipped, 1, 'the hidden control is an unexamined skip, not a failed click');
  assert.equal(result.evidenceControlsFailed, 0, 'no actionability timeout is spent on a hidden control');
  assert.equal(result.interactionGap, true, 'an unexamined hint/icon control keeps the page incomplete');
});

test('hidden controls wait for the disclosure that reveals them', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.match(source, /const hidden = element\.getClientRects\(\)\.length === 0[\s\S]{0,120}?getComputedStyle\(element\)\.visibility === 'hidden';/, 'a control with no layout box or no computed visibility is marked hidden');
  assert.match(source, /\.\.\.\(hidden \? \{ hidden: true \} : \{\}\),/, 'the hidden mark travels with the enumerated control');
  assert.match(
    source,
    /\.\.\.grouped\.filter\(item => !item\.hidden\),[\s\S]{0,120}?\.\.\.grouped\.filter\(item => item\.hidden\),/,
    'visible controls are queued before hidden ones so a disclosure runs before the content it reveals',
  );
});

test('coverage-gap counters accumulate across later, smaller enumerations', () => {  const first = mergeRenderedCoverageGapCounters(
    { structuralNavigation: 0, structuralHintRejected: 0, iconLabelRecovered: 0 },
    { structuralNavigation: 0, structuralHintRejected: 0, iconLabelRecovered: 1 },
  );
  assert.deepEqual(first, { structuralNavigation: 0, structuralHintRejected: 0, iconLabelRecovered: 1 });
  const second = mergeRenderedCoverageGapCounters(first, {
    structuralNavigation: 1, structuralHintRejected: 1, iconLabelRecovered: 0,
  });
  assert.deepEqual(
    second,
    { structuralNavigation: 1, structuralHintRejected: 1, iconLabelRecovered: 1 },
    'a menu trigger revealed by a click is counted even though the refreshed set is smaller',
  );
});

test('popup coverage tracks identities so a replacement cannot be cancelled by a prior click', () => {
  const tracked = trackRenderedPopupCoverage(new Set<string>(), { popupMarkers: ['popup-a'] });
  assert.equal(
    resolveUnexaminedPopupTargets(tracked, new Set(['popup-a'])),
    0,
    'an inline-examined popup is not a coverage gap',
  );
  // Clicking popup A replaces it with a hint-rejected popup B. B has its own
  // marker, so A's click cannot cancel B out even in a same-sized snapshot.
  const replacement = trackRenderedPopupCoverage(tracked, { popupMarkers: ['popup-b'] });
  assert.equal(
    resolveUnexaminedPopupTargets(replacement, new Set(['popup-a'])),
    1,
    'a hint-rejected replacement popup remains unexamined even though the old popup was clicked',
  );
});

test('a retried request replaces its previous-attempt counters instead of double counting', () => {
  const attempt = (enumerated: number, popupCount: number): RenderedRequestControlTotals => ({
    enumerated,
    hintRejected: 1,
    structuralNavigation: 2,
    structuralHintRejected: 1,
    structuralDisclosure: 1,
    structuralUnrecovered: 1,
    iconLabelRecovered: 1,
    popupCount,
    frameCount: 1,
    shadowRootCount: 1,
    baseHrefPresent: false,
  });
  const first = renderedRequestControlTotalsDelta(undefined, attempt(5, 2));
  assert.equal(first.enumerated, 5, 'the first attempt contributes its full observation');
  assert.equal(first.popupCount, 2);

  const retry = renderedRequestControlTotalsDelta(attempt(5, 2), attempt(5, 2));
  assert.deepEqual(retry, {
    enumerated: 0,
    hintRejected: 0,
    structuralNavigation: 0,
    structuralHintRejected: 0,
    structuralDisclosure: 0,
    structuralUnrecovered: 0,
    iconLabelRecovered: 0,
    popupCount: 0,
    frameCount: 0,
    shadowRootCount: 0,
  }, 'an identical retry adds nothing to crawl totals');

  const changed = renderedRequestControlTotalsDelta(attempt(5, 2), attempt(7, 1));
  assert.equal(changed.enumerated, 2, 'only the latest attempt delta is added');
  assert.equal(changed.popupCount, -1, 'an examined popup adjusts the previous contribution downward');
});

test('label recovery stays bounded before allocating id lists or subtree text', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /labelledBy\.split\(/, 'the whole aria-labelledby attribute is never split into an id array');
  assert.match(source, /idCount < 16/, 'at most 16 id tokens are extracted');
  assert.doesNotMatch(source, /labelNode\?\.textContent/, 'a referenced subtree is never materialized as full text');
  assert.match(source, /document\.createTreeWalker\(labelNode, NodeFilter\.SHOW_TEXT\)/, 'referenced labels are walked as bounded text nodes');
  assert.match(source, /visitedLabelNodes < 512/, 'the text walk has a fixed node ceiling');
  assert.match(source, /labelledByText\.length < 200/, 'collection stops at 200 characters');
  assert.match(source, /labelledByText \+= pendingSeparator \+ \(text\.length > remaining \? text\.slice\(0, remaining\) : text\)/, 'adjacent text nodes concatenate without splitting a word');
  assert.match(source, /let pendingSeparator = labelledByText\.length > 0 \? ' ' : '';/, 'a separator is added once per referenced label');
  assert.match(source, /hiddenText \+= value\.length > remaining \? value\.slice\(0, remaining\) : value;/, 'descendant text nodes concatenate without splitting a word');
});

test('a clicked destination that its own request inspects is not counted twice', () => {
  const observations = new Map([
    ['https://creator.example/community', { frameCount: 2, shadowRootCount: 1, baseHrefPresent: false }],
    ['https://creator.example/landing', { frameCount: 1, shadowRootCount: 0, baseHrefPresent: true }],
  ]);
  const inspected = new Set(['https://creator.example/community']);
  const reconciled = reconcileClickDestinationContext({ observations, inspectedKeys: inspected });
  assert.equal(reconciled.frameCount, 1, 'the admitted destination is counted by its own request, not by the click');
  assert.equal(reconciled.shadowRootCount, 0, 'the admitted destination cannot inflate shadow-root totals');
  assert.equal(reconciled.baseHrefPresent, true, 'the click-only destination still contributes its base href');
  assert.deepEqual(
    reconcileClickDestinationContext({ observations, inspectedKeys: new Set() }),
    { frameCount: 3, shadowRootCount: 1, baseHrefPresent: true },
    'every observation counts when no request inspected the destination',
  );
  assert.deepEqual(
    reconcileClickDestinationContext({ observations, inspectedKeys: new Set(observations.keys()) }),
    { frameCount: 0, shadowRootCount: 0, baseHrefPresent: false },
    'a fully inspected destination set leaves nothing to add',
  );
});

test('a retried request clears its own uncertified click window', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.match(source, /uncertifiedRequestKeys\.delete\(request\.url\)/, 'a fresh attempt clears the request mark before re-examining');
  assert.match(source, /if \(pageClickWindowPending\) uncertifiedRequestKeys\.add\(request\.url\)/, 'a pending window is certified per request, not crawl-wide');
  assert.match(source, /telemetry\.evidenceControlsUncertified = \(evidenceControlsUncertified \|\| uncertifiedRequestKeys\.size > 0\)/, 'the published certificate reflects the remaining per-request marks');
});

test('popup coverage counts each popup once and keeps window-opening popups unexamined', () => {
  let tracked = new Set<string>();
  // The same static popup is observed on every scroll/enumeration pass.
  tracked = trackRenderedPopupCoverage(tracked, { popupMarkers: ['popup-a'] });
  tracked = trackRenderedPopupCoverage(tracked, { popupMarkers: ['popup-a'] });
  assert.equal(tracked.size, 1, 're-observation does not duplicate the popup identity');
  assert.equal(
    resolveUnexaminedPopupTargets(tracked, new Set()),
    1,
    'a click that opened a new window did not examine the popup',
  );
  assert.equal(
    resolveUnexaminedPopupTargets(tracked, new Set(['popup-a'])),
    0,
    'an inline click examines the matched popup',
  );
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
