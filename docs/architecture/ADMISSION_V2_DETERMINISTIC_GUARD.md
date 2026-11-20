# Deterministic recent-content guard (PR5)

## Problem

The frozen-900 baseline (PR1) showed the deterministic fast pass was confirming
channels whose creator metadata said trading but whose recent uploads were
unrelated:

- 593 `PASS`, 5 hard `UNRELATED` confirmations (5/595 = 0.84% of decisive cases).
- The five cases were welding clips, GTA clips, car builds, kids content and a
  consumer-tech how-to channel. All had a trading bio/title and a recent video
  sample that was overwhelmingly unrelated.
- `hasDecisiveTradingShare()` returned true whenever `creatorSignalsTrading()`
  found a trading name/bio, regardless of the recent video sample.
- `decisionTradingVideoIndexes()` counted keyword-only `TERMINOLOGY` hashtags
  such as `#tjrtrades`, so a GTA clip feed could look like trading coverage.

## Change

When an authoritative recent video sample exists:

- A fast pass requires substantive video support, not only a trading name/bio.
- Whole-sample `MULTI_VIDEO_CONSISTENCY` references are not counted.
  `TERMINOLOGY` counts only when the matched term appears outside hashtags/URLs,
  preserving native-language video titles while rejecting `#tjrtrades`.
- Minimum support is `min(3, ceil(videos * 0.4))` with at least 40% of the
  sample.
- Channels with no video sample keep the existing creator-signal behavior.

This is a **confirmation guard**, not a rejection rule. A blocked channel
abstains and reaches the one full AI judge.

## Frozen-900 result

| Metric | Before PR5 | After PR5 |
|---|---:|---:|
| Deterministic `PASS` | 593 | 514 |
| Deterministic `REJECT` | 2 | 2 |
| Deterministic abstain | 305 | 384 |
| Decisive coverage | 66.1% | 57.3% |
| Confirm precision | 98.65% | **99.61%** |
| Hard `UNRELATED` confirmations | 5 | **0** |
| Hard-FP rate, decisive | 0.84% | **0%** |
| Trading-relevant deterministic recall | 70.6% | 61.8% |
| Unrelated rejection recall | 6.9% | 6.9% |

The coverage reduction is deliberate: 79 channels that previously fast-passed
without substantive recent-video support now go to the one AI judge. No hard
`UNRELATED` channel is deterministically confirmed.

## What was not changed

- No global threshold lowering.
- No deterministic rejection expansion; conservative rejections stay
  conservative because the AI judge handles ambiguous unrelated channels.
- No local n-gram/embedding model was integrated. The frozen cohort is 94%
  Latin-script and the measured rule change already removes hard false
  confirmations; a local classifier remains a separate pilot with a multilingual
  blind sample.
- Structural/ecosystem signals were already present where available (playlists,
  external links, activity metadata); no unmeasured signal was added.

## Tests

- `npx tsc --noEmit`
- `npx tsx --test server/channelAdmission/admission.test.ts`
- 51/51 pass.
- Updated fast-pass tests: 3/15 trading videos no longer pass; 6/15 still pass;
  bio-only evidence retains the creator-signal path; terminology and
  whole-sample references are not counted as substantive videos.
