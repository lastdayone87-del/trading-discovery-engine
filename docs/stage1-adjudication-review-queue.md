# Stage 1 independent adjudication review queue

This worklist exists only to accelerate independent human ground-truth collection for the Stage 1 prospective cohort.

- It includes only creators already marked `READY_FOR_INDEPENDENT_ADJUDICATION` by the read-only prospective audit.
- It emits two balanced hint lanes, likely trading and likely non-trading, ranked from Creator Focus observations.
- Lane placement is never ground truth. The reviewer must independently inspect every creator and may choose either `TRADING_CONFIRMED` or `NON_TRADING`.
- The worklist does not write labels, change operational channel/review state, change cohort assignments, or create serving authority.
- The actual label continues to be committed one creator at a time through the governed `Stage 1 prospective independent adjudication` workflow with explicit human label, creator type, reason codes, reviewer identity, and confirmation.
- Stage 1 remains blocked on the existing minimum independent-ground-truth gate; this queue does not weaken or bypass the 30/30 requirement.
