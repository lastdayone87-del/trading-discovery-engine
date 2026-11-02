import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDocumentBaseUrl, stripBaseElements } from './documentBase';

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

test('base stripping: only exact base tags are removed', () => {
  assert.equal(stripBaseElements('<base href="/community/">'), '');
  assert.equal(stripBaseElements('<BASE href="/community/">'), '');
  assert.equal(
    stripBaseElements('<base-button data-href="/community">members</base-button>'),
    '<base-button data-href="/community">members</base-button>',
    'a base-prefixed custom element is untouched',
  );
  assert.equal(
    stripBaseElements('<base href="/community/"><button data-href="/community/">Join</button>'),
    '<button data-href="/community/">Join</button>',
    'a real target that shares the base value survives',
  );
  assert.equal(
    stripBaseElements('<base href="/community%2F"><a href="join">join</a>'),
    '<a href="join">join</a>',
    'encoded base values cannot leak into extraction',
  );
});

test('base stripping: quoted greater-than signs stay inside the tag', () => {
  assert.equal(
    stripBaseElements('<base href="a>b"><a href="join">join</a>'),
    '<a href="join">join</a>',
  );
  assert.equal(
    stripBaseElements(`<base href='a>b'><a href="join">join</a>`),
    '<a href="join">join</a>',
  );
});

test('base stripping: markup-looking text in scripts and styles is untouched', () => {
  const script = '<script>const basePrefix = "<base ";</script><button data-href="/community/">Join</button>';
  assert.equal(stripBaseElements(script), script, 'script text cannot delete a real control');
  const style = '<style>.x::after{content:"<base "}</style><a href="join">join</a>';
  assert.equal(stripBaseElements(style), style, 'style text cannot delete a real control');
  const comment = '<!-- <base href="/community/"> --><a href="join">join</a>';
  assert.equal(stripBaseElements(comment), comment, 'comments are not markup');
  const quoted = '<div data-x="<base href=\'/community/\'>"><a href="join">join</a></div>';
  assert.equal(stripBaseElements(quoted), quoted, 'quoted attribute text is not markup');
});

test('base stripping: spec comment closings cannot hide a real base', () => {
  assert.equal(
    stripBaseElements('<!-- note --!><base href="/community/"><a href="join">join</a>'),
    '<!-- note --!><a href="join">join</a>',
    '--!> closes a comment',
  );
  assert.equal(
    stripBaseElements('<!--><base href="/community/"><a href="join">join</a>'),
    '<!--><a href="join">join</a>',
    '<!--> is an abrupt empty comment',
  );
  assert.equal(
    stripBaseElements('<!---><base href="/community/"><a href="join">join</a>'),
    '<!---><a href="join">join</a>',
    '<!---> is an abrupt comment',
  );
});

test('base stripping: foreign raw-text names do not swallow the document', () => {
  assert.equal(
    stripBaseElements('<svg><plaintext><base href="/community/"></svg><a href="join">join</a>'),
    '<svg><plaintext></svg><a href="join">join</a>',
    'plaintext in the SVG namespace is not an HTML raw-text body',
  );
  assert.equal(
    stripBaseElements('<math><plaintext></math><base href="/community/"><a href="join">join</a>'),
    '<math><plaintext></math><a href="join">join</a>',
    'math content is foreign too, and a later HTML base is still stripped',
  );
});

test('base stripping: bogus declarations end at the first greater-than', () => {
  assert.equal(
    stripBaseElements('<!bogus[><base href="/community/"><a href="join">join</a>'),
    '<!bogus[><a href="join">join</a>',
    'brackets do not extend a bogus comment',
  );
  assert.equal(
    stripBaseElements('<?bogus "><base href="/community/"><a href="join">join</a>'),
    '<?bogus "><a href="join">join</a>',
    'quotes do not extend a processing instruction',
  );
});

test('base stripping: a real base after raw text is still removed', () => {
  assert.equal(
    stripBaseElements('<script>const x = 1;</script><base href="/community/"><button data-href="/community/">Join</button>'),
    '<script>const x = 1;</script><button data-href="/community/">Join</button>',
  );
  assert.equal(
    stripBaseElements('<SCRIPT>const x = 1;</SCRIPT><BASE href="/community/"><a href="join">join</a>'),
    '<SCRIPT>const x = 1;</SCRIPT><a href="join">join</a>',
  );
  assert.equal(
    stripBaseElements('<script>const x = 1;</script ><base href="/community/"><a href="join">join</a>'),
    '<script>const x = 1;</script ><a href="join">join</a>',
    'a whitespace before the raw-text close tag is still a close tag',
  );
});

test('base stripping: repeated unclosed base tags terminate in one pass', () => {
  const malformed = '<base '.repeat(20_000);
  assert.equal(stripBaseElements(malformed), '', 'an unclosed base tag consumes the remainder once');
});

test('document base: query and hash are preserved, and the hash never changes relative resolution', () => {
  const base = resolveDocumentBaseUrl('<base href="/community/?ref=1#top">', PAGE);
  assert.equal(base, 'https://creator.example.com/community/?ref=1#top');
  assert.equal(new URL('join', base).toString(), 'https://creator.example.com/community/join');
  assert.equal(new URL('?page=2', base).toString(), 'https://creator.example.com/community/?page=2');
  assert.equal(new URL('#member', base).toString(), 'https://creator.example.com/community/?ref=1#member');
});
