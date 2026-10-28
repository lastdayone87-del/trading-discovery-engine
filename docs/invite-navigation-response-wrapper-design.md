# Response-wrapper extraction design (P1.8)

**Status:** design only. Not implemented, not enabled, and not authorized for
production.
**Security review:** `docs/invite-navigation-security-review.md`.

## 1. Problem

The static acquisition path decides whether to read and parse a response from
its status and `Content-Type`. Several wrapper pages that can contain a real
invite are currently rejected or misdecoded:

- non-2xx error pages whose body is a human-readable wrapper;
- XHTML/XML/RSS/Atom documents;
- pages whose declared charset is not UTF-8;
- plain-text and markdown wrappers.

P0.3 measured the opportunity (trailing 7 days, URL observations):
`UNSUPPORTED_CONTENT_TYPE` 5,830 (4.8%); RSS 663, JavaScript 531, XML 356 +
304, XHTML 5, markdown 135, plus image/PDF/font classes that are correctly
rejected assets. HTTP 404 (34,833) dominates status failures; 403 (14,011) and
406 (1,512) are access classes. This design targets only text-like wrappers,
not asset crawling or access-control bypass.

## 2. Current behavior (verified)

- A final body is read only when the response is 2xx and the content type
  contains `text/html`, `json`, or `plain`, with two exceptions: 401/403 for a
  bounded block-marker probe, and a seed-only 404/410 text-like probe.
- Other non-2xx bodies are deliberately not read, so `Retry-After` and the
  fetch budget survive.
- 2xx XHTML/XML/RSS is rejected as `UNSUPPORTED_CONTENT_TYPE`; the observation
  is non-retryable.
- The bounded reader uses a UTF-8 `TextDecoder` without consulting the
  declared charset. UTF-16/32 bodies are excluded from the 404 probe but can
  still be accepted as 2xx `text/html` and decoded into NUL-laden garbage.
- `text/plain` is accepted and passed through the existing HTML-oriented path;
  there is no dedicated plain-text extraction mode.
- The parser is Cheerio/HTML, which does not execute scripts. The existing
  response cap and timeout still apply.

## 3. Design principles

1. **Evidence, not trust.** A candidate extracted from an error page or feed is
   candidate evidence. It is never serving authority and must pass the normal
   invite validation path before it can be presented as an active invite.
2. **No access-control bypass.** Reading a 403 body that the server already
   returned is not a bypass, but the crawler must not retry credentials,
   cookies, CAPTCHAs, or alternate identities. Block/challenge pages remain
   blocked.
3. **Bounded and linear.** No external entity expansion, no unbounded
   decoding, no recursive feed parsing, no DOM execution.
4. **Truthful outcomes.** Unsupported or truncated content produces a named
   partial/unsupported result, never a silent clean absence.
5. **Default OFF.** Each wrapper class is a separate option.

## 4. P1.8a — charset-aware decoding

### 4.1 Behavior

- Parse the `charset` parameter from `Content-Type`; if absent, inspect a BOM.
- Accept only a whitelist: UTF-8, UTF-16LE, UTF-16BE, windows-1252,
  ISO-8859-1 (mapped to windows-1252 per browser convention).
- Decode into a UTF-8 string with a bounded output length. Drop a leading BOM
  and NUL padding from UTF-16.
- A declared unsupported charset (for example UTF-7, UTF-32, EBCDIC, or an
  invalid label) is not guessed. Return `UNSUPPORTED_CONTENT_TYPE` with a
  `charset` detail, or `PARTIALLY_INSPECTED` with `unsupported-charset` when
  the body is otherwise in scope.
- If the declared charset is absent and the body decodes as valid UTF-8, use
  UTF-8. If it does not, do not silently reinterpret as windows-1252; report
  the uncertainty.
- `Content-Encoding` handling remains the transport layer's responsibility;
  this design does not add decompression.

### 4.2 Bounds

- Decoded output cap: 1 MiB (existing response cap remains the outer bound).
- UTF-16 decoding must not expand beyond the cap; truncate at a code-point
  boundary and mark truncated.

### 4.3 Acceptance tests

1. UTF-16LE and UTF-16BE HTML with a BOM and an invite is decoded and found.
2. A declared UTF-16 page without a BOM but with the charset parameter is
   decoded correctly.
3. An unsupported charset is reported unsupported/partial, not clean.
4. Invalid UTF-8 without a declared charset is reported uncertain, not
   silently replaced with a different encoding.
5. A body that exceeds the cap is truncated and marked; the prefix is still
   scanned.

## 5. P1.8b — XHTML, XML, RSS, and Atom

### 5.1 Behavior

- 2xx `application/xhtml+xml` is parsed with the HTML parser (XHTML is
  HTML-shaped) after charset decoding.
- 2xx `application/xml`, `text/xml`, and `+xml` are handled as **text/feed
  extraction**, not as a general XML DOM:
  - collect bounded `<link href="...">`, `<guid>`, `<id>`, and visible text
    URLs/codes;
  - collect plain URLs and Discord invite forms from the decoded text;
  - do not resolve external entities, do not load DTDs, and do not expand
    custom entities.
- RSS/Atom feeds are useful mainly as link-hub evidence: a feed item may point
  at a creator page or a community wrapper. Feed entries are candidates for
  enqueueing under the existing destination policy, not automatically
  inspected documents.
- A feed that references a non-public address is admitted/rejected by the same
  shared policy as any other target.

### 5.2 Parser safety

- Reject or truncate documents with a `<!DOCTYPE` internal subset before any
  entity work; the text extractor must not implement entity expansion.
- Strip NULs and control characters that can confuse URL extraction.
- Count feeds as one document; do not recursively follow feed-of-feed chains.
- Maximum 1,000 extracted link candidates per document; the rest are counted
  as a coverage gap.

### 5.3 Acceptance tests

1. XHTML with an invite anchor is found.
2. RSS with an item link to a community page is enqueued under the destination
   policy; a weak generic link is policy-excluded, not crawled.
3. XML with a billion-laughs-style entity declaration is rejected/truncated
   without expansion, in bounded time.
4. A feed with more than 1,000 links is bounded and reports the remainder.
5. A feed entry pointing at a private IP is rejected by admission.

## 6. P1.8c — non-2xx wrapper bodies

### 6.1 Status policy

| Status | Body read | Extraction | Retry semantics |
| --- | --- | --- | --- |
| 401/403 | Existing bounded block-marker probe | Add candidate extraction only when the body is text-like and not a recognized challenge page | Unchanged; permanence still established by the existing identical-history + marker rule |
| 404/410 | Existing seed-only text-like probe | Extend the same probe to candidate extraction; child pages remain unread | Terminal barrier rules unchanged |
| 429/5xx | No change | No | `Retry-After` and retry budget preserved |
| Other 4xx | No change | No | Unchanged |

### 6.2 Provenance and semantics

- Candidates from error bodies carry a new source surface
  `HTTP_ERROR_WRAPPER` and the HTTP status as provenance. They are stored as
  candidate evidence, not as a validated active invite.
- Finding a candidate in a 403/404 body does **not** turn the acquisition into
  a successful page inspection. The observation remains failed/partial with
  the candidate attached, so coverage truth is preserved.
- A block/challenge page (marker match) is never mined for candidates.
- Do not read 404/410 child bodies; the 404 recovery rate is low (1.9%) and
  the child-body read would spend budget on dead URLs.

### 6.3 Acceptance tests

1. A 403 text wrapper containing an invite yields a candidate with
   `HTTP_ERROR_WRAPPER` provenance; the observation is not clean.
2. A recognized challenge page does not yield candidates.
3. A 404 child page body is not read; a 404 seed text wrapper is read under
   the existing probe and can yield a candidate.
4. A 500/429 body is not read and `Retry-After` behavior is unchanged.
5. A 403 binary/PDF body is not parsed.

## 7. P1.8d — plain text and markdown

### 7.1 Behavior

- `text/plain` and `text/markdown` are scanned with a dedicated text extractor:
  URLs, Discord invite forms, and line-oriented labels. No HTML parser, no
  script execution.
- A plain-text page is a valid inspected surface. It contributes candidates
  and links, but it cannot satisfy rendered-only requirements.
- Markdown links `[label](url)` are parsed with a bounded, linear scan; raw
  URLs are also accepted. Do not render markdown or follow image syntax.
- Content types that are clearly assets (image/*, font/*, PDF, CSS, JS) remain
  rejected. JavaScript is not executed or mined for strings.

### 7.2 Acceptance tests

1. Plain text with a raw `discord.gg/<code>` is found.
2. Markdown with `[Join](https://discord.gg/<code>)` is found.
3. A markdown image URL is not treated as a navigation target.
4. `text/css`, `application/javascript`, and `application/pdf` remain
   unsupported.
5. A plain-text body with 10,000 lines is bounded and does not block the
   event loop.

## 8. Telemetry and outcome model

New closed fields (counts, never content):

- `wrapperClass`: `html` | `xhtml` | `xml` | `feed` | `plain` | `markdown` |
  `error-wrapper` | `unsupported`
- `charset`: `utf-8` | `utf-16le` | `utf-16be` | `windows-1252` |
  `unsupported` | `unknown`
- `decodedTruncated`: boolean
- `wrapperCandidates`: count
- `wrapperCoverage`: `COMPLETE` | `BOUNDED` | `UNSUPPORTED` | `UNREADABLE`

`UNSUPPORTED` and `UNREADABLE` are visible partial states. They must not map
to a clean `INSPECTED_NO_MATCH`.

## 9. Rollout and approvals

1. Implement charset decoding and XHTML first (lowest risk), then plain/markdown,
   then feeds/XML, then error-wrapper extraction.
2. Each stage is default OFF and separately canaried.
3. Security review must cover parser bounds, entity handling, and error-body
   provenance before any stage is enabled.
4. Product review must confirm that error-page/feed candidates may be retained
   as evidence but not presented as validated invites.

Exact approvals: security owner (parsers/entity/bounds), product owner
(evidence provenance and display), canary owner (cohort/stop rules), release
owner (deployment). No production setting or schema change is part of this
design; telemetry additions require the existing additive persistence path.
