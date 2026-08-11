# Stage 4 dormant review canary boundary

This change only pins existing contracts in CI. It does not activate review serving.

Required invariants before any future Stage 4 production canary:

- `REVIEW_ELIGIBILITY` remains independently governed from dashboard serving.
- `release5_review_serving_mode` defaults to `OFF`.
- review serving assignment requires a matching promoted rollout.
- Review Eligibility V2 remains shadow-only until an explicit downstream activation.
- terminal classifications cannot be rematerialized into human review.
- a plausible creator-level trading hypothesis and sufficient independent evidence are prerequisites for eligibility.
- Stage 1/2/3 promotion and stability gates remain external prerequisites; this branch does not weaken or bypass them.
