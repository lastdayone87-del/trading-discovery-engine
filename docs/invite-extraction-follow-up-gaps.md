# Invite extraction — low-prevalence follow-up gaps

**Date:** 2026-10-27
**Scope:** Gaps from the consolidated audit that were intentionally **not**
changed in the A1/D1/noise-filter remediation because they are low-prevalence,
unmeasured, or would expand scope.
**Status:** Documentation only. No code change is proposed here without a
separate approval.

The remediation implemented only the higher-impact, evidence-backed items:
A1 retention/selection, D1 >64-control reachability and telemetry, the
non-page/malformed URL filter, and `%2D` invite-code decoding. The gaps below
remain open.

## 1. `<base href>` in static navigation

**Confirmed behavior:** static navigation resolves relative links against the
current response URL (`server/inspector.ts`), while rendered clicks use the
DOM's `HTMLAnchorElement.href`, which honors `<base>`. A static-only page that
uses `<base href>` can therefore resolve a child link to the wrong host/path.

**Evidence:** confirmed in source; production prevalence is unmeasured and the
static/crawl matrices do not include `<base>`.

**Why not changed:** the correct fix touches the shared URL-resolution path
used by static crawl, retry, and extraction. A wrong resolution can create
false links or drop valid ones, so it needs fixture coverage for nested
`<base>`, relative paths, query-only links, and cross-host bases.

**Reconsider when:** telemetry shows `<base>` on a meaningful share of
inspected pages, or a labeled sample finds static-only misses attributable to
it.

## 2. Plain-text wrapper resolution on non-seed pages

**Confirmed behavior:** `extractDiscordCandidates` finds `dsc.gg`,
`discord.me`, `discord.io`, and `disboard.org` wrappers anywhere, but only the
seed path resolves a `wrapperCandidate`. Plain-text wrappers on child pages are
not followed.

**Evidence:** ≈0 in the 7d sample: 0 `dsc.gg` site inspections, 1
`ALTERNATIVE_REDIRECT` candidate all-time, 2 channels in `inspection_trail`,
and 1 check attempt.

**Why not changed:** resolving wrappers requires a network hop with redirect
and safety semantics (destination policy, public-address checks, loop limits).
The observed population does not justify adding that path now.

**Reconsider when:** wrapper prevalence rises or a labeled sample finds
plain-text wrappers on child pages that static/rendered extraction misses.

## 3. Charset decoding

**Confirmed behavior:** `readBoundedBody` uses `new TextDecoder()` (UTF-8) and
ignores `Content-Type` charset and `<meta charset>`. UTF-16/32 pages can decode
incorrectly and hide invite text.

**Evidence:** 501 `UNSUPPORTED_CONTENT_TYPE` observations/7d; 213 are page-like,
and most of those are assets/PDF/ICS rather than HTML.

**Why not changed:** correct charset handling needs header/meta precedence,
BOM handling, and bounded decoding tests. The measured page-like population is
small and mixed with non-HTML content.

**Reconsider when:** a labeled sample includes UTF-16/32 creator pages, or
telemetry isolates HTML pages with a non-UTF-8 charset.

## 4. Popups

**Confirmed behavior:** there is no `page.on('popup')` inspection; a
context-wide route covers popup requests, but popup document content is not
scanned.

**Evidence:** confirmed in source; production prevalence is unmeasured.

**Why not changed:** popup handling adds new browser lifecycle, timeout, and
cleanup paths. The D1 browser work already touches control enumeration and
route cleanup; adding popups in the same change would expand the blast radius.

**Reconsider when:** telemetry records popup presence, or a labeled sample
finds invites only in popup documents.

## 5. Iframes and child documents

**Confirmed behavior:** literal iframe `src`/`srcdoc` values are found, but
child iframe/object/embed/form documents are not traversed. The static matrix
records seven child-document/navigation gaps.

**Evidence:** matrix-only; production prevalence unmeasured.

**Why not changed:** iframe traversal needs per-document safety checks, depth
limits, and a way to attribute candidates to the parent channel. It is a
larger acquisition change than the approved filter.

**Reconsider when:** a labeled sample or telemetry shows child-document-only
invites at meaningful prevalence.

## 6. Meta-refresh child navigation

**Confirmed behavior:** meta-refresh direct pages are found; a meta-refresh
child is not followed statically. The rendered browser may follow it.

**Evidence:** matrix-only.

**Why not changed:** low observed prevalence; rendered fallback already covers
many such pages. A static implementation needs redirect-loop and
destination-safety handling.

## 7. Shadow DOM

**Confirmed behavior:** rendered locators pierce open shadow DOM;
`page.content()` may not. The matrix shows literal/template shadow cases found
and a shadow-concat partial.

**Evidence:** matrix-only; no production measurement.

**Why not changed:** extraction from `page.content()` is a separate path from
locator clicks. Fixing it requires serializing open shadow roots or extracting
from the live DOM, with new fixture coverage.

## 8. XHTML/XML 200 responses

**Confirmed behavior:** the crawler advertises XHTML in `Accept` but rejects
the response as unsupported.

**Evidence:** ≈38 observations/7d.

**Why not changed:** low prevalence; parsing XML/XHTML safely needs a separate
parser path and entity/XXE safety review.

## 9. Non-2xx bodies

**Confirmed behavior:** non-2xx bodies are read for block-marker probing but
never scanned for invites.

**Evidence:** 11 body-confirmed 404s/7d.

**Why not changed:** low prevalence and a product decision: a 404 body is
usually an error page, and scanning it can produce stale or soft-404 invites.

## 10. `pinnedComment`

**Confirmed behavior:** `pinnedComment` is harvested into the canonical
evidence plane as a `PINNED_COMMENT` document (`server/discovery/evidenceExtraction.ts`
and `server/evidenceEngine/documentProjection.ts`), but it is never used for
invite extraction and has no invite-extraction mapping or provenance. There is
no dedicated persisted column for it and 0 job payloads reference it as an
invite source.

**Evidence:** dormant in the observed population.

**Why not changed:** there is no population to recover, and closing the gap
needs an invite-extraction mapping/provenance decision for the already-persisted
document, not new persistence.

## 11. Encoded invite-code alphabet beyond `%2D`

**Confirmed behavior:** `decodeInviteObfuscation` now decodes `%2D` (hyphen),
because hyphen is part of the invite-code alphabet and the previous code
truncated `abc%2D123` to `abc`. Other percent-encoded code-alphabet characters
(`%5F` underscore, and any future alphabet additions) are not decoded.

**Evidence:** the `%2D` case was confirmed by the extraction-integrity tests;
`%5F` prevalence is unmeasured.

**Why not changed:** the approved correction was limited to the confirmed
`%2D` truncation. Decoding additional characters changes candidate codes and
must be checked against Discord's current code alphabet and host-boundary
rules. The existing `%2F`/`%3A`/`%26` decoding is about URL structure, not code
characters, and remains unchanged.

**Reconsider when:** a labeled sample or production candidate diff shows
encoded underscores/other alphabet characters causing truncated or missed
codes.

## 12. Preserved findings (no new evidence)

These were reviewed and intentionally left alone:

- **D2 scroll-cap completion:** 5 observations at `scrollsUsed=5`/7d.
- **D7 URL edge forms:** 0/2,264 edge-form locators.
- **Case collisions:** 0 observed.

## 13. Out of scope by decision

- D1 >64-control reachability, 70/64-control fixtures, control telemetry, and
  anchor-aware durable retry-offset advancement are **implemented** in this
  remediation.
- A1 retention and candidate selection are **implemented** in this
  remediation.
- Non-page/malformed URL filtering is **implemented** in this remediation.
- Retry concurrency, queue settings, budgets, and long-attempt caps remain
  **unimplemented** and gated on a separate canary and explicit approval; see
  `docs/community-acquisition-retry-preparation.md`.
