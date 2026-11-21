import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchChannelAboutViaInnertube,
  resetInnertubeCooldownForTests,
  resetInnertubePacingForTests,
  setInnertubeEmitSinkForTests,
  setInnertubeSessionFactoryForTests,
} from './youtubeInnertubeProvider';

test('InnerTube About fallback returns creator bio and links without official quota', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ videos: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
    getChannel: async () => ({
      getAbout: async () => ({
        metadata: {
          description: 'NQ futures trader. Live execution and risk management.',
          links: ['https://example.com/string', { url: 'https://example.com/url' }, { target: 'https://example.com/target' }, { canonical_url: 'https://example.com/canonical' }],
          subscriber_count: '12.3K subscribers',
          country: 'US',
        },
      }),
    }),
  }) as any);
  try {
    const about = await fetchChannelAboutViaInnertube('UC1234567890123456789012');
    assert.equal(about.status, 'AVAILABLE');
    assert.match(about.description || '', /NQ futures trader/);
    assert.deepEqual(about.links, [
      'https://example.com/string',
      'https://example.com/url',
      'https://example.com/target',
      'https://example.com/canonical',
    ]);
    assert.equal(about.subscriberCount, '12.3K subscribers');
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
  }
});

test('InnerTube About fallback reports authoritative empty separately from failure', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeEmitSinkForTests(async () => undefined);
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ videos: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
    getChannel: async () => ({ getAbout: async () => ({ metadata: { links: [] } }) }),
  }) as any);
  try {
    const empty = await fetchChannelAboutViaInnertube('UC1234567890123456789012');
    assert.equal(empty.status, 'AUTHORITATIVE_EMPTY');

    setInnertubeSessionFactoryForTests(async () => ({
      search: async () => ({ videos: [] }),
      getBasicInfo: async () => ({ basic_info: {} }),
      getChannel: async () => ({
        getAbout: async () => ({ metadata: { links: [], subscriber_count: '42 subscribers' } }),
      }),
    }) as any);
    const subscriberOnly = await fetchChannelAboutViaInnertube('UC1234567890123456789012');
    assert.equal(subscriberOnly.status, 'AVAILABLE');
    assert.equal(subscriberOnly.subscriberCount, '42 subscribers');
  } finally {
    setInnertubeSessionFactoryForTests(null);
    setInnertubeEmitSinkForTests(null);
  }
});
