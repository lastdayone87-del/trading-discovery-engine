import * as cheerio from 'cheerio';

/**
 * Resolve the document base URL advertised by the first `<base href>` element.
 *
 * HTML uses the first base element that carries an href (later bases are
 * ignored), and relative links resolve against that URL rather than the
 * document's own URL. Only http(s) bases are accepted: a missing, empty,
 * unparsable, or non-http(s) base falls back to `finalUrl` unchanged so callers
 * keep their existing behavior and never follow a script/data base.
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
    const $ = cheerio.load(String(html || ''));
    const href = String($('base[href]').first().attr('href') || '').trim();
    if (!href) return finalUrl;
    const resolved = new URL(href, finalUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return finalUrl;
    return resolved.toString();
  } catch {
    return finalUrl;
  }
}
