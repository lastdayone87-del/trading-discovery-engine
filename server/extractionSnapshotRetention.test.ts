import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regression guard for page-snapshot retention across the general extraction
// helpers (the same SlicedString class PR #460 fixed for Discord candidates).
// V8 represents regexp captures over a large subject as SlicedString views, so
// any capture stored in a result array keeps the whole scanned page alive even
// after the page itself is dropped. Each helper is probed in a subprocess:
// extract from N large pages, keep only the outputs, force GC, and measure the
// retained heap. Pre-fix calibration (16 pages, ~8 MB each): extractEmbeddedUrls
// ~120 MB, extractDynamicTargetValues ~120 MB, inspector extractExternalUrls-
// FromText ~128 MB, og-metadata captures ~128 MB. Detached outputs retain
// ~0-8 MB for the same workload, so the threshold keeps a wide margin.
function measure(script: string): { retained: number; kept: number; sample?: string } {
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

test('extractYouTubeVideoIds does not pin scanned pages', () => {
  // Calibration: YouTube IDs are 11 chars, below V8's SlicedString minimum
  // (13), so this path already measured clean pre-fix. The explicit detach is
  // contract hardening for ID-shaped captures; the test guards that outputs
  // are independent strings and never regress into page-pinning views.
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
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      const parsed = parseAboutPageMetadataFromHtml(filler + '<meta property="og:image" content="https://example.com/img' + i + '.png"><meta property="og:description" content="desc-' + i + '">' + filler);
      kept.push(parsed.bio, parsed.thumbnailUrl);
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP * 2);
  assert.equal(result.sample, 'desc-0');
  assert.ok(
    result.retained < THRESHOLD,
    `inspector about-metadata retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
  );
});

test('youtubePublicAbout og captures do not pin scanned pages', () => {
  const script = `
    const { parseYouTubeChannelAboutFromHtml } = require(${JSON.stringify(youtubePublicAboutPath)});
    ${FILLER_DECL}
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < ${KEEP}; i++) {
      const parsed = parseYouTubeChannelAboutFromHtml(filler + '<meta property="og:image" content="https://example.com/img' + i + '.png"><meta property="og:description" content="desc-' + i + '">' + filler);
      kept.push(parsed.bio, parsed.thumbnailUrl);
    }
    global.gc();
    console.log(JSON.stringify({ retained: process.memoryUsage().heapUsed - before, kept: kept.length, sample: kept[0] }));
  `;
  const result = measure(script);
  assert.equal(result.kept, KEEP * 2);
  assert.equal(result.sample, 'desc-0');
  assert.ok(
    result.retained < THRESHOLD,
    `youtubePublicAbout og captures retained ${(result.retained / 1048576).toFixed(1)} MB of source pages`
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
