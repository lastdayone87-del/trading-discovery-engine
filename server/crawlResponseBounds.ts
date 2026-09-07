/**
 * Bounded response-body reader for the static crawler path.
 *
 * Root-cause context: every static crawler fetch (`fetchWithTimeout`,
 * `fetchExternalPage` in inspector.ts, `fetchPublicYouTubePage` in
 * youtubePublicAbout.ts) buffered the full response with `await
 * response.text()` and no size guard. A single large/attacker-controlled page
 * (or several concurrent multi-MB YouTube pages plus per-page copies via
 * decodeEmbeddedMarkup/template concatenation/cheerio) could grow the Node
 * heap until mark-compact failed near the container limit. Capping each body
 * bounds per-fetch heap regardless of what the origin serves.
 *
 * Policy: stream the body and truncate at MAX_CRAWL_RESPONSE_CHARS (~2M
 * chars, comfortably above the ~1.6MB YouTube About page with headroom).
 * Truncation preserves recall for normal pages (Discord invites live in the
 * early document) and keeps behavior byte-identical below the cap. Callers
 * must treat a truncated prefix as incomplete coverage: it must never
 * resolve a definitive clean negative (INSPECTED_NO_MATCH / ATTEMPTED_EMPTY)
 * because evidence past the boundary was never observed.
 */
export const MAX_CRAWL_RESPONSE_CHARS = 2_000_000;

export interface BoundedResponseText {
  text: string;
  /** True when the origin served more than the cap and the prefix was cut. */
  truncated: boolean;
}

export async function readBoundedResponseText(
  response: Response,
  maxChars: number = MAX_CRAWL_RESPONSE_CHARS,
): Promise<BoundedResponseText> {
  const cap = Math.max(1, Math.floor(maxChars) || MAX_CRAWL_RESPONSE_CHARS);
  const body = (response as Response & { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== 'function') {
    const text = await response.text();
    return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false };
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        text += decoder.decode(value, { stream: true });
        if (text.length >= cap) {
          text = text.slice(0, cap);
          try {
            await reader.cancel();
          } catch {
            // Best-effort: the prefix is already captured; a cancel failure
            // must never fail the crawl itself.
          }
          return { text, truncated: true };
        }
      }
    }
    text += decoder.decode();
    return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Lock release is best-effort; the stream is already consumed/cancelled.
    }
  }
}
