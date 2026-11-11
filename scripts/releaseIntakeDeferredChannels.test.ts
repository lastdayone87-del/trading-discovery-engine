import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReleaseCandidate,
  classifyDeferredRelease,
  releaseIdempotencyKey,
  type DeferredChannelRow,
} from './releaseIntakeDeferredChannels';

function row(overrides: Partial<DeferredChannelRow> = {}): DeferredChannelRow {
  return {
    channel_id: 'UC_release',
    channel_name: 'Release Test',
    youtube_url: 'https://youtube.com/channel/UC_release',
    country: 'India',
    country_status: 'LIKELY',
    scan_status: 'INTAKE_DEFERRED',
    trading_status: 'UNCERTAIN',
    inspection_trail: [],
    ...overrides,
  };
}

test('release candidate prefers job evidence, then nomination evidence, then channel row', () => {
  const fromJob = buildReleaseCandidate(row({
    enrich_payload: {
      targetCountry: 'India',
      source: 'automated_query',
      candidate: { channelName: 'Job', description: 'job bio', videoTitles: ['one'] },
    },
    nomination_raw_observation: { channelName: 'Nomination' },
  }));
  assert.equal(fromJob.evidenceSource, 'JOB');
  assert.equal(fromJob.candidate.channelName, 'Job');
  assert.equal(fromJob.targetCountry, 'India');

  const fromNomination = buildReleaseCandidate(row({
    nomination_raw_observation: { channelName: 'Nomination', description: 'nomination bio' },
    nomination_matched_document: { type: 'VIDEO', title: 'Matched' },
    nomination_country: 'India',
    nomination_source_type: 'automated_query',
  }));
  assert.equal(fromNomination.evidenceSource, 'NOMINATION');
  assert.equal(fromNomination.candidate.channelName, 'Nomination');
  assert.equal((fromNomination.candidate.matchedDocument as any)?.title, 'Matched');

  const fromChannel = buildReleaseCandidate(row());
  assert.equal(fromChannel.evidenceSource, 'CHANNEL_ROW');
  assert.equal(fromChannel.candidate.channelId, 'UC_release');
  assert.equal(fromChannel.candidate.youtubeUrl, row().youtube_url);
});

test('release eligibility keeps confirmed exclusions out and sends likely exclusions to review', () => {
  const exclusions = [{ country_name: 'Germany', reason: 'policy' }];
  assert.equal(classifyDeferredRelease(row({ country: 'Germany', country_status: 'CONFIRMED' }), exclusions).disposition, 'EXCLUDED');
  assert.equal(classifyDeferredRelease(row({ country: 'DE', country_status: 'CONFIRMED' }), exclusions).disposition, 'EXCLUDED');
  assert.equal(classifyDeferredRelease(row({ country: 'Germany', country_status: 'LIKELY' }), exclusions).disposition, 'REVIEW');
  assert.equal(classifyDeferredRelease(row({ country_status: 'REJECTED' }), exclusions).disposition, 'EXCLUDED');
  assert.equal(classifyDeferredRelease(row(), exclusions).disposition, 'RELEASE');
  assert.equal(classifyDeferredRelease(row({ scan_status: 'ENRICHMENT_PENDING' }), exclusions).disposition, 'SKIP');
});

test('release idempotency key is channel-versioned', () => {
  assert.equal(releaseIdempotencyKey('UC1'), 'intake-release:UC1:v1');
  assert.notEqual(releaseIdempotencyKey('UC1'), releaseIdempotencyKey('UC2'));
});
