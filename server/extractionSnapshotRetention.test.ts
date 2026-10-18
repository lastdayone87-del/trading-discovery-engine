import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detachPageSlice } from './crawlerExtraction';

// Regression guard for page-snapshot retention across the general extraction
// helpers (the same SlicedString class PR #460 fixed for Discord candidates).
// V8 represents regexp captures over a large subject as SlicedString views, so
// any capture stored in a result array keeps the whole scanned page alive even
// after the page itself is dropped. Each helper is probed in a subprocess:
// extract from N large pages, keep only the outputs, force GC, and measure the
// retained heap. Pre-fix calibration (16 pages, ~8 MB each, captures >= 13
// chars unless noted): extractEmbeddedUrls ~128 MB, extractDynamicTargetValues
// ~128 MB, inspector extractExternalUrlsFromText ~128 MB, og-metadata captures
// ~128 MB, direct detachPageSlice captures ~128 MB, recent-video descriptions
// (16 channels x 3 watch pages) ~96 MB. Detached outputs retain ~0-8 MB for the
// same workload, so the threshold keeps a wide margin. Fixtures below V8's
// 13-char SlicedString minimum cannot observe detach removal; their comments
// say so and the direct detachPageSlice tests cover the copy itself.
function measure(script: string): { retained: number; kept: number; sample?: string; attempted?: number; acquired?: number } {
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--expose-gc', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8'
  });
  return JSON.parse(output.trim().split('\n').at(-1) || '{}');
}

const crawlerExtractionPath = fileURLToPath(new URL('./crawlerExtraction.ts', import.meta.url));
const inspectorPath = fileURLToPath(new URL('./inspector.ts', import.meta.url));
const youtubePublicAboutPath = fileURLToPath(new URL('./youtubePublicAbout.ts', import.meta.url));

const FILLER_DECL = "const filler = 'x'.repeat(4 * 1024 * 1024);";
const KEEP = 16;
const THRESHOLD = 48 * 1024 * 1024;
const WATCH_PAGES_PER_CHANNEL = 3;

// About descriptions must exceed V8's 13-char SlicedString minimum: a shorter
// capture is copied by V8 anyway, so removing the detach from the bio
// assignment would not change the measured heap.
const ABOUT_DESCRIPTION_REPEAT = 'lorem ipsum dolor sit amet consectetur ';
const aboutDescription = (i: number) => `about-description-${i} ${ABOUT_DESCRIPTION_REPEAT.repeat(10)}`;

test('detachPageSlice preserves UTF-16 code units exactly', () => {
  const cases = [
    'plain ascii https://example.com/a?b=c',
    'emoji 😀 CJK 漢字 accents éüß',
    'lone high surrogate \uD83D in metadata',
    'lone low surrogate \uDE00 in metadata',
    'mixed \uD83D a \uDC00 b \uD800',
    JSON.parse('"\\ud83d"'),
    'surrogate pair then lone high \uD83D\uDE00\uD83D'
  ];
  for (const value of cases) {
    const detached = detachPageSlice(value);
    assert.equal(detached, value, `content changed for ${JSON.stringify(value)}`);
    assert.equal(detached.length, value.length, `length changed for ${JSON.stringify(value)}`);
    for (let i = 0; i < value.length; i++) {
      assert.equal(detached.charCodeAt(i), value.charCodeAt(i), `code unit ${i} changed for ${JSON.stringify(value)}`);
    }
  }
});

test('detachPageSlice releases captured source pages', () => {
  const script = `
    const { detachPageSlice } = require(${JSON.stringify(crawlerExtractionPath)});
    ${FILLER_DECL}
    const payload = 'payload-'.repeat(60);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      const page = filler + '[capture ' + i + '] ' + payload + ' END' + filler;
      const match = page.match(/\\[capture \\d+\\] ([a-z-]+) END/);
      kept.push(detachPageSlice(match[1]));
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP);
  assert.equal(result.sample, 'payload-'.repeat(60));
  assert.ok(
    result.retained < THRESHOLD,
    `detachPageSlice retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('extractEmbeddedUrls does not pin scanned pages', () => {
  const script = `
    const { extractEmbeddedUrls } = require(${JSON.stringify(crawlerExtractionPath)});
    ${FILLER_DECL}
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      kept.push(...extractEmbeddedUrls(filler + '<a href="https://example.com/page' + i + '">link</a>' + filler));
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP);
  assert.equal(result.sample, 'https://example.com/page0');
  assert.ok(
    result.retained < THRESHOLD,
    `extractEmbeddedUrls retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('extractDynamicTargetValues does not pin scanned pages', () => {
  const script = `
    const { extractDynamicTargetValues } = require(${JSON.stringify(crawlerExtractionPath)});
    ${FILLER_DECL}
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      kept.push(...extractDynamicTargetValues(filler + '<div data-href="https://example.com/target' + i + '">x</div>' + filler));
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP);
  assert.equal(result.sample, 'https://example.com/target0');
  assert.ok(
    result.retained < THRESHOLD,
    `extractDynamicTargetValues retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('extractYouTubeVideoIds outputs are independent of scanned pages', () => {
  // 11-char ID captures are below V8's SlicedString minimum (13), so V8
  // already copies them and this test passes even if the detach is removed —
  // it cannot observe the copy. It is kept as a low-retention sanity check on
  // the extraction path (it still fails if the extractor ever returns
  // page-backed or page-length values); the direct detachPageSlice tests above
  // observe the copy itself.
  const script = `
    const { extractYouTubeVideoIds } = require(${JSON.stringify(crawlerExtractionPath)});
    ${FILLER_DECL}
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      const id = 'abcdefghij' + String.fromCharCode(97 + i);
      kept.push(...extractYouTubeVideoIds(filler + '<a href="https://www.youtube.com/watch?v=' + id + '">v</a>' + filler, 10));
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP);
  assert.equal(result.sample, 'abcdefghija');
  assert.ok(
    result.retained < THRESHOLD,
    `extractYouTubeVideoIds retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('inspector extractExternalUrlsFromText does not pin scanned pages', () => {
  const script = `
    const { extractExternalUrlsFromText } = require(${JSON.stringify(inspectorPath)});
    ${FILLER_DECL}
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      kept.push(...extractExternalUrlsFromText(filler + '<a href="https://example.com/page' + i + '">link</a>' + filler));
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP);
  assert.equal(result.sample, 'https://example.com/page0');
  assert.ok(
    result.retained < THRESHOLD,
    `extractExternalUrlsFromText retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('inspector about-metadata og captures do not pin scanned pages', () => {
  const script = `
    const { parseAboutPageMetadataFromHtml } = require(${JSON.stringify(inspectorPath)});
    ${FILLER_DECL}
    const description = (i) => 'about-description-' + i + ' ' + ${JSON.stringify(ABOUT_DESCRIPTION_REPEAT)}.repeat(10);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      const parsed = parseAboutPageMetadataFromHtml(filler + '<meta property="og:image" content="https://example.com/img' + i + '.png"><meta property="og:description" content="' + description(i) + '">' + filler);
      kept.push(parsed.bio, parsed.thumbnailUrl);
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP * 2);
  assert.equal(result.sample, aboutDescription(0));
  assert.ok(
    result.retained < THRESHOLD,
    `inspector about-metadata retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('youtubePublicAbout og captures do not pin scanned pages', () => {
  const script = `
    const { parseYouTubeChannelAboutFromHtml } = require(${JSON.stringify(youtubePublicAboutPath)});
    ${FILLER_DECL}
    const description = (i) => 'about-description-' + i + ' ' + ${JSON.stringify(ABOUT_DESCRIPTION_REPEAT)}.repeat(10);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      const parsed = parseYouTubeChannelAboutFromHtml(filler + '<meta property="og:image" content="https://example.com/img' + i + '.png"><meta property="og:description" content="' + description(i) + '">' + filler);
      kept.push(parsed.bio, parsed.thumbnailUrl);
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP * 2);
  assert.equal(result.sample, aboutDescription(0));
  assert.ok(
    result.retained < THRESHOLD,
    `youtubePublicAbout og captures retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('scrapeRecentVideoDescriptionsWithCoverage does not pin watch pages', () => {
  // Large watch pages with long descriptions and no links: the meta
  // description capture is the only page slice that can escape, so removing
  // its detach pins every watch page. Only the returned descriptions are kept
  // before measuring.
  const script = `
    const { scrapeRecentVideoDescriptionsWithCoverage } = require(${JSON.stringify(inspectorPath)});
    const filler = 'x'.repeat(1024 * 1024);
    const DESC_BODY = ${JSON.stringify(ABOUT_DESCRIPTION_REPEAT)};
    let channel = 0;
    const fakeFetch = async (url) => {
      if (url.includes('/watch?v=')) {
        const id = url.split('v=')[1];
        return { html: filler + '<meta name="description" content="Long description ' + id + ' ' + DESC_BODY.repeat(20) + '">' + filler, finalUrl: url, truncated: false };
      }
      channel++;
      let links = '';
      for (let j = 0; j < ${WATCH_PAGES_PER_CHANNEL}; j++) links += '<a href="https://www.youtube.com/watch?v=' + ('watchid' + String(channel).padStart(2, '0') + 'x' + j) + '">v</a>';
      return { html: filler + links + filler, finalUrl: url, truncated: false };
    };
    (async () => {
      global.gc();
      const before = process.memoryUsage().heapUsed;
      const kept = [];
      let attempted = 0, acquired = 0;
      for (let i = 0; i < ${KEEP}; i++) {
        const result = await scrapeRecentVideoDescriptionsWithCoverage('https://www.youtube.com/channel/demo' + i, fakeFetch);
        attempted += result.attempted;
        acquired += result.acquired;
        kept.push(...result.descriptions);
      }
      global.gc();
      console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, attempted: attempted, acquired: acquired, sample: kept[0] }));
    })();
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP * WATCH_PAGES_PER_CHANNEL);
  assert.equal(result.attempted, KEEP * WATCH_PAGES_PER_CHANNEL);
  assert.equal(result.acquired, KEEP * WATCH_PAGES_PER_CHANNEL);
  assert.equal(result.sample, `Long description watchid01x0 ${ABOUT_DESCRIPTION_REPEAT.repeat(20)}`.trim());
  assert.ok(
    result.retained < THRESHOLD,
    `scrapeRecentVideoDescriptionsWithCoverage retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

// Audit guard: ytInitialData values come from JSON.parse and are already
// independent strings (measured 0 MB retained pre-fix). This documents that
// property and would catch a future change that reintroduced slicing there.
test('ytInitialData-derived About metadata does not pin scanned pages', () => {
  const script = `
    const { parseAboutPageMetadataFromHtml } = require(${JSON.stringify(inspectorPath)});
    ${FILLER_DECL}
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      const json = JSON.stringify({ metadata: { channelMetadataRenderer: { description: 'json-desc-' + i, avatar: { thumbnails: [{ url: 'https://example.com/av' + i + '.png' }] } } }, urlEndpoint: { url: 'https://example.com/endpoint' + i }, channelExternalLinkViewModel: { link: { content: 'https://example.com/site' + i } } });
      const parsed = parseAboutPageMetadataFromHtml(filler + '<script>var ytInitialData = ' + json + ';</script>' + filler);
      kept.push(parsed.bio, parsed.thumbnailUrl, ...parsed.explicitLinks);
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP * 4);
  assert.equal(result.sample, 'json-desc-0');
  assert.ok(
    result.retained < THRESHOLD,
    `ytInitialData metadata retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});
