import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPublicAboutToCandidate,
  isChannelDescriptionInsufficient,
  parseYouTubeChannelAboutFromHtml,
  shouldAttemptPublicAboutCountryFallback,
  fetchLiveYouTubeChannelData,
  youtubeChannelAboutUrl
} from './youtubePublicAbout';
import { MAX_CRAWL_RESPONSE_CHARS } from './crawlResponseBounds';
import { inferChannelCountry } from './countryInference';

/** Mirrors creatorLevelCountryEvidence About wiring without importing db-backed validator. */
function aboutEvidence(channelName: string, description: string) {
  return {
    channelName,
    aboutBio: description || '',
    videoTitles: [] as string[]
  };
}

const PH_EXCLUSIONS = [{ country_name: 'Philippines', reason: 'test exclusion' }];

test('isChannelDescriptionInsufficient treats empty and short text as insufficient', () => {
  assert.equal(isChannelDescriptionInsufficient(''), true);
  assert.equal(isChannelDescriptionInsufficient('short'), true);
  assert.equal(isChannelDescriptionInsufficient('Based in the Philippines trading forex daily'), false);
});

test('E: AVAILABLE_DECLARED does not attempt public About fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_DECLARED',
      description: ''
    }),
    false
  );
});

test('E: AVAILABLE_NOT_DECLARED with usable description does not attempt fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
      description: 'Long enough channel about text without needing public scrape'
    }),
    false
  );
});

test('AVAILABLE_NOT_DECLARED with empty description attempts bounded About fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
      description: ''
    }),
    true
  );
});

test('publicAboutAttempted = true prevents repeated About fallback attempts', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'AVAILABLE_NOT_DECLARED',
      description: '',
      publicAboutAttempted: true
    }),
    false
  );
});

test('A/D condition: UNAVAILABLE + UNCERTAIN + empty description attempts fallback', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'UNCERTAIN',
      countryMetadataStatus: 'UNAVAILABLE',
      description: ''
    }),
    true
  );
});

test('fallback is not attempted when country is already REJECTED or CONFIRMED', () => {
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'REJECTED',
      countryMetadataStatus: 'UNAVAILABLE',
      description: ''
    }),
    false
  );
  assert.equal(
    shouldAttemptPublicAboutCountryFallback({
      countryStatus: 'CONFIRMED',
      countryMetadataStatus: 'UNAVAILABLE',
      description: ''
    }),
    false
  );
});

test('G: parse ytInitialData About containing Philippines', () => {
  const html = `<html><script>ytInitialData = ${JSON.stringify({
    metadata: {
      channelMetadataRenderer: {
        description: 'Based in the Philippines. Daily forex analysis.'
      }
    }
  })};</script></html>`;
  const parsed = parseYouTubeChannelAboutFromHtml(html);
  assert.match(parsed.bio || '', /Philippines/i);
});

test('G/A/C/E: literal Philippines in About produces CHANNEL_ABOUT_BIO and REJECTED over UK discovery', () => {
  const result = inferChannelCountry(
    { ...aboutEvidence('PH Trader', 'Based in the Philippines'), discoveryCountry: 'United Kingdom' },
    PH_EXCLUSIONS
  );
  assert.equal(result.detectedCountry, 'Philippines');
  assert.equal(result.detectedCreatorCountry, 'Philippines');
  assert.equal(result.discoveryCountry, 'United Kingdom');
  assert.equal(result.status, 'REJECTED');
  const about = result.evidence.find(item => item.source === 'CHANNEL_ABOUT_BIO');
  assert.ok(about);
  assert.equal(about!.priority, 2);
  assert.ok(result.evidence.some(item => item.source === 'DISCOVERY_CONTEXT' && item.priority === 10));
});

test('B: About without country signals remains UNCERTAIN on discovery context with null creator country', () => {
  const result = inferChannelCountry(
    {
      ...aboutEvidence(
        'Generic Trader',
        'Daily charts and risk management tips for swing traders worldwide.'
      ),
      discoveryCountry: 'United Kingdom'
    },
    PH_EXCLUSIONS
  );
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.detectedCreatorCountry, null);
  assert.equal(result.detectedCountry, null);
  assert.equal(result.discoveryCountry, 'United Kingdom');
});

test('D: failed public About fetch is soft-fail (no description applied)', async () => {
  const candidate = { description: '', channelLinks: [] as string[] };
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    async () => new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/html' } })
  );
  assert.equal(live, null);
  assert.equal(applyPublicAboutToCandidate(candidate, live), false);
  assert.equal(candidate.description, '');
});

test('D: network error soft-fails to null', async () => {
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    async () => {
      throw new Error('network down');
    }
  );
  assert.equal(live, null);
});

test('D: About acquisition requests the /about tab and preserves scheme-less links', async () => {
  const requested: string[] = [];
  const aboutHtml = `<script>var ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { description: 'BigShort bio' } },
    links: [{ channelExternalLinkViewModel: { link: { content: 'bigshort.com' } } }]
  })};</script>`;
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(aboutHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch
  );
  assert.deepEqual(requested, [
    'https://www.youtube.com/channel/UC_test/about',
    'https://www.youtube.com/channel/UC_test'
  ]);
  assert.equal(live?.bio, 'BigShort bio');
  assert.ok(live?.channelLinks?.includes('bigshort.com'));
});

test('D: About tab without a bio merges both link sets and keeps the root bio', async () => {
  const requested: string[] = [];
  const aboutHtml = `<script>var ytInitialData = ${JSON.stringify({
    links: [{ channelExternalLinkViewModel: { link: { content: 'about-only.example' } } }]
  })};</script>`;
  const rootHtml = `<script>var ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { description: 'Root bio' } },
    links: [{ channelExternalLinkViewModel: { link: { content: 'root.example' } } }]
  })};</script>`;
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      return new Response(url.endsWith('/about') ? aboutHtml : rootHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      });
    }) as typeof fetch
  );
  assert.deepEqual(requested, [
    'https://www.youtube.com/channel/UC_test/about',
    'https://www.youtube.com/channel/UC_test'
  ]);
  assert.equal(live?.bio, 'Root bio');
  assert.ok(live?.channelLinks?.includes('about-only.example'));
  assert.ok(live?.channelLinks?.includes('root.example'));
});

test('D: an About bio never suppresses root-only header links', async () => {
  const aboutHtml = `<script>var ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { description: 'About bio' } },
    links: [{ channelExternalLinkViewModel: { link: { content: 'about.example' } } }]
  })};</script>`;
  const rootHtml = `<script>var ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { description: 'Root bio' } },
    links: [{ channelExternalLinkViewModel: { link: { content: 'root-only.example' } } }]
  })};</script>`;
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    (async (input: RequestInfo | URL) =>
      new Response(String(input).endsWith('/about') ? aboutHtml : rootHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as typeof fetch
  );
  assert.equal(live?.bio, 'About bio');
  assert.ok(live?.channelLinks?.includes('about.example'));
  assert.ok(live?.channelLinks?.includes('root-only.example'));
});

test('D: debug HTML and fetch log follow the surface that supplied the bio', async () => {
  const aboutHtml = `<script>var ytInitialData = ${JSON.stringify({
    links: [{ channelExternalLinkViewModel: { link: { content: 'about.example' } } }]
  })};</script>`;
  const rootHtml = `<script>var ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { description: 'Root bio' } }
  })};</script>`;
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    true,
    (async (input: RequestInfo | URL) =>
      new Response(String(input).endsWith('/about') ? aboutHtml : rootHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as typeof fetch
  );
  assert.equal(live?.bio, 'Root bio');
  assert.doesNotMatch(live?.fetchLog || '', /\/about/, 'fetch log must not describe the About page when the root supplied the bio');
  assert.match(live?.rawHtml || '', /Root bio/);
});

test('D: a truncated About response keeps coverage incomplete after the root merge', async () => {
  const aboutHtml = `<html><body>${'x'.repeat(MAX_CRAWL_RESPONSE_CHARS + 5_000)}</body></html>`;
  const rootHtml = `<script>var ytInitialData = ${JSON.stringify({
    metadata: { channelMetadataRenderer: { description: 'Root bio' } }
  })};</script>`;
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    (async (input: RequestInfo | URL) =>
      new Response(String(input).endsWith('/about') ? aboutHtml : rootHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as typeof fetch
  );
  assert.equal(live?.bio, 'Root bio');
  assert.equal(live?.truncated, true);
});

test('D: About URL helper appends to the pathname without swallowing query or fragment', () => {
  assert.equal(
    youtubeChannelAboutUrl('https://www.youtube.com/@creator?si=abc'),
    'https://www.youtube.com/@creator/about?si=abc'
  );
  assert.equal(
    youtubeChannelAboutUrl('https://www.youtube.com/channel/UC_test/about?si=abc'),
    'https://www.youtube.com/channel/UC_test/about?si=abc'
  );
  assert.equal(
    youtubeChannelAboutUrl('https://www.youtube.com/channel/UC_test#bio'),
    'https://www.youtube.com/channel/UC_test/about#bio'
  );
});

test('applyPublicAboutToCandidate sets description from bio for Gate 1 re-validation', () => {
  const candidate = { description: '', channelLinks: [] as string[] };
  assert.equal(
    applyPublicAboutToCandidate(candidate, {
      bio: 'Based in the Philippines',
      channelLinks: ['https://twitter.com/x']
    }),
    true
  );
  assert.equal(candidate.description, 'Based in the Philippines');
  assert.deepEqual(candidate.channelLinks, ['https://twitter.com/x']);
});

test('parse falls back to og:description when ytInitialData missing', () => {
  const html =
    '<html><head><meta name="description" content="Trader from the Philippines" /></head><body></body></html>';
  const parsed = parseYouTubeChannelAboutFromHtml(html);
  assert.match(parsed.bio || '', /Philippines/i);
});

test('parses subscriber count from the About ytInitialData view model', () => {
  const html = `<script>var ytInitialData = ${JSON.stringify({
    metadata: {
      channelMetadataRenderer: { description: 'Jarvis Trading bio' },
    },
    contents: [{
      aboutChannelRenderer: {
        metadata: {
          aboutChannelViewModel: {
            subscriberCountText: '5 subscribers',
            viewCountText: '251 views',
          },
        },
      },
    }],
  })};</script>`;
  const parsed = parseYouTubeChannelAboutFromHtml(html);
  assert.equal(parsed.subscriberCountText, '5 subscribers');
  assert.equal(parsed.bio, 'Jarvis Trading bio');
});

test('parses subscriber count from the channel-root metadata parts', () => {
  const html = `<script>var ytInitialData = ${JSON.stringify({
    header: {
      pageHeaderRenderer: {
        metadataParts: [
          { text: { content: '10 subscribers' }, accessibilityLabel: '10 subscribers' },
          { text: { content: '11 videos' } },
        ],
      },
    },
  })};</script>`;
  const parsed = parseYouTubeChannelAboutFromHtml(html);
  assert.equal(parsed.subscriberCountText, '10 subscribers');
});

test('parses subscriber count from YouTube simpleText shapes', () => {
  const aboutHtml = `<script>var ytInitialData = ${JSON.stringify({
    aboutChannelRenderer: {
      metadata: { aboutChannelViewModel: { subscriberCountText: { simpleText: '5 subscribers' } } },
    },
  })};</script>`;
  assert.equal(parseYouTubeChannelAboutFromHtml(aboutHtml).subscriberCountText, '5 subscribers');

  const rootHtml = `<script>var ytInitialData = ${JSON.stringify({
    header: { pageHeaderRenderer: { metadataParts: [{ text: { simpleText: '10 subscribers' } }] } },
  })};</script>`;
  assert.equal(parseYouTubeChannelAboutFromHtml(rootHtml).subscriberCountText, '10 subscribers');
});

test('never stores a handle or digit-free text as a public subscriber count', () => {
  for (const text of ['@JarvisTrading', 'subscribers', 'No subscribers']) {
    const html = `<script>var ytInitialData = ${JSON.stringify({
      aboutChannelRenderer: { metadata: { aboutChannelViewModel: { subscriberCountText: text } } },
    })};</script>`;
    assert.equal(parseYouTubeChannelAboutFromHtml(html).subscriberCountText, undefined, text);
  }
});

test('About page subscriber count is merged across both surfaces', async () => {
  const aboutHtml = `<script>var ytInitialData = ${JSON.stringify({
    contents: [{ aboutChannelRenderer: { metadata: { aboutChannelViewModel: { subscriberCountText: '10 subscribers' } } } }],
  })};</script>`;
  const rootHtml = `<script>var ytInitialData = ${JSON.stringify({
    header: { pageHeaderRenderer: { metadataParts: [{ text: { content: '999 subscribers' } }] } },
  })};</script>`;
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(url.endsWith('/about') ? aboutHtml : rootHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch
  );
  assert.equal(live?.subscriberCountText, '10 subscribers');
});

test('applyPublicAboutToCandidate applies a subscriber count without a bio', () => {
  const candidate = { description: '', subscriberCount: undefined as string | undefined };
  assert.equal(
    applyPublicAboutToCandidate(candidate, { subscriberCountText: '5 subscribers' }),
    true
  );
  assert.equal(candidate.subscriberCount, '5 subscribers');
  assert.equal(candidate.description, '');
  assert.equal(
    applyPublicAboutToCandidate(candidate, { subscriberCountText: '@JarvisTrading' }),
    false
  );
  assert.equal(candidate.subscriberCount, '5 subscribers');
});

test('public subscriber text never replaces an authoritative count', () => {
  const candidate = { description: '', subscriberCount: '1200' };
  assert.equal(
    applyPublicAboutToCandidate(candidate, { subscriberCountText: '1.2K subscribers' }),
    false
  );
  assert.equal(candidate.subscriberCount, '1200');

  const invalidExisting = { description: '', subscriberCount: '@JarvisTrading' };
  assert.equal(
    applyPublicAboutToCandidate(invalidExisting, { subscriberCountText: '5 subscribers' }),
    true
  );
  assert.equal(invalidExisting.subscriberCount, '5 subscribers');
});

test('a truncated count-only About page stays an incomplete acquisition', async () => {
  const aboutHtml = `<script>var ytInitialData = ${JSON.stringify({
    aboutChannelRenderer: {
      metadata: { aboutChannelViewModel: { subscriberCountText: '5 subscribers' } },
    },
  })};</script>${'x'.repeat(MAX_CRAWL_RESPONSE_CHARS + 5_000)}`;
  const rootHtml = '<html><body>no about data</body></html>';
  const live = await fetchLiveYouTubeChannelData(
    'https://www.youtube.com/channel/UC_test',
    false,
    (async (input: RequestInfo | URL) =>
      new Response(String(input).endsWith('/about') ? aboutHtml : rootHtml, {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as typeof fetch
  );
  assert.equal(live, null);
});
