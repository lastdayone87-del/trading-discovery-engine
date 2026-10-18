import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regression guard for page-snapshot retention: V8 represents regexp captures
// over a large subject as SlicedString views, so storing match slices in
// candidate.rawLocator keeps the whole page source alive. The rendered crawler
// extracts candidates, drops the HTML, and keeps only the candidates for the
// rest of the crawl — without the detach step in extractDiscordCandidates,
// each invite-bearing snapshot stays pinned.
test('candidate extraction does not pin the scanned page snapshot', () => {
  const modulePath = fileURLToPath(new URL('./discordCandidates.ts', import.meta.url));
  const script = `
    const { extractDiscordCandidates } = require(${JSON.stringify(modulePath)});
    const filler = 'x'.repeat(4 * 1024 * 1024);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = [];
    for (let i = 0; i < 16; i++) {
      let html = filler + ' https://discord.gg/code' + i + ' ' + filler;
      kept.push(...extractDiscordCandidates(html, 'CREATOR_WEBSITES', 'https://example.com'));
      html = null;
    }
    global.gc();
    const retained = process.memoryUsage().heapUsed - before;
    console.log(JSON.stringify({ retained, kept: kept.length, codes: kept.map(c => c.nativeInviteCode) }));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--expose-gc', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8'
  });
  const result = JSON.parse(output.trim().split('\n').at(-1) || '{}');
  assert.equal(result.kept, 16);
  assert.deepEqual(result.codes, Array.from({ length: 16 }, (_, i) => `code${i}`));
  // Calibration: detached candidates retained ~8 MB after GC for this
  // workload; the old sliced-string behavior retained ~120 MB for the same
  // 16 snapshots. The threshold keeps a wide margin below that signal.
  assert.ok(
    result.retained < 48 * 1024 * 1024,
    `candidate extraction retained ${(result.retained / 1048576).toFixed(1)} MB of page snapshots`
  );
});
