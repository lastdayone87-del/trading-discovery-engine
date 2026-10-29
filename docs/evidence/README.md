# Sanitized evidence

These files are sanitized reproductions of read-only production evidence used
by the invite navigation/acquisition investigation.

- No credential values, connection passwords, tokens, or raw page content are
  included.
- Aggregate URLs are not included; host names in aggregate tables are public
  creator/community hosts.
- The Coolify access path and role-privilege verification are documented in
  `docs/production-infrastructure.md` (PR #564).
- The P0.3 SQL file contains `SELECT` statements only and was executed inside a
  read-only transaction. The output is the raw aggregate output from that run.
- `invite-navigation-acquisition-recall-investigation-20261027.md` is the
  sanitized navigation/acquisition investigation report referenced by the
  P2–P4 readiness package. The production address, tunnel, and role details
  were removed; only the read-only verification fact remains.
