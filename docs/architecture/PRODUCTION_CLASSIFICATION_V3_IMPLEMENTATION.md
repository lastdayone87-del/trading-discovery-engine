# Production classification v3 implementation

**Status:** implemented; governed production entry point preserved  
**Policy:** `unified-selective-policy-v1`  
**Evidence schema:** `canonical-evidence-v1`

## Behavioral changes

Classification now constructs one immutable, typed corpus before providers run.
Channel metadata, videos and descriptions, playlists, transcripts, external-link
labels/domains, visual assertions, pinned comments, and activity metadata receive
stable document and source-family identities. Providers can therefore attach
strong evidence to the actual supporting documents rather than adding weight
that the corroboration policy cannot recognize.

Multilingual routing now combines governed country defaults with field language
hints and terminology detected in actual content. This preserves the country
knowledge layer while allowing code-switched, diaspora, unknown-country, and
non-primary-language content to select applicable governed language surfaces.
Unsupported content still abstains; absence and provider failure remain
non-negative.

The former score-first/status-override sequence is replaced by one selective
policy. Stages materialize availability, candidate, source-independent
corroboration, and contradiction predicates; the unified policy alone maps those
predicates plus the evidence boundary to a terminal status. It emits separate
trading probability, non-trading probability, coverage confidence, action, and
reason codes. The initial calibration is deliberately conservative and is
versioned for replacement by the existing sealed, time-split isotonic evaluation
workflow.

Automatic confirmation still requires attributable independent evidence and the
positive boundary. Rejection still requires affirmative, dominant negative
evidence. High scores cannot bypass review/enrichment, provider agreement over
the same source cannot manufacture independence, and governed knowledge remains
subject to the same production gates and rollout flag.

## Learning and diagnostics

The stored production decision envelope now includes its schema version,
collection report, staged report, and unified-policy output in the same decision
metadata consumed by corrective learning. The learner also reads the existing
top-level staged report for backward compatibility and derives the active
boundary from decision metadata with a conservative fallback. Adaptive shadow
classification now reuses the production collection report and recomputes the
same stages over combined evidence instead of invoking a default empty staged
context.

## Rollout and evaluation guarantees

Existing controls remain authoritative: governed terminology publication is
moderated, adaptive serving is flag-gated, evaluation datasets are immutable and
time-split, calibration is fitted outside the test split, promotion requires
precision/recall/calibration/abstention guardrails, and production promotion is
not automatic. The new policy is observable through persisted diagnostics and
can be compared on the existing decision-evaluation control plane before any
rollout expansion.

## Validation coverage

Regression coverage verifies deterministic corpus identity across all supported
evidence surfaces, actual-content language routing for an unknown-country
multilingual case, mandatory attribution of emitted matches, selective
abstention, affirmative-negative rejection, corrected diagnostic consumption,
and legacy diagnostic compatibility. The existing suite continues to validate
every registered production country, all configured multilingual-country packs,
semantic citations and abstention, entity/source-family independence, governed
adaptation, evaluation guardrails, ingestion boundaries, and provider failures.

## Remaining production-data limitation

Repository tests demonstrate deterministic recall improvements and preservation
of negative/adversarial fixtures, but they cannot prove a production population
effect or statistically estimate precision and recall. Those claims require a
sealed representative dataset containing delayed authoritative labels. Before a
canary is expanded, operators must run the existing propensity-aware benchmark
and promotion gate and require the configured precision lower bound, cohort
sample floors, non-regressing recall/calibration, and bounded review load. No
synthetic test result should be represented as a production metric.
