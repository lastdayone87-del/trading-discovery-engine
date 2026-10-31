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
import { DEFAULT_BROWSER_FALLBACK_BUDGET, MAX_RENDERED_CROSS_ORIGIN_ENQUEUES, combineRenderedControlOffsetAdvances, isNavigableOnlyControlWindow, isSameSeedDocument, isUnrecoveredStructuralNavigation, planRenderedCrossOriginEnqueues, planRevealedRenderedClickTargets, planRevealedSameOriginEnqueues, partitionRenderedClickTargets, remainingRenderedClickBudget, renderedClickOffsetAdvance, resolveRenderedCompletionState, runRenderedClickLoop, shouldEnqueueRenderedCrossOriginLink, type RenderedControlEnumeration } from './browserCommunityFallback';
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
  iconLabelRecovered: 0,
  popupTargets: 0,
  opaqueInteractiveControls: 0,
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

test('revealed same-origin planner admits only post-interaction generic links', () => {
  const currentUrl = 'https://creator.example/';
  const plan = planRevealedSameOriginEnqueues({
    candidates: [
      { url: 'https://creator.example/resources', text: 'Resources' },
      { url: 'https://creator.example/community', text: 'Community' },
      { url: 'https://creator.example/about', text: 'About' },
      { url: 'https://other.example/room', text: 'Room' },
    ],
    currentUrl,
    initialLinks: new Set(['https://creator.example/about']),
    alreadyVisited: new Set(),
    queued: new Set(),
  });
  assert.deepEqual(plan.admitted, ['https://creator.example/resources'],
    'only a newly revealed, admissible, non-hint same-origin link is admitted');
  assert.equal(plan.hintHandled, 1, 'hint-bearing links stay owned by the existing same-host pass');

  const capped = planRevealedSameOriginEnqueues({
    candidates: [
      { url: 'https://creator.example/resources', text: 'Resources' },
      { url: 'https://creator.example/support', text: 'Support' },
      { url: 'https://creator.example/explore', text: 'Explore' },
    ],
    currentUrl,
    initialLinks: new Set(),
    alreadyVisited: new Set(),
    queued: new Set(),
    maxEnqueues: 2,
  });
  assert.equal(capped.admitted.length, 2);
  assert.equal(capped.budget, 1, 'revealed-link overflow is counted, never silently discarded');
});

test('cross-origin planner carries visible anchor text for generic paths', () => {
  const currentUrl = 'https://creator.example/';
  const admitted = planRenderedCrossOriginEnqueues({
    candidates: [{ url: 'https://community.example/go', text: 'Join the private members community' }],
    currentUrl,
    alreadyVisited: new Set(),
    queued: new Set(),
  });
  assert.deepEqual(admitted.admitted, ['https://community.example/go']);
  assert.equal(admitted.irrelevant, 0);

  const noLabel = planRenderedCrossOriginEnqueues({
    candidates: [{ url: 'https://community.example/go', text: '' }],
    currentUrl,
    alreadyVisited: new Set(),
    queued: new Set(),
  });
  assert.deepEqual(noLabel.admitted, [], 'a generic path with no visible label is not admitted');
  assert.equal(noLabel.irrelevant, 1, 'an unrelated outbound link is diagnostic, never a coverage exclusion');
  assert.equal(noLabel.admissionRejected, 0);
  assert.equal(noLabel.budget, 0);
});

test('cross-origin planner deduplicates, skips visited, and enforces the cap', () => {
  const currentUrl = 'https://creator.example/';
  const plan = planRenderedCrossOriginEnqueues({
    candidates: [
      { url: 'https://linktr.ee/creator', text: 'Links' },
      { url: 'https://linktr.ee/creator', text: 'Links again' },
      { url: 'https://seen.example/join', text: 'Join the community' },
      { url: 'https://linktr.ee/other', text: 'Links' },
      { url: 'https://linktr.ee/third', text: 'Links' },
      { url: 'https://linktr.ee/fourth', text: 'Links' },
    ],
    currentUrl,
    alreadyVisited: new Set(['https://seen.example/join']),
    queued: new Set(),
    maxEnqueues: 2,
  });
  assert.deepEqual(plan.admitted, ['https://linktr.ee/creator', 'https://linktr.ee/other']);
  assert.equal(plan.alreadyVisited, 1);
  assert.equal(plan.duplicate, 1);
  assert.equal(plan.budget, 2);

  const terminal = planRenderedCrossOriginEnqueues({
    candidates: [{ url: 'https://discord.gg/Abc123', text: 'Discord' }],
    currentUrl: 'https://creator.example/',
    alreadyVisited: new Set(),
    queued: new Set(),
  });
  assert.equal(terminal.discordDestinations, 1);
  assert.equal(terminal.irrelevant, 0, 'Discord is a terminal invite candidate, not a policy exclusion');
  assert.equal(terminal.admissionRejected, 0);

  const rejected = planRenderedCrossOriginEnqueues({
    candidates: [
      { url: 'http://127.0.0.1/private', text: 'Join the private community' },
      { url: 'https://outside.test/privacy', text: 'Privacy policy' },
    ],
    currentUrl: 'https://creator.example/',
    alreadyVisited: new Set(),
    queued: new Set(),
  });
  assert.equal(rejected.admissionRejected, 1, 'format/security rejections are not eligible destinations');
  assert.equal(rejected.irrelevant, 1, 'an unrelated vendor link is not an eligible destination');
  assert.equal(rejected.budget, 0);
});

test('cross-origin rendered enqueue stays policy- and budget-bounded', () => {
  const currentUrl = 'https://creator.example/';
  assert.equal(MAX_RENDERED_CROSS_ORIGIN_ENQUEUES, 3, 'the crawl-wide cap stays small');
  assert.equal(DEFAULT_BROWSER_FALLBACK_BUDGET.crossOriginEnqueue, undefined, 'P1.6 is opt-in and default OFF');
  assert.equal(
    shouldEnqueueRenderedCrossOriginLink({
      url: 'https://creator.example/community',
      currentUrl,
      anchorText: 'Join the community',
    }),
    false,
    'same-origin links stay on the existing same-host hint pass',
  );
  assert.equal(
    shouldEnqueueRenderedCrossOriginLink({
      url: 'https://linktr.ee/creator',
      currentUrl,
      anchorText: 'Links',
    }),
    true,
    'known link-hub hosts are admitted by the shared destination policy',
  );
  assert.equal(
    shouldEnqueueRenderedCrossOriginLink({
      url: 'https://community.example/join',
      currentUrl,
      anchorText: 'Join the private members community',
    }),
    true,
    'strong community evidence can open an unknown host',
  );
  assert.equal(
    shouldEnqueueRenderedCrossOriginLink({
      url: 'https://random.example/about',
      currentUrl,
      anchorText: 'About',
    }),
    false,
    'weak generic labels never open an unknown host',
  );
  assert.equal(
    shouldEnqueueRenderedCrossOriginLink({
      url: 'https://discord.gg/Abc123',
      currentUrl,
      anchorText: 'Discord',
    }),
    false,
    'Discord destinations are invite candidates, not page-budget targets',
  );
  assert.equal(
    shouldEnqueueRenderedCrossOriginLink({
      url: 'https://169.254.169.254/latest/meta-data/',
      currentUrl,
      anchorText: 'Join the community',
    }),
    false,
    'admission-rejected destinations are never enqueued',
  );
  assert.equal(
    shouldEnqueueRenderedCrossOriginLink({ url: 'not a url', currentUrl, anchorText: 'join' }),
    false,
  );
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
  assert.match(source, /if \(requiredCovered && !interactionGap && !coverageGap\) return \{outcome:'INSPECTED_NO_MATCH'\};/);
  assert.match(source, /if\(rendered\.complete&&renderedProcessed&&!interactionGap&&!coverageGap&&!gap\)return\{outcome:'INSPECTED_NO_MATCH'\};/);
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

test('interaction-revealed links are captured per click and context counters refresh after interactions', () => {
  const source = readFileSync(fileURLToPath(new URL('./browserCommunityFallback.ts', import.meta.url)), 'utf8');
  assert.match(
    source,
    /click: async control => \{[\s\S]*?await captureRevealedSameOrigin\(\);[\s\S]*?return clickOutcome\.ok;/,
    'new same-origin destinations are captured after every click, before the next click can replace them',
  );
  assert.match(
    source,
    /await captureRevealedSameOrigin\(\);\s*if \(revealedScanFailed\)/,
    'the post-loop pass captures scroll-revealed links and reports a failed scan as a gap',
  );
  assert.match(source, /const linkBaselines = new Map<string, Set<string>>\(\)/);
  assert.match(source, /baselineKey = documentBaselineKey\(identity, currentUrl\)/, 'link comparisons are scoped to the current document identity');
  assert.match(source, /if \(!baseline\) \{[\s\S]*?linkBaselines\.set\(baselineKey, baseline\);[\s\S]*?return;/, 'a clicked-to document establishes its own static baseline');
  assert.match(source, /await recordPageContext\(\);\s*await recordDeclarativeShadowScan\(\);/, 'context counters refresh after the click loop');
  assert.match(source, /await recordPageContext\(\);/, 'context counters also refresh after scrolling');
  assert.match(
    source,
    /declarativeScan\.closedRoots\) \|\| 0\) - lastDeclarativeClosedRoots/,
    'declarative-root re-reads add only the delta, never double count',
  );
  assert.match(source, /pageContextByDocument\.set\(\s*key,\s*mergeRenderedPageContextCounts/, 'live context counters are maxed per document');
  assert.doesNotMatch(
    source,
    /isSameSeedDocument\(pageDocumentIdentity, currentIdentity, pageDocumentUrl, currentUrl\)/,
    'a click-navigated document is recorded instead of being dropped by the original-document guard',
  );
  assert.match(
    source,
    /await attemptRenderedControlClick[\s\S]{0,1600}?await recordPageContext\(\);/,
    'each click captures the document it navigated to before the next click',
  );
  assert.match(source, /retain\(popupUrl, openerUrl\)/, 'a direct Discord popup URL is retained as terminal evidence');
  assert.match(
    source,
    /classifyRenderedPopupDestination\(popupUrl, openerUrl\)/,
    'popup origin is resolved against the opener URL captured when the popup was observed',
  );
  assert.match(
    source,
    /isDiscordDestinationUrl\(popupUrl\) && extractDiscordCandidates\(popupUrl\)\.length > 0/,
    'only URLs with an extractable Discord invite are terminal evidence',
  );
  assert.match(
    source,
    /genericDiscordPopup = kind !== 'discord' && isDiscordDestinationUrl\(popupUrl\)/,
    'a generic Discord-host popup is inspected before being counted as unexamined',
  );
  assert.match(source, /shouldSkipPreexistingSiblingPage\(existingUrl, probe\)/, 'blank siblings are classified before being skipped');
  assert.match(source, /popupContent = await popup\.content\(\)/, 'document.write content in a blank popup is inspected before closing');
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
