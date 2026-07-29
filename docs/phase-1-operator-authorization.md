# Phase 1: operator authorization boundary

## Scope and decisions

Phase 1 changes only the serving/operations plane. It adds one deny-by-default API
authorization middleware, request correlation, append-only audit storage, dashboard
bearer transport, and optional job provenance. Discovery, classification, provider,
quota, and worker semantics are unchanged. Later implementation-program phases remain
out of scope.

Roles are deliberately small: `operator` may read administrative data and initiate
ordinary discovery/review operations; `admin` is additionally required for backups,
stress/regression execution, queue and scheduler control, and configuration mutation.
`REVIEW_API_TOKEN` maps to operator during the compatibility window. It never grants
admin. The successful API response bodies and paths are unchanged; authorization
errors add stable `code` and `requestId` fields and every API response carries
`X-Request-Id`.

On first production load, the dashboard displays **Operator authentication required**
with an **API token** password field and **Load dashboard** button. A normal operator
enters the value configured on the server as `OPERATOR_API_TOKEN`. An administrator
may instead enter `ADMIN_API_TOKEN`; that credential includes normal operator access
and is required for admin-only controls such as queue pause/resume, scheduler control,
configuration writes, backups, and regression/stress execution. During the compatibility
window, the value of `REVIEW_API_TOKEN` is also accepted with operator (not admin)
permissions.

After submission, the browser stores the credential under the `operator-token`
local-storage key and sends it as `Authorization: Bearer <token>` on every same-origin
API request. Existing browsers with the legacy `review-token` local-storage entry keep
working because it remains the fallback. Secrets are never compiled into the bundle or
written to audit metadata. A missing, expired, or rotated credential returns the user
to the authentication screen rather than rendering an empty dashboard.

## Deployment and route inventory

Set `OPERATOR_API_TOKEN`, `OPERATOR_IDENTITY`, `ADMIN_API_TOKEN`, and
`ADMIN_IDENTITY`, distribute the appropriate token value to authorized operators over
the deployment's approved secret-sharing channel, and configure the health probe at
`GET /api/health`. Operators then open the production dashboard and enter that value in
the authentication screen; they do not enter the environment-variable name. The legacy
review token remains accepted as an operator token. `OPERATOR_AUTH_BYPASS=true` is an
explicit local-development option; production startup rejects it. Production also fails
startup when operator/reviewer or admin credentials are absent.

The executable route inventory is `routePolicyInventory` in
`server/operatorAuth.ts`. Its ordered policy assigns only `GET /api/health` public
access, names admin-only controls explicitly, and assigns remaining registered GET and
POST API routes to operator. An unknown `/api` route is denied as
`ROUTE_POLICY_MISSING`. Security review must compare this inventory to the Express
route list before GO.

## Migration, observability, and operations

Migration 016 creates append-only `operator_audit_events` and time, actor, and action
indexes. A uniqueness key makes repeated audit delivery idempotent. Metadata contains
only HTTP method, query-key names, and response status. Admins query recent events at
`GET /api/operator-audit-events?limit=100`; application logs include audit-write
failures with request ID but no credential or request body.

Old jobs remain readable because workers already tolerate extra/missing JSON fields.
New search jobs include optional `{ actorId, requestId }` provenance; scheduler-created
jobs use `system:scheduler`. No payload version or claim behavior changes.

## Rollout and rollback verification

1. Apply migration 016 and configure both roles and the health probe in staging.
2. Deploy with workers/scheduler paused; exercise anonymous, operator, admin, rotated,
   and invalid credentials for every inventory row. Confirm denied mutations create no
   jobs/state changes and inspect redacted audit records.
3. Resume one worker, then the scheduler. Retain access logs and the route-matrix
   report as staging gate evidence.
4. To roll back, pause producers, restore the prior image, retain migration 016, and
   rotate any suspect token. Old code ignores the additive table and optional payload
   provenance. Never weaken enforcement merely for a dashboard incompatibility.

No architectural deviation was required. Production staging evidence and security
sign-off are operational approvals and cannot be manufactured by the repository test
suite; therefore the Phase 1 gate remains **NO-GO for Phase 2** until attached by the
release owner.

## Completion checklist

- [x] Explicit deny-by-default public/operator/admin route policy.
- [x] Stable 401/403 and request-ID contracts; redacted public health response.
- [x] Additive, indexed, idempotent audit migration without bearer secrets.
- [x] Transitional reviewer role mapping and authenticated dashboard transport.
- [x] Optional request/actor job provenance and old-payload compatibility.
- [x] Production fail-closed configuration and explicit local-only bypass.
- [x] Unit, type, build, formatting, migration, and complete-suite checks documented.
- [ ] Security review signature on the complete route inventory.
- [ ] Staging proof of zero anonymous state/quota changes, with retained logs.
- [ ] Release-owner signed GO decision. Phase 2 remains blocked.
