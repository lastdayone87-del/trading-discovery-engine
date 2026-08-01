# Production confirmation recall RCA

## Scope and method

This investigation treats reported creator names as symptoms, not classifier
inputs. No channel-specific rule, term, threshold, country, language, or category
exception was added. The production diagnostic record remains the authoritative
way to inspect normalized fields, provider outcomes, emitted evidence, every
stage disposition, and the final decision for an individual run.

## Root cause

Confirmation was most commonly stopped after scoring, at the staged
`AVAILABILITY` or `CORROBORATION` gate, and then made sticky by the ingestion
lifecycle:

1. **An optional runtime provider failure vetoed a complete evidence bundle.**
   Collection correctly retained deterministic channel/video evidence and marked
   the failing provider `FAILED`, but `degraded=true` forced `AVAILABILITY` to
   abstain even when collection was `SUFFICIENT`. The scorer could calculate a
   confirmed score, but staged policy converted it back to `UNCERTAIN`.
2. **Governed knowledge did not reach the production classifier.** The adaptive
   catalog and evidence graph ran after the immutable production decision. A
   rollout branch copied the shadow *status* into production under narrow
   conditions; it did not transport governed evidence through production
   scoring, corroboration, contradiction, or lifecycle evaluation. Consequently
   its provider provenance was absent from production stage diagnostics.
3. **Governed matches lacked field-level attribution.** Even in shadow, catalog
   evidence described a snapshot rather than the channel title, bio, or specific
   video document that contained the match. The field-aware corroborator could
   not establish document independence from that evidence.
4. **`NEEDS_REVIEW` was treated as a terminal ingestion state.** Once enrichment
   exhausted its bounded stages, later discovery with richer transported fields,
   recovered providers, or newly enabled governed knowledge returned the stored
   result without reclassification. This made an earlier abstention permanent
   even though `NEEDS_REVIEW` is not an affirmative human rejection.

## Provider contribution and abstention

The production evidence engine executes channel metadata, video metadata,
external links, country knowledge, multilingual context, Gemini semantic, and
Discord metadata providers independently and records one execution report per
provider. Providers may emit positive/negative evidence, execute with no governed
match, be inapplicable because their source field is absent, be unavailable by
configuration, semantically abstain, or fail at runtime. The classifier consumes
all evidence returned by those providers. Structured videos, descriptions,
playlists, transcripts, detected languages, external link details, pinned
comments, visual evidence, and activity metadata survive the ingestion boundary;
only providers that understand a field can presently emit assertions from it.

The architectural gap was therefore not loss in `Promise.all` or evidence-array
flattening. It was (a) the availability gate treating an optional abstention as a
global veto and (b) governed providers living outside the production evidence
array. The production diagnostic table makes both cases distinguishable from a
genuinely sparse or ambiguous channel.

## Corrective design

* A `SUFFICIENT` bundle now passes availability even when one provider failed.
  Degradation stays explicit in stage metrics and provider reports. This does not
  weaken candidate detection, weighted score thresholds, independent-document
  corroboration, negative-domain rules, or the dominant-contradiction gate.
* When the existing rollout control is enabled, approved adaptive/catalog and
  graph evidence is appended to the production evidence bundle, added to provider
  execution reporting, and reevaluated by the same weighted strategy and complete
  staged classifier. There is no status override. Governed evidence is considered
  only when ordinary production-positive evidence exists and no production
  negative evidence exists, so it cannot confirm a channel alone or bypass a
  contradiction.
* Governed catalog matches now cite exact channel/video field observations.
  Duplicate lexical emissions still do not count as independent evidence;
  separate attributable documents, document families, evidence dimensions, or
  genuinely separate sources are still required.
* `NEEDS_REVIEW` remains a review outcome but is no longer a true terminal state.
  Rediscovery can reevaluate it with recovered/enriched evidence. Country
  rejection, deterministic non-trading, human rejection, and completed confirmed
  channels remain terminal.

## Safety and global behavior

The change is semantic and provenance-based rather than lexical. It does not add
terms or alter country/language/category packs, so it applies uniformly to every
supported market, language, script, and trading style. Missing or insufficient
metadata still enriches; one incidental observation still goes to review;
unavailable evidence cannot be invented; duplicated matches cannot manufacture
corroboration; explicit adjacent, hype, irrelevant-domain, and dominant negative
evidence retain their veto/rejection behavior; and rollout remains reversible via
`governed_classifier_production_enabled`.

## Operational verification

For representative production rows, inspect `normalized_input`,
`provider_execution`, `evidence_items`, `staged_report`, and `decision` together.
A healthy recalled confirmation should show sufficient collection, any optional
failure as observable degradation, at least one semantic candidate, independent
attributable observations, no blocking contradiction, and `ROUTE_CONFIRM`. A
channel that lacks those facts correctly remains enrichable or reviewable.
