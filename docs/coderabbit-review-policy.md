# CodeRabbit review policy (frozen P0-P6 baseline)

`/.coderabbit.yaml` is the only file that configures automated review for this
repo. It encodes the frozen Discovery Frontier invariants so reviewers —
human or automated — apply the same gates on every PR:

- UCB1 stays the control path; Thompson/contextual are shadow challengers.
- Experiment/pilot values (B/C/D/E) are never production constants.
- New mechanisms stay gated (explicit flags, paused/kill-switch default off,
  `servingAuthority=false`, trial caps, provenance) until acceptance gates pass.
- Hard prohibitions: `relatedToVideoId`, uncontrolled LLM-invented queries,
  auto-merge, fabricated fixtures, project-ignorant quota accounting.
- Methodology guards: frozen-pool isolation, deterministic replay
  (hash assignment, idempotency, immutable triggers/locks), provenance and
  decision states (`PROMOTE/RETAIN/DEFER/REJECT/INCONCLUSIVE`), delayed
  primary outcome (verified new creators per unit budget), kill-switches.
- Migration safety via additive-only DDL plus Squawk/SQLFluff enforcement.

Change this file only when the architecture itself changes through the
approved freeze process — never to quiet a single PR's findings.
