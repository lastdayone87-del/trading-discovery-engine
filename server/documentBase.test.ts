import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentBaseUrl } from './documentBase';

const PAGE = 'https://creator.example.com/guide';

test('document base: missing base falls back to the final URL', () => {
  assert.equal(resolveDocumentBaseUrl('<html><body><a href="join">join</a></body></html>', PAGE), PAGE);
  assert.equal(resolveDocumentBaseUrl('', PAGE), PAGE);
  assert.equal(resolveDocumentBaseUrl('<base><a href="join">join</a></base>', PAGE), PAGE);
});

test('document base: relative base resolves against the final URL', () => {
  assert.equal(
    resolveDocumentBaseUrl('<base href="/community/">', PAGE),
    'https://creator.example.com/community/',
  );
  assert.equal(
    resolveDocumentBaseUrl('<base href="../community/">', PAGE),
    'https://creator.example.com/community/',
  );
});

test('document base: absolute same-host base is accepted', () => {
  assert.equal(
    resolveDocumentBaseUrl('<base href="https://creator.example.com/community/">', PAGE),
    'https://creator.example.com/community/',
  );
});

test('document base: absolute cross-host base is accepted for the caller policy to judge', () => {
  assert.equal(
    resolveDocumentBaseUrl('<base href="https://cdn.example.net/community/">', PAGE),
    'https://cdn.example.net/community/',
  );
});

test('document base: invalid base falls back to the final URL', () => {
  assert.equal(resolveDocumentBaseUrl('<base href="http://[invalid">', PAGE), PAGE);
  assert.equal(resolveDocumentBaseUrl('<base href="https://exa mple.com/">', PAGE), PAGE);
});

test('document base: non-http(s) base falls back to the final URL', () => {
  assert.equal(resolveDocumentBaseUrl('<base href="mailto:community@example.com">', PAGE), PAGE);
  assert.equal(resolveDocumentBaseUrl('<base href="javascript:alert(1)">', PAGE), PAGE);
  assert.equal(resolveDocumentBaseUrl('<base href="data:text/html,hello">', PAGE), PAGE);
});

test('document base: first base href wins', () => {
  assert.equal(
    resolveDocumentBaseUrl(
      '<base href="/community/"><base href="https://other.example.net/"><a href="join">join</a>',
      PAGE,
    ),
    'https://creator.example.com/community/',
  );
  // An empty first href is still the first base href: it falls back rather
  // than letting a later base element take effect.
  assert.equal(
    resolveDocumentBaseUrl('<base href=""><base href="/community/">', PAGE),
    PAGE,
  );
});

test('document base: an SVG <base> cannot override the HTML base', () => {
  assert.equal(
    resolveDocumentBaseUrl(
      '<html><head><svg><base href="/svg/"></svg><base href="/community/"></head><body></body></html>',
      PAGE,
    ),
    'https://creator.example.com/community/',
  );
  assert.equal(
    resolveDocumentBaseUrl('<html><body><svg><base href="/svg/"></svg><a href="join">join</a></body></html>', PAGE),
    PAGE,
    'an SVG-only base is ignored',
  );
});

test('document base: query and hash are preserved, and the hash never changes relative resolution', () => {
  const base = resolveDocumentBaseUrl('<base href="/community/?ref=1#top">', PAGE);
  assert.equal(base, 'https://creator.example.com/community/?ref=1#top');
  assert.equal(new URL('join', base).toString(), 'https://creator.example.com/community/join');
  assert.equal(new URL('?page=2', base).toString(), 'https://creator.example.com/community/?page=2');
  assert.equal(new URL('#member', base).toString(), 'https://creator.example.com/community/?ref=1#member');
});
