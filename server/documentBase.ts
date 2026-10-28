import * as cheerio from 'cheerio';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * First `<base href>` in the HTML namespace, or an empty string.
 *
 * HTML only honors base elements in the HTML namespace; an earlier SVG
 * `<base>` must not override the document base used for link resolution.
 * Cheerio's parse5 path exposes `namespace` on elements. A parser that omits
 * the property is treated as HTML so the helper stays fail-open for callers.
 */
function firstHtmlBaseHref($: cheerio.CheerioAPI): string {
  let href = '';
  let found = false;
  $('base[href]').each((_, element) => {
    if (found) return false;
    const namespace = (element as { namespace?: string }).namespace;
    if (namespace && namespace !== HTML_NAMESPACE) return;
    found = true;
    href = String($(element).attr('href') || '').trim();
    return false;
  });
  return href;
}

/**
 * Resolve the document base URL from an already-parsed document.
 *
 * Use this when the caller already loaded the HTML: it avoids parsing the same
 * page a second time just to find the first base href.
 */
export function resolveDocumentBaseUrlFromRoot($: cheerio.CheerioAPI, finalUrl: string): string {
  try {
    const href = firstHtmlBaseHref($);
    if (!href) return finalUrl;
    const resolved = new URL(href, finalUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return finalUrl;
    return resolved.toString();
  } catch {
    return finalUrl;
  }
}

/**
 * Resolve the document base URL advertised by the first HTML `<base href>`
 * element.
 *
 * HTML uses the first base element that carries an href (later bases are
 * ignored), and relative links resolve against that URL rather than the
 * document's own URL. Only http(s) bases are accepted: a missing, empty,
 * unparsable, or non-http(s) base falls back to `finalUrl` unchanged so callers
 * keep their existing behavior and never follow a script/data base. SVG
 * `<base>` elements are ignored.
 *
 * The returned URL preserves any query string and fragment from the base, as a
 * browser's document base URL would. A fragment on the base never changes the
 * path of a relative path reference (e.g. `<base href="/community/#top">` plus
 * `<a href="join">` still resolves to `/community/join`); it only matters for
 * fragment-only references.
 *
 * Pure and fail-closed: malformed HTML or URLs never throw.
 */
export function resolveDocumentBaseUrl(html: string, finalUrl: string): string {
  try {
    return resolveDocumentBaseUrlFromRoot(cheerio.load(String(html || '')), finalUrl);
  } catch {
    return finalUrl;
  }
}

/**
 * Remove HTML `<base ...>` start tags from a document without rewriting other
 * markup. Used before heuristic attribute extraction, which cannot otherwise
 * distinguish a base element's own `href` from a real dynamic target.
 *
 * Context-aware single pass:
 * - only an actual start tag named exactly `base` is removed (`<base-button>`
 *   and attribute text are untouched);
 * - comments, declarations, CDATA, and raw-text element bodies (script, style,
 *   textarea, title, ...) are skipped so `<base ` inside them cannot delete
 *   real controls later in the document;
 * - quoted attribute values may contain `>`;
 * - an unclosed base tag consumes the remainder once, and each raw-text body
 *   is scanned once, so malformed repeated input cannot cause quadratic work.
 */
export function stripBaseElements(html: string): string {
  const source = String(html || '');
  const length = source.length;
  const rawTextElements = new Set([
    'script', 'style', 'textarea', 'title', 'xmp', 'iframe',
    'noembed', 'noframes', 'noscript', 'plaintext',
  ]);
  const isWhitespace = (code: number): boolean =>
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
  const isNameDelimiter = (code: number): boolean =>
    code === 0x2f || code === 0x3e || isWhitespace(code);
  const lower = (code: number): number => code >= 0x41 && code <= 0x5a ? code | 0x20 : code;

  // Index of the first `>` after `from`, ignoring `>` inside quoted attribute
  // values. Returns `length` when the tag is unclosed.
  const findTagEnd = (from: number): number => {
    let quote = 0;
    for (let scan = from; scan < length; scan++) {
      const code = source.charCodeAt(scan);
      if (quote) {
        if (code === quote) quote = 0;
      } else if (code === 0x22 || code === 0x27) {
        quote = code;
      } else if (code === 0x3e) {
        return scan + 1;
      }
    }
    return length;
  };

  // Find `</name` (ASCII case-insensitive) followed by a tag-name delimiter.
  // One forward scan: each near-match advances the cursor by one character.
  const findRawTextClose = (name: string, from: number): number => {
    if (name === 'plaintext') return length;
    for (let index = from; index + name.length + 1 < length; index++) {
      if (source.charCodeAt(index) !== 0x3c) continue;
      if (source.charCodeAt(index + 1) !== 0x2f) continue;
      let matches = true;
      for (let offset = 0; offset < name.length; offset++) {
        if (lower(source.charCodeAt(index + 2 + offset)) !== name.charCodeAt(offset)) {
          matches = false;
          break;
        }
      }
      if (matches && isNameDelimiter(source.charCodeAt(index + 2 + name.length))) {
        return findTagEnd(index + 2 + name.length);
      }
    }
    return length;
  };

  let output = '';
  let cursor = 0;
  let index = 0;
  while (index < length) {
    if (source.charCodeAt(index) !== 0x3c /* < */) {
      index++;
      continue;
    }
    const next = source.charCodeAt(index + 1);
    if (next === 0x21 /* ! */) {
      // Comment, CDATA, or declaration. Skip it wholly so markup-looking text
      // inside cannot be mistaken for a start tag.
      if (source.startsWith('<!--', index)) {
        const end = source.indexOf('-->', index + 4);
        index = end < 0 ? length : end + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', index)) {
        const end = source.indexOf(']]>', index + 9);
        index = end < 0 ? length : end + 3;
        continue;
      }
      let bracketDepth = 0;
      let quote = 0;
      let scan = index + 2;
      for (; scan < length; scan++) {
        const code = source.charCodeAt(scan);
        if (quote) {
          if (code === quote) quote = 0;
        } else if (code === 0x22 || code === 0x27) {
          quote = code;
        } else if (code === 0x5b /* [ */) {
          bracketDepth++;
        } else if (code === 0x5d /* ] */ && bracketDepth > 0) {
          bracketDepth--;
        } else if (code === 0x3e && bracketDepth === 0) {
          scan++;
          break;
        }
      }
      index = scan;
      continue;
    }
    if (next === 0x3f /* ? */) {
      index = findTagEnd(index + 2);
      continue;
    }
    if (next === 0x2f /* / */) {
      // Closing tag: skip it. A malformed closing tag is still tag syntax,
      // not a place where a real start tag begins.
      index = findTagEnd(index + 2);
      continue;
    }
    if (!(next >= 0x41 && next <= 0x5a) && !(next >= 0x61 && next <= 0x7a)) {
      index++;
      continue;
    }
    // Read the tag name.
    let nameEnd = index + 1;
    while (nameEnd < length) {
      const code = source.charCodeAt(nameEnd);
      if (isNameDelimiter(code)) break;
      nameEnd++;
    }
    let name = '';
    for (let offset = index + 1; offset < nameEnd; offset++) {
      name += String.fromCharCode(lower(source.charCodeAt(offset)));
    }
    const tagEnd = findTagEnd(nameEnd);
    if (name === 'base') {
      output += source.slice(cursor, index);
      cursor = tagEnd;
      index = tagEnd;
      continue;
    }
    if (rawTextElements.has(name)) {
      // Raw-text content is not parsed as markup. Skip to the matching close
      // tag (or EOF for plaintext / an unclosed element).
      index = findRawTextClose(name, tagEnd);
      continue;
    }
    index = tagEnd;
  }
  return output + source.slice(cursor);
}
