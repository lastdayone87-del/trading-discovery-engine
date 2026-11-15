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

`config:verify` runs the compiled `dist/config/verifyProductionConfig.cjs`
produced by `npm run build`, so it does not depend on the development-only
`tsx` binary at runtime. For a source checkout before building, use
`npm run config:verify:src`.

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

Like `config:verify`, `config:apply` uses the compiled `dist/config` bundle.
Use `config:apply:src` for a source checkout before building.

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

Never add secret values to this repository or the manifest. Secret-like
environment keys are rejected by the manifest parser, and the verifier never
prints a secret value. Required secret keys are checked by name only.

Provider-key minimums use the runtime loaders' canonical slot rules:

- 58 YouTube keys (`YOUTUBE_API_KEY`, `YOUTUBE_API_KEY_1..N`; metadata such
  as `YOUTUBE_API_KEY_1_QUOTA_GROUP` is ignored; duplicate values count once)
- 5 Gemini keys (`GEMINI_API_KEY`, `GEMINI_API_KEY_2..N`; malformed suffixes
  ignored; duplicate values count once)
- 7 Groq keys (`GROQ_API_KEY`, `GROQ_API_KEY_2..N`; malformed suffixes
  ignored; duplicate values count once)

Plus `DATABASE_URL`, `ADMIN_API_TOKEN`, and `OPERATOR_API_TOKEN`.
