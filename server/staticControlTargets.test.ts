import assert from 'node:assert/strict';
import test from 'node:test';
import * as cheerio from 'cheerio';
import {
  MAX_STATIC_CONTROL_TARGETS,
  literalNavigationTarget,
  parseMetaRefreshTarget,
  parseOnclickNavigation,
  staticControlTargetsFromDocument,
} from './staticControlTargets';

const extract = (html: string, cap?: number) =>
  staticControlTargetsFromDocument(cheerio.load(html), cap);

test('extracts the approved literal control shapes in DOM order', () => {
  const result = extract(`
    <html><head>
      <meta http-equiv="refresh" content="0; url='/meta-room'">
    </head><body>
      <button formaction="https://discord.gg/form-room">Join the room</button>
      <input type="submit" formaction="/members">
      <input type="image" formaction="/image-members">
      <div onclick="location.href='https://discord.gg/click-room'">Click</div>
      <div onclick="window.open('https://linktr.ee/creator', '_blank')">Open</div>
      <div onclick="return document.location.href = '/assigned'">Assign</div>
      <div onclick="location.assign('/assigned-call')">Assign call</div>
      <div onclick="location.replace('/replaced')">Replace</div>
    </body></html>
  `);

  assert.deepEqual(result.targets.map(target => target.kind), [
    'META_REFRESH',
    'FORMACTION',
    'FORMACTION',
    'FORMACTION',
    'ONCLICK_NAVIGATION',
    'ONCLICK_NAVIGATION',
    'ONCLICK_NAVIGATION',
    'ONCLICK_NAVIGATION',
    'ONCLICK_NAVIGATION',
  ]);
  assert.deepEqual(result.targets.map(target => target.url), [
    '/meta-room',
    'https://discord.gg/form-room',
    '/members',
    '/image-members',
    'https://discord.gg/click-room',
    'https://linktr.ee/creator',
    '/assigned',
    '/assigned-call',
    '/replaced',
  ]);
  assert.equal(result.truncated, 0);
});

test('excludes JS expressions, multiple statements, and non-http schemes', () => {
  assert.equal(parseOnclickNavigation('doSomething()'), null);
  assert.equal(parseOnclickNavigation("location.href='/x?'+id"), null);
  assert.equal(parseOnclickNavigation("location.href='/a'; alert(1)"), null);
  assert.equal(parseOnclickNavigation('location.href=`/template`'), null);
  assert.equal(parseOnclickNavigation("location.href='javascript:alert(1)'"), null);
  assert.equal(parseOnclickNavigation("location.href='data:text/html,x'"), null);
  assert.equal(parseOnclickNavigation("window.open('mailto:test@example.com')"), null);
  assert.equal(parseOnclickNavigation('window.location = someVariable'), null);
  assert.equal(parseOnclickNavigation(''), null);

  assert.equal(parseMetaRefreshTarget('0; url=javascript:alert(1)'), null);
  assert.equal(parseMetaRefreshTarget('0; url=data:text/html,x'), null);
  assert.equal(parseMetaRefreshTarget('0;'), null);
  assert.equal(parseMetaRefreshTarget('not-a-refresh'), null);
  assert.equal(parseMetaRefreshTarget('30; url=/late'), null, 'long-delayed refreshes are excluded');

  assert.equal(literalNavigationTarget('#section'), null);
  assert.equal(literalNavigationTarget('mailto:test@example.com'), null);
  assert.equal(literalNavigationTarget('javascript:alert(1)'), null);
  assert.equal(literalNavigationTarget('   '), null);
  assert.equal(parseOnclickNavigation("location.href='/community?a=1+2'"), '/community?a=1+2');
});

test('ignores semantic anchors and controls outside the approved classes', () => {
  const result = extract(`
    <a href="https://discord.gg/anchor-room">Anchor</a>
    <form action="/form-submit"><button>Submit</button></form>
    <button>No target</button>
    <div role="button" data-target="/not-approved">Role button</div>
    <div formaction="/not-a-button">Div formaction</div>
    <button type="button" formaction="/not-a-submit">Button type</button>
    <input type="text" formaction="/not-a-submit">
  `);
  assert.deepEqual(result.targets, []);
  assert.equal(result.truncated, 0);
});

test('dedupes repeated targets and reports cap truncation deterministically', () => {
  const duplicate = extract(`
    <meta http-equiv="refresh" content="0;url=/shared">
    <button formaction="/shared">Duplicate</button>
  `);
  assert.equal(duplicate.targets.length, 1);
  assert.equal(duplicate.targets[0]?.kind, 'META_REFRESH');
  assert.equal(duplicate.truncated, 0);

  const many = Array.from({ length: MAX_STATIC_CONTROL_TARGETS + 5 }, (_, index) =>
    `<div onclick="location.href='/room-${index}'">Room ${index}</div>`).join('');
  const capped = extract(`<body>${many}</body>`);
  assert.equal(capped.targets.length, MAX_STATIC_CONTROL_TARGETS);
  assert.equal(capped.truncated, 5);
  assert.equal(capped.targets[MAX_STATIC_CONTROL_TARGETS - 1]?.url, `/room-${MAX_STATIC_CONTROL_TARGETS - 1}`);
});

test('meta refresh supports quoted, unquoted, and spaced URL forms', () => {
  assert.equal(parseMetaRefreshTarget('0;URL="/quoted"'), '/quoted');
  assert.equal(parseMetaRefreshTarget("5; url='/single'"), '/single');
  assert.equal(parseMetaRefreshTarget('0;url=/unquoted'), '/unquoted');
  assert.equal(parseMetaRefreshTarget('0; https://example.test/room'), 'https://example.test/room');
});
