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

test('document base: only ASCII whitespace is trimmed from the href', () => {
  // HTML strips ASCII whitespace from a URL, but not U+00A0. Trimming with
  // String.prototype.trim would silently move the base to a different path.
  assert.equal(
    resolveDocumentBaseUrl('<base href="  /community/  ">', PAGE),
    'https://creator.example.com/community/',
    'leading and trailing ASCII whitespace is ignored',
  );
  assert.equal(
    resolveDocumentBaseUrl('<base href="\u00a0/community/">', PAGE),
    new URL('\u00a0/community/', PAGE).toString(),
    'a leading non-breaking space is preserved exactly as URL parsing sees it',
  );
  assert.equal(
    resolveDocumentBaseUrl('<base href="\u00a0/community/">', PAGE),
    'https://creator.example.com/%C2%A0/community/',
  );
});

test('base stripping: a quote inside an unquoted value does not hide a real base', () => {
  assert.equal(
    stripBaseElements('<base href=a\'b><a href="join">join</a>'),
    '<a href="join">join</a>',
    'a stray apostrophe in an unquoted value does not start a quoted value',
  );
  assert.equal(
    stripBaseElements('<base href=a"b><a href="join">join</a>'),
    '<a href="join">join</a>',
    'a stray double quote in an unquoted value does not start a quoted value',
  );
  assert.equal(
    stripBaseElements('<base href=/community/ data-x=\'a>b\'><a href="join">join</a>'),
    '<a href="join">join</a>',
    'a real quoted value still protects a greater-than sign',
  );
});

test('base stripping: overlapping comment endings cannot hide a real base', () => {
  assert.equal(
    stripBaseElements('<!-- ---><base href="/community/"><a href="join">join</a>'),
    '<!-- ---><a href="join">join</a>',
    'a run of dashes still ends at its last -->',
  );
  assert.equal(
    stripBaseElements('<!-- ---!><base href="/community/"><a href="join">join</a>'),
    '<!-- ---!><a href="join">join</a>',
    'a run of dashes still ends at its last --!>',
  );
});

test('base stripping: foreignObject descendants are HTML content', () => {
  const page =
    '<svg><foreignObject><script>const x = "<base ";</script><button data-href="/community/">Join</button></foreignObject></svg><base href="/community/"><a href="join">join</a>';
  assert.equal(
    stripBaseElements(page),
    '<svg><foreignObject><script>const x = "<base ";</script><button data-href="/community/">Join</button></foreignObject></svg><a href="join">join</a>',
    'a script inside foreignObject is raw text, and a later real base is still stripped',
  );
  assert.equal(
    stripBaseElements(
      '<math><mtext><script>const x = "<base ";</script></mtext></math><base href="/community/"><a href="join">join</a>',
    ),
    '<math><mtext><script>const x = "<base ";</script></mtext></math><a href="join">join</a>',
    'MathML text integration points are HTML content too',
  );
  assert.equal(
    stripBaseElements(
      '<svg><foreignObject><svg><script><base href="/inner/"></script></svg></foreignObject><base href="/outer/"></svg>',
    ),
    '<svg><foreignObject><svg><script></script></svg></foreignObject></svg>',
    'a nested SVG inside foreignObject is foreign content again',
  );
});

test('base stripping: annotation-xml integrates only with an HTML encoding', () => {
  const script = '<script>const x = \'<base data-href="/community/join">\';</script>';
  for (const encoding of ['text/html', 'TEXT/HTML', 'application/xhtml+xml']) {
    assert.equal(
      stripBaseElements(
        `<math><annotation-xml encoding="${encoding}">${script}</annotation-xml></math><base href="/community/"><a href="join">join</a>`,
      ),
      `<math><annotation-xml encoding="${encoding}">${script}</annotation-xml></math><a href="join">join</a>`,
      `script text is preserved for encoding="${encoding}"`,
    );
  }
  assert.equal(
    stripBaseElements(
      '<math><annotation-xml encoding="text/plain"><script><base data-href="/x/"></script></annotation-xml></math>',
    ),
    '<math><annotation-xml encoding="text/plain"><script></script></annotation-xml></math>',
    'a non-HTML encoding stays foreign, so the base-shaped element is stripped',
  );
  assert.equal(
    stripBaseElements('<math><annotation-xml><script><base data-href="/x/"></script></annotation-xml></math>'),
    '<math><annotation-xml><script></script></annotation-xml></math>',
    'a missing encoding stays foreign',
  );
  assert.equal(
    stripBaseElements('<math><foreignObject><script><base data-href="/x/"></script></foreignObject></math>'),
    '<math><foreignObject><script></script></foreignObject></math>',
    'foreignObject is an integration point only in SVG',
  );
});

test('base stripping: annotation-xml encoding cannot be spoofed by another attribute', () => {
  assert.equal(
    stripBaseElements(
      '<math><annotation-xml title="x encoding=\'text/html\'" encoding="text/plain"><script><base data-href="/x/"></script></annotation-xml></math>',
    ),
    '<math><annotation-xml title="x encoding=\'text/html\'" encoding="text/plain"><script></script></annotation-xml></math>',
    'a lookalike encoding inside an earlier value does not win over the real attribute',
  );
  assert.equal(
    stripBaseElements(
      '<math><annotation-xml encoding="text/plain" title="encoding=\'text/html\'"><script><base data-href="/x/"></script></annotation-xml></math>',
    ),
    '<math><annotation-xml encoding="text/plain" title="encoding=\'text/html\'"><script></script></annotation-xml></math>',
    'a spoof after the real attribute does not override it',
  );
  assert.equal(
    stripBaseElements(
      '<math><annotation-xml title="encoding=\'text/plain\'" encoding="text/html"><script>const x = \'<base data-href="/x/">\';</script></annotation-xml></math>',
    ),
    '<math><annotation-xml title="encoding=\'text/plain\'" encoding="text/html"><script>const x = \'<base data-href="/x/">\';</script></annotation-xml></math>',
    'a spoof before the real HTML encoding does not suppress it',
  );
  assert.equal(
    stripBaseElements(
      '<math><annotation-xml encoding="text/plain" encoding="text/html"><script><base data-href="/x/"></script></annotation-xml></math>',
    ),
    '<math><annotation-xml encoding="text/plain" encoding="text/html"><script></script></annotation-xml></math>',
    'the first encoding attribute wins, as in the HTML parser',
  );
  assert.equal(
    stripBaseElements(
      '<math><annotation-xml encoding=text/html><script>const x = \'<base data-href="/x/">\';</script></annotation-xml></math>',
    ),
    '<math><annotation-xml encoding=text/html><script>const x = \'<base data-href="/x/">\';</script></annotation-xml></math>',
    'an unquoted HTML encoding is accepted',
  );
  assert.equal(
    stripBaseElements(
      '<math><annotation-xml title="a>b" encoding="text/html"><script>const x = \'<base data-href="/x/">\';</script></annotation-xml></math>',
    ),
    '<math><annotation-xml title="a>b" encoding="text/html"><script>const x = \'<base data-href="/x/">\';</script></annotation-xml></math>',
    'a quoted greater-than before encoding does not truncate attribute parsing',
  );
});

test('base stripping: CDATA is only a section in foreign content', () => {
  assert.equal(
    stripBaseElements('<![CDATA[x]]><base href="/community/"><a href="join">join</a>'),
    '<![CDATA[x]]><a href="join">join</a>',
    'in HTML content CDATA is a bogus comment ending at the first greater-than',
  );
  assert.equal(
    stripBaseElements('<svg><![CDATA[<base href="/inner/">]]></svg><base href="/outer/"><a href="join">join</a>'),
    '<svg><![CDATA[<base href="/inner/">]]></svg><a href="join">join</a>',
    'a foreign CDATA section is skipped and a later real base is stripped',
  );
});

test('document base: query and hash are preserved, and the hash never changes relative resolution', () => {
  const base = resolveDocumentBaseUrl('<base href="/community/?ref=1#top">', PAGE);
  assert.equal(base, 'https://creator.example.com/community/?ref=1#top');
  assert.equal(new URL('join', base).toString(), 'https://creator.example.com/community/join');
  assert.equal(new URL('?page=2', base).toString(), 'https://creator.example.com/community/?page=2');
  assert.equal(new URL('#member', base).toString(), 'https://creator.example.com/community/?ref=1#member');
});
