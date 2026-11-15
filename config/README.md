# Production runtime safety baseline

`config/production.json` is the code-owned, non-secret baseline for the main
production runtime settings that were changed or reverted. It is deliberately
focused on behavior settings, not operational state.

It contains:

- Admission model: `ADMISSION_PRIMARY_MODEL=gemini-flash-lite-latest`
- Classification models: `gemini-3.5-flash-lite`
- Groq candidate model
- Enrichment/search/community-retry worker requests
- Enrichment scale gate
- Classification rendered wait
- Rendered-admission governor and retry wait

It does **not** contain:

- Discovery pause state
- Queue pause controls
- Application database state
- API keys, database URLs, or operator tokens

Those remain in the application database and the migration runbook. The
manifest is not a replacement for the database backup; it prevents the runtime
settings above from silently reverting after a redeploy.

## Verify production

Run inside the application container so it sees the Coolify-injected runtime
environment:

```bash
npm run config:verify
```

The verifier checks:

1. The running environment against `environment`.
2. The admission model code default against the manifest.
3. Required secrets and provider-key minimum counts.

It exits non-zero on drift. Useful flags:

```bash
npm run config:verify -- --verbose
npm run config:verify -- --json
npm run config:verify -- --skip-secrets
```

## Generate the non-secret environment file

Dry run by default:

```bash
npm run config:apply
```

Write the file:

```bash
npm run config:apply -- --apply
```

This writes `config/production.env.generated` (mode `600`, non-secret values
only). It does not update Coolify or any database. Import the values into the
deployment environment; supply secrets from Coolify or a secret manager.

## Deployment flow

1. Change `config/production.json` and the corresponding code default/test.
2. Run `npm run config:verify` locally where possible.
3. Deploy through Coolify.
4. Run `npm run config:verify` inside the new app container.
5. If it fails, fix the drift before resuming discovery or changing workers.

## Migration

The manifest does not replace platform-state backups. A VPS migration still
needs the Coolify database, the original `APP_KEY`, and the application
Postgres database. See:

- `/root/trading-discovery-migration-runbook-20261114.md`
- `/root/secure/MIGRATION-BACKUP-MANIFEST-20261114.txt`

The runbook restores platform state; this manifest verifies that the runtime
settings above did not silently change.

## Secrets

Never add secret values to this repository or the manifest. Required secret
keys are checked by name only. The current provider-key minimums are:

- 58 `YOUTUBE_API_KEY_*`
- 5 `GEMINI_API_KEY*`
- 7 `GROQ_API_KEY*`

Plus `DATABASE_URL`, `ADMIN_API_TOKEN`, and `OPERATOR_API_TOKEN`.
