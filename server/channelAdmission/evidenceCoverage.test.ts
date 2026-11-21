import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessAdmissionEvidenceCoverage,
  isProviderEvidenceFailure,
  selectKeylessFallbackEvidence,
} from './evidence';

test('boilerplate or discovery-only text never makes empty evidence complete', () => {
  const boilerplate = assessAdmissionEvidenceCoverage({
    description: 'Share your videos with friends, family, and the world',
    videos: [],
  });
  assert.equal(boilerplate.coverage, 'PARTIAL');
  assert.equal(boilerplate.evidenceSample, 'NONE');
  assert.equal(boilerplate.failureReason, 'NO_CREATOR_TEXT_AVAILABLE');

  const shortReal = assessAdmissionEvidenceCoverage({
    description: 'NQ futures trader. Live execution and risk management.',
    videos: [],
  });
  assert.equal(shortReal.coverage, 'COMPLETE');
  assert.equal(shortReal.evidenceSample, 'METADATA_ONLY');
});

test('a failed video-detail fetch is not bypassed by a bio', () => {
  const partial = assessAdmissionEvidenceCoverage({
    description: 'NQ futures trader with a complete bio.',
    videos: [{ title: 'NQ recap', description: '' }],
    detailFailure: 'quota exhausted',
  });
  assert.equal(partial.coverage, 'PARTIAL');
  assert.equal(partial.failureReason, 'FULL_DESCRIPTIONS_UNAVAILABLE:quota exhausted');
  assert.equal(isProviderEvidenceFailure(partial.failureReason), true);

  const complete = assessAdmissionEvidenceCoverage({
    description: '',
    videos: [{ title: 'NQ recap', description: 'Execution and risk.' }],
    detailFailure: 'quota exhausted',
  });
  assert.equal(complete.coverage, 'COMPLETE');
});

test('playlist-only creator evidence is complete and reaches judgment', () => {
  const playlist = assessAdmissionEvidenceCoverage({
    description: '',
    videos: [],
    playlists: [{ name: 'NQ futures trade recaps', description: 'Weekly execution reviews' }],
  });
  assert.equal(playlist.coverage, 'COMPLETE');
  assert.equal(playlist.evidenceSample, 'PLAYLIST_SAMPLE');
});

test('provider failures stay retryable when no creator evidence was acquired', () => {
  const unavailable = assessAdmissionEvidenceCoverage({
    description: '',
    videos: [],
    acquisitionFailure: 'INNERTUBE_ABOUT_RATE_LIMITED:429',
  });
  assert.equal(unavailable.coverage, 'PARTIAL');
  assert.match(unavailable.failureReason || '', /^PROVIDER_EVIDENCE_UNAVAILABLE:/);
  assert.equal(isProviderEvidenceFailure(unavailable.failureReason), true);
});

test('keyless outage fallback accepts only recovered creator evidence', () => {
  const nothing = selectKeylessFallbackEvidence({
    aboutBio: 'Share your videos with friends, family, and the world',
    innertubeBio: '',
  });
  assert.equal(nothing.usable, false);
  assert.equal(nothing.description, '');

  const bio = selectKeylessFallbackEvidence({
    innertubeBio: 'NQ futures trader. Live execution and risk management.',
    innertubeLinks: ['https://example.com/trader'],
    innertubeSubscriberCount: '12.3K subscribers',
  });
  assert.equal(bio.usable, true);
  assert.match(bio.description, /NQ futures trader/);
  assert.deepEqual(bio.addedLinks, ['https://example.com/trader']);
  assert.equal(bio.subscriberCount, '12.3K subscribers');
});
