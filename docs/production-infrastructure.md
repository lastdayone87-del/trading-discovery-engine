# Production infrastructure: Coolify, not Railway

**Verified:** 2026-10-27 (UTC), read-only  
**Status:** Canonical production-access reference for this repository

## Summary

Production is hosted on **Coolify**. Railway is **not** the production host and
must not be used or cited as the production access path.

Several older documents in this repository say “Railway” when describing
production. Those references are stale assumptions. This document is the source
of truth; the affected documents carry a correction banner and link here.

## Verified production identity

| Item | Value |
| --- | --- |
| Platform | Coolify 4.5.0 |
| Host | `vmi3628671` (`45.94.58.135`) |
| Project | `my-first-project` |
| Application UUID | `7zp5h5tz4dkjteaag4phxyme` |
| Environment | `production` |
| Application resource | `trading-discovery-enginemain-7zp5h5tz4dkjteaag4phxyme` |
| Application container network | `10.0.1.10` |
| Database container | `4anodpyfvgjn9ybl2jqs9eoa` (`postgres:18-alpine`) |
| Database network | `10.0.1.5:5432` |
| Database name | `postgres` |
| Read-only role | `muse_readonly` |

The application container image was built from the `main` commit current at
verification time, and `/api/health` returned:

```json
{"status":"ok","readiness":"ready","database":"ready"}
```

Verification output (host/application identity, read-only session checks, health
response) is retained outside the repository. This document records only
non-secret identifiers and results.

## Read-only access path

The verified path is:

1. SSH to the Coolify host using the existing operator key.
2. Forward a local port to the application database container
   (`127.0.0.1:55432 -> 10.0.1.5:5432`).
3. Connect as `muse_readonly` to database `postgres`.
4. Wrap every session in `BEGIN TRANSACTION READ ONLY` and set a statement
   timeout.

The role was verified to be non-superuser, unable to create databases or
schemas, and to have `transaction_read_only = on`. Credentials are supplied
outside the repository (environment file or secret manager) and must never be
committed, printed in logs, or pasted into reports.

## What is not the production access path

- **Railway.** No Railway project, environment, service, or backup is the
  production system.
- **`RAILWAY_FORENSIC_DATABASE_URL`.** This repository secret is not a
  production connection string and must not be used for production queries.
- **`.github/workflows/forensic-read-only-db.yml`.** This workflow targets the
  stale Railway assumption. Do not use it as evidence of production access or
  as a production read path.

## Repository metadata still to correct

The repository still contains Railway deployment metadata:

- `railway.json`;
- the hardcoded `trading-discovery-engine-production.up.railway.app` host in
  `vite.config.ts`; and
- tests that assert those values.

Their presence does **not** make Railway the production host. They are stale
deployment configuration and should be updated in a separate, reviewed
configuration change after the Coolify public domain and deployment contract are
confirmed. Do not cite them as evidence that Railway is production.

## Documentation correction rule

When a document describes production infrastructure:

- Use **Coolify** and the identifiers above.
- If the text is a historical audit, keep the findings but mark the host label
  as corrected; do not silently rewrite what was observed.
- Never describe a Railway project, backup, or connection as production.
- Link to this document instead of duplicating the access procedure.

## Safety boundaries

This reference documents read-only access only. It does not authorize
production writes, migrations, settings or feature-flag changes, queue or
concurrency changes, canaries, deployments, or data exports. Those actions
require separate explicit approval.
