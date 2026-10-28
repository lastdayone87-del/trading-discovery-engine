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
