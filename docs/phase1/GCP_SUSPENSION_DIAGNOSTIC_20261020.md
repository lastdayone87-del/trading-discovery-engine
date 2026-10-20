# GCP/YouTube key-suspension diagnostic — 2026-10-20

Status: **OPEN / ACCESS-BLOCKED.** This is a read-only investigation. No key,
quota, restriction, billing, IAM, or project setting was changed. No cause is
established.

## Access actually available

- No Google Cloud credentials, authenticated `gcloud` session, or console access
  is available in this environment.
- No production database tunnel is available in the current session
  (`127.0.0.1:55432` / `DATABASE_URL` are absent or unreachable). Production
  read-only verification therefore cannot be repeated here.
- The figures below are from the prior read-only audit dated 2026-10-19
  (`/tmp/opencode/evidence/audit/QUOTA_CAP_PROPOSAL_20261019.md`, not committed)
  and the activation evidence pack. They are **not** a live re-query.

## Missing access (exact)

The operator must supply read-only access to the affected Google Cloud
project(s) and console pages, or paste the requested evidence:

1. `serviceusage.services.get`, `serviceusage.quotas.get`
   (`roles/serviceusage.serviceUsageViewer`).
2. `logging.viewer` for 403/quota/suspension log queries.
3. `monitoring.viewer` for API error/traffic dashboards.
4. `apikeys.keys.get` (`apikeys.viewer` or equivalent read).
5. `resourcemanager.projects.get` (`roles/browser`) to map project numbers to
   environment key names.
6. Billing account read access (account status only; no payment changes).
7. The project number(s) for the affected projects, and the mapping from
   `YOUTUBE_API_KEY_*` environment slots to those project numbers.

No write scope is requested or needed.

## Recorded observations (prior audit, not re-verified today)

- **21 keys** were in `CONSUMER_SUSPENDED` state, with observations on
  2026-10-15 between 07:02:30Z and 07:22:22Z and a retry date of 2026-10-22.
  The affected environment names were a subset of `YOUTUBE_API_KEY_1..20,22`.
- Suspended cohort, 2026-10-14: **21/21 keys exceeded 10,000 units**, maximum
  **11,576**.
- 2026-10-16: **12/12** configured keys exceeded 10,000; maximum **11,352**,
  total **133,294**.
- 2026-10-17: **12/12** exceeded 10,000; maximum **11,078**, total **130,876**.
- 2026-10-18: **12/24** exceeded 10,000; maximum **10,982**, total **185,422**.
- Replacement cohort on 2026-10-18: **0/12** exceeded 10,000; maximum
  **5,718**.
- Per-key overage precedes the observed suspension sweep. That is a temporal
  association, **not** a proven cause.

## What remains unknown

- Whether the suspension was caused by quota overage, policy review, billing,
  project-level abuse detection, credential leakage, or another cause.
- Whether the affected keys share one Google Cloud project or multiple
  projects. No `*_QUOTA_GROUP` labels were observed in the prior audit, but the
  environment was not inspected for project IDs.
- Whether other APIs on the same projects were affected.
- The exact provider 403 reason/message for each key and the project-level
  quota limits in effect.

## Read-only evidence to collect before any conclusion

1. APIs & Services → Credentials → each key: restrictions and suspension banner.
2. APIs & Services → Enabled APIs & Services → YouTube Data API v3 → Quotas &
   System Limits (daily and per-method limits).
3. IAM & Admin → Quotas → filter YouTube Data API.
4. Logging → Logs Explorer: `resource.type="api"` and
   `protoPayload.status.code=403` for 2026-10-14 through 2026-10-19; capture
   reason/message/timestamp and project number.
5. API Dashboard → YouTube Data API v3 → errors and traffic, per key.
6. Billing → account status; IAM → project contacts (suspension emails).
7. IAM & Admin → Settings → project number for each affected project.

Do **not** rotate keys, edit restrictions, raise quotas, change billing, or
re-enable suspended keys as part of this diagnostic.

## Conclusion

No root cause is claimed. The only defensible statement is that the 21-key
cohort was suspended after a period of per-key overage, and the access required
to distinguish the possible causes has not been supplied. Any future statement
about cause must cite the console/log evidence above.
