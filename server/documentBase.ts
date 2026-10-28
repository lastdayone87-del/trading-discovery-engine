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
 * Single pass over the input: detection is limited to the exact tag name
 * `base` (so `<base-button>` is untouched), and the closing `>` scan respects
 * quoted attribute values. An unclosed base tag consumes the remainder once
 * and ends the scan, so repeated malformed `<base` sequences cannot cause
 * quadratic work.
 */
export function stripBaseElements(html: string): string {
  const source = String(html || '');
  const length = source.length;
  let output = '';
  let cursor = 0;
  let index = 0;
  const isDelimiter = (code: number): boolean =>
    code === 0x2f /* / */ || code === 0x3e /* > */ || code === 0x20
    || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
  while (index < length) {
    if (source.charCodeAt(index) !== 0x3c /* < */) {
      index++;
      continue;
    }
    // Case-insensitive exact "base" prefix.
    const b = source.charCodeAt(index + 1) | 0x20;
    const a = source.charCodeAt(index + 2) | 0x20;
    const s = source.charCodeAt(index + 3) | 0x20;
    const e = source.charCodeAt(index + 4) | 0x20;
    const after = source.charCodeAt(index + 5);
    if (b !== 0x62 || a !== 0x61 || s !== 0x73 || e !== 0x65 || !isDelimiter(after)) {
      index++;
      continue;
    }
    output += source.slice(cursor, index);
    let scan = index + 5;
    let quote = 0;
    while (scan < length) {
      const code = source.charCodeAt(scan);
      if (quote) {
        if (code === quote) quote = 0;
      } else if (code === 0x22 || code === 0x27) {
        quote = code;
      } else if (code === 0x3e) {
        break;
      }
      scan++;
    }
    // Unclosed tag: drop the remainder; nothing after it can be parsed as a
    // start tag by the heuristic scanner either.
    cursor = scan < length ? scan + 1 : length;
    index = cursor;
  }
  return output + source.slice(cursor);
}
