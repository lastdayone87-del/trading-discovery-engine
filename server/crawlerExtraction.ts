const VIDEO_ID = '[a-zA-Z0-9_-]{11}';

/**
 * V8 represents regexp captures over a large subject as SlicedString views:
 * storing a capture keeps the whole scanned page alive even after the page
 * itself is dropped. Copy a capture into an independent string before it
 * escapes the page's scope. The Discord candidate path uses the same detach
 * step (see discordCandidates.ts) because this retention class is what fills
 * the heap during sustained crawling. The UTF-16LE round trip copies code
 * units exactly, including unpaired surrogates (for example a lone `\uD800`
 * from JSON-escaped page data); a UTF-8 round trip would replace those with
 * U+FFFD and silently corrupt extracted values.
 */
export function detachPageSlice(value: string): string {
  return Buffer.from(value, 'utf16le').toString('utf16le');
}

export function decodeEmbeddedMarkup(text: string): string {
  return String(text || '')
    .replace(/\\\\\//gi, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x2f;|&#47;/gi, '/')
    .replace(/&#x3a;|&#58;/gi, ':')
    .replace(/&#x26;|&#38;/gi, '&')
    .replace(/%2f/gi, '/')
    .replace(/%3a/gi, ':')
    .replace(/%26/gi, '&')
    .replace(/%3f/gi, '?')
    .replace(/%3d/gi, '=');
}

export function extractEmbeddedUrls(text: string): string[] {
  const clean = decodeEmbeddedMarkup(text);
  const matches = clean.match(/(?:(?:https?:)?\/\/)[^\s"'<>\)\\]+/gi) || [];
  const results: string[] = [];
  for (let raw of matches) {
    raw = raw.replace(/[\.,\)\;\:\><"]+$/, '');
    if (raw.startsWith('//')) raw = `https:${raw}`;
    // `raw` can still be a SlicedString capture of the scanned page.
    raw = detachPageSlice(raw);
    if (!results.includes(raw)) results.push(raw);
  }
  return results;
}

export function extractDynamicTargetValues(text: string): string[] {
  const clean = decodeEmbeddedMarkup(text);
  const results: string[] = [];
  const attributePattern = /(?:data-(?:href|url|link|target)|(?:href|url|link))\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi;
  for (let match; (match = attributePattern.exec(clean)) !== null;) {
    // match[1]/match[2] are SlicedString captures of the scanned page; trim()
    // returns the same view when there is nothing to trim.
    const value = detachPageSlice((match[1] || match[2] || '').trim());
    if (value && !results.includes(value)) results.push(value);
  }
  return results;
}

export function extractYouTubeVideoIds(html: string, limit = 5): string[] {
  const clean = decodeEmbeddedMarkup(html);
  const patterns = [
    new RegExp(`(?:/watch\\?[^"'\\s>]*[?&]v=|/watch\\?v=)(${VIDEO_ID})`, 'gi'),
    new RegExp(`(?:videoId|video_id)\\s*["']?\\s*[:=]\\s*["'](${VIDEO_ID})["']`, 'gi'),
    new RegExp(`(?:canonical|url|href)\\s*["']?\\s*[:=]\\s*["'][^"']*[/]watch\\?[^"']*[?&]v=(${VIDEO_ID})`, 'gi'),
    new RegExp(`(?:youtu\\.be/|youtube\\.com/embed/)(${VIDEO_ID})`, 'gi'),
  ];
  const ids: string[] = [];
  for (const pattern of patterns) {
    for (let match; (match = pattern.exec(clean)) !== null;) {
      // match[1] is a SlicedString capture of the scanned page.
      const id = match[1] ? detachPageSlice(match[1]) : match[1];
      if (id && !ids.includes(id)) {
        ids.push(id);
        if (ids.length >= limit) return ids;
      }
    }
  }
  return ids;
}
