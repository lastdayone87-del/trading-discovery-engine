import * as cheerio from 'cheerio';

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function isHtmlWhitespace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

/**
 * Trim only the ASCII whitespace HTML strips from URLs. `String.prototype.trim`
 * also removes characters such as U+00A0 that URL parsing keeps, which would
 * resolve a base like `"\u00a0/community/"` to a different directory than a
 * browser does.
 */
function trimHtmlWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isHtmlWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isHtmlWhitespace(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

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
    href = trimHtmlWhitespace(String($(element).attr('href') || ''));
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
 *   and attribute text are untouched); foreign `<base>` elements are removed
 *   too because their href is still not a navigation target;
 * - comments (including `--!>` and abrupt closings), declarations, CDATA in
 *   foreign content, and HTML raw-text element bodies (script, style, textarea,
 *   title, ...) are skipped so `<base ` inside them cannot delete real controls
 *   later in the document;
 * - content stays foreign inside SVG/MathML (`<svg><plaintext>` is not an HTML
 *   raw-text body), but `<foreignObject>` and MathML text integration points
 *   switch their descendants back to HTML, so a `<script>` inside them is raw
 *   text again;
 * - quoted attribute values may contain `>`, but a quote inside an unquoted
 *   value does not;
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
  // HTML integration points: their children are parsed as HTML even though the
  // element itself is in foreign (SVG/MathML) content. `foreignObject` only
  // applies in SVG; the MathML text integration points and `annotation-xml`
  // only apply in MathML.
  const svgHtmlIntegrationPoints = new Set(['foreignobject']);
  const mathmlHtmlIntegrationPoints = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
  const isWhitespace = (code: number): boolean =>
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
  const isNameDelimiter = (code: number): boolean =>
    code === 0x2f || code === 0x3e || isWhitespace(code);
  const lower = (code: number): number => code >= 0x41 && code <= 0x5a ? code | 0x20 : code;

  // MathML `annotation-xml` is an HTML integration point only when its real
  // `encoding` attribute is `text/html` or `application/xhtml+xml`
  // (ASCII case-insensitive). Walk the tag's attributes rather than searching
  // its raw text: a lookalike `encoding=` inside another attribute's quoted
  // value must not spoof the switch. The first `encoding` attribute wins, as in
  // the HTML parser.
  const annotationXmlIsHtml = (from: number, to: number): boolean => {
    let index = from;
    while (index < to) {
      let code = source.charCodeAt(index);
      if (isHtmlWhitespace(code) || code === 0x2f /* / */) {
        index++;
        continue;
      }
      const nameStart = index;
      while (index < to) {
        code = source.charCodeAt(index);
        if (isHtmlWhitespace(code) || code === 0x2f || code === 0x3d || code === 0x3e) break;
        index++;
      }
      const attributeName = source.slice(nameStart, index).toLowerCase();
      while (index < to && isHtmlWhitespace(source.charCodeAt(index))) index++;
      let value = '';
      if (source.charCodeAt(index) === 0x3d /* = */) {
        index++;
        while (index < to && isHtmlWhitespace(source.charCodeAt(index))) index++;
        const quote = source.charCodeAt(index);
        if (quote === 0x22 || quote === 0x27) {
          const valueStart = ++index;
          while (index < to && source.charCodeAt(index) !== quote) index++;
          value = source.slice(valueStart, index);
          if (index < to) index++;
        } else {
          const valueStart = index;
          while (index < to) {
            const valueCode = source.charCodeAt(index);
            if (isHtmlWhitespace(valueCode) || valueCode === 0x3e) break;
            index++;
          }
          value = source.slice(valueStart, index);
        }
      }
      if (attributeName === 'encoding') {
        const normalized = trimHtmlWhitespace(value).toLowerCase();
        return normalized === 'text/html' || normalized === 'application/xhtml+xml';
      }
    }
    return false;
  };

  // Index of the first `>` that ends the tag starting at `from`, ignoring `>`
  // inside quoted attribute values. Only a quote that opens a value (after `=`)
  // starts a quoted value: a stray quote in an unquoted value (`href=a'b`) is
  // an ordinary character and must not keep the scanner in quote mode past a
  // following real tag. Returns `length` when the tag is unclosed.
  const findTagEnd = (from: number): number => {
    let quote = 0;
    // 0 = before an attribute name, 1 = before an attribute value (`=` seen),
    // 2 = inside an unquoted attribute value.
    let state: 0 | 1 | 2 = 0;
    for (let scan = from; scan < length; scan++) {
      const code = source.charCodeAt(scan);
      if (quote) {
        if (code === quote) quote = 0;
        continue;
      }
      if (state === 1) {
        if (isHtmlWhitespace(code)) continue;
        if (code === 0x22 || code === 0x27) {
          quote = code;
          state = 0;
        } else if (code === 0x3e) {
          return scan + 1;
        } else {
          state = 2;
        }
        continue;
      }
      if (state === 2) {
        if (code === 0x3e) return scan + 1;
        if (isHtmlWhitespace(code)) state = 0;
        continue;
      }
      if (code === 0x3d /* = */) {
        state = 1;
      } else if (code === 0x3e) {
        return scan + 1;
      }
    }
    return length;
  };

  // HTML comments end at `-->`, at the spec's alternate `--!>`, or abruptly
  // after `<!-->` / `<!--->`. Searching only for `-->` would skip past those
  // closings and leave a following real <base> in the extracted markup.
  const skipComment = (from: number): number => {
    if (source.charCodeAt(from) === 0x3e) return from + 1;
    if (source.charCodeAt(from) === 0x2d && source.charCodeAt(from + 1) === 0x3e) return from + 2;
    for (let scan = from; ;) {
      const dash = source.indexOf('--', scan);
      if (dash < 0) return length;
      const after = source.charCodeAt(dash + 2);
      if (after === 0x3e) return dash + 3;
      if (after === 0x21 && source.charCodeAt(dash + 3) === 0x3e) return dash + 4;
      // Advance one character, not two: runs of dashes (`<!-- --->`) overlap,
      // and skipping the shared dash misses the real comment ending.
      scan = dash + 1;
    }
  };

  // A start tag is self-closing when its last non-whitespace character before
  // `>` is `/`. Used to avoid leaving an unmatched <svg> on the foreign stack.
  const isSelfClosingTag = (tagEnd: number): boolean => {
    for (let scan = tagEnd - 2; scan > 0; scan--) {
      const code = source.charCodeAt(scan);
      if (isWhitespace(code)) continue;
      return code === 0x2f;
    }
    return false;
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
  // HTML content versus foreign (SVG/MathML) content. Raw-text element names
  // are only raw text in HTML content, and CDATA sections are only recognized
  // in foreign content. `<svg><plaintext>` is a foreign element, not an HTML
  // plaintext body, so it must not skip the rest of the document.
  let inHtmlContent = true;
  // Context-changing elements only (`svg`, `math`, and HTML integration
  // points); each frame restores the outer context when it closes.
  const contextStack: Array<{ name: string; previous: boolean }> = [];
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
        index = skipComment(index + 4);
        continue;
      }
      if (!inHtmlContent && source.startsWith('<![CDATA[', index)) {
        // CDATA sections exist only in foreign content. In HTML content the
        // same text is a bogus comment that ends at the first `>`, so treating
        // it as CDATA there would swallow a following real <base>.
        const end = source.indexOf(']]>', index + 9);
        index = end < 0 ? length : end + 3;
        continue;
      }
      // Bogus comment / doctype: HTML terminates at the first `>`; quotes and
      // brackets do not extend it. Tracking them made `<!bogus[>` swallow a
      // following real <base>.
      const end = source.indexOf('>', index + 2);
      index = end < 0 ? length : end + 1;
      continue;
    }
    if (next === 0x3f /* ? */) {
      // Processing instructions are bogus comments in HTML: first `>` wins.
      const end = source.indexOf('>', index + 2);
      index = end < 0 ? length : end + 1;
      continue;
    }
    if (next === 0x2f /* / */) {
      // Closing tag: skip it. A malformed closing tag is still tag syntax,
      // not a place where a real start tag begins.
      let nameEnd = index + 2;
      while (nameEnd < length && !isNameDelimiter(source.charCodeAt(nameEnd))) nameEnd++;
      let closeName = '';
      for (let offset = index + 2; offset < nameEnd; offset++) {
        closeName += String.fromCharCode(lower(source.charCodeAt(offset)));
      }
      if (contextStack.length > 0 && contextStack[contextStack.length - 1].name === closeName) {
        inHtmlContent = contextStack.pop()!.previous;
      }
      index = findTagEnd(nameEnd);
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
      // Foreign <base> elements are stripped too: their href is still not a
      // navigation target for the dynamic extractor.
      output += source.slice(cursor, index);
      cursor = tagEnd;
      index = tagEnd;
      continue;
    }
    // Raw-text element names are only raw text in HTML content; a foreign
    // <plaintext> must not hide the rest of the document. The matching HTML
    // integration point switches their children back to HTML, so a script
    // there is raw text again.
    const selfClosing = isSelfClosingTag(tagEnd);
    const opensForeign = inHtmlContent && (name === 'svg' || name === 'math');
    let foreignRoot: 'svg' | 'math' | '' = '';
    if (!inHtmlContent) {
      for (let frame = contextStack.length - 1; frame >= 0; frame--) {
        const frameName = contextStack[frame].name;
        if (frameName === 'svg' || frameName === 'math') {
          foreignRoot = frameName;
          break;
        }
      }
    }
    const opensHtml = (foreignRoot === 'svg' && svgHtmlIntegrationPoints.has(name))
      || (foreignRoot === 'math' && (
        mathmlHtmlIntegrationPoints.has(name)
        || (name === 'annotation-xml' && annotationXmlIsHtml(nameEnd, tagEnd - 1))
      ));
    if (!selfClosing && (opensForeign || opensHtml)) {
      contextStack.push({ name, previous: inHtmlContent });
      inHtmlContent = opensHtml;
    }
    if (inHtmlContent && rawTextElements.has(name)) {
      // Raw-text content is not parsed as markup. Skip to the matching close
      // tag (or EOF for plaintext / an unclosed element).
      index = findRawTextClose(name, tagEnd);
      continue;
    }
    index = tagEnd;
  }
  return output + source.slice(cursor);
}
