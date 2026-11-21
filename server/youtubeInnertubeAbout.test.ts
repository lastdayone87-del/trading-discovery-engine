import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchChannelAboutViaInnertube,
  resetInnertubeCooldownForTests,
  resetInnertubePacingForTests,
  setInnertubeSessionFactoryForTests,
} from './youtubeInnertubeProvider';

test('InnerTube About fallback returns creator bio and links without official quota', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ videos: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
    getChannel: async () => ({
      getAbout: async () => ({
        metadata: {
          description: 'NQ futures trader. Live execution and risk management.',
          links: [{ link: 'https://example.com/trader' }],
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
    assert.deepEqual(about.links, ['https://example.com/trader']);
    assert.equal(about.subscriberCount, '12.3K subscribers');
  } finally {
    setInnertubeSessionFactoryForTests(null);
  }
});

test('InnerTube About fallback reports authoritative empty separately from failure', async () => {
  resetInnertubeCooldownForTests();
  resetInnertubePacingForTests();
  setInnertubeSessionFactoryForTests(async () => ({
    search: async () => ({ videos: [] }),
    getBasicInfo: async () => ({ basic_info: {} }),
    getChannel: async () => ({ getAbout: async () => ({ metadata: { links: [] } }) }),
  }) as any);
  try {
    const empty = await fetchChannelAboutViaInnertube('UC1234567890123456789012');
    assert.equal(empty.status, 'AUTHORITATIVE_EMPTY');
  } finally {
    setInnertubeSessionFactoryForTests(null);
  }
});
