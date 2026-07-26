# ZC-02 domain and persistence evidence

Status: **development gates passing at the latest checkpoint; release evidence incomplete**

This record distinguishes executable development evidence from a customer
production deployment. Local PostgreSQL, PGlite, mocked customer adapters and
unit tests are never described as production proof.

## TDD and integration evidence

| Boundary | RED evidence | Latest GREEN checkpoint | Remaining release evidence |
|---|---|---|---|
| UUIDv7, ETag, optimistic concurrency and problem contracts | Contract and precondition suites failed before the schemas and parsers existed | Contract tests cover canonical UUIDv7, ETag, 409 and safe problem envelopes | Production HTTP transcripts and two-device evidence |
| Project lifecycle | Service and route modules were initially absent; each operation was introduced behind failing tests | Create/list/get/update/copy/archive/soft-delete/restore/permanent-delete routes call the real service/store boundary | Customer-managed production smoke and post-delete enumeration |
| Tenant and user isolation | Attack tests reproduced cross-context use, actor spoofing and same-tenant auxiliary-table disclosure | Runtime login maps to one tenant and one user; FORCE RLS, membership and project ACL checks fail closed; viewer mutation is opaque | Customer database principals and credential-rotation evidence |
| Idempotency | Tests reproduced projectless response hiding, cross-user reads, direct update and expired-key growth | Principal-bound keys, narrow claim/complete routines, canonical projectless completion and bounded purge/reclaim are implemented | Sustained production cleanup metrics and retry traces |
| Deletion and purge | Tests reproduced direct purge forgery, early purge, source UUID retention and state revival | Separate purge role, scheduled transition, content deletion and sensitive-reference scrubbing are covered | Object-store deletion, old signed URL denial and backup-retention proof |
| API ingress | Anonymous malformed/oversize bodies were parsed before authentication and preconditions | Authentication and mutation headers run first; JSON media type, 64 KiB streamed limit, nesting limit, 413/415 problems and `private, no-store` are tested | Edge/proxy body limit and cache-policy probe |
| Production composition | The executable entrypoint returned 404 for every project route and readiness could never become healthy | Tenant-managed mode requires a customer adapter and composes Better Auth, principal pools, membership, project store/service, readiness and graceful close | A real customer adapter, identity store and production deployment |

## Native PostgreSQL 17 checkpoint

This checkpoint ran on 2026-07-23 against an isolated local PostgreSQL 17.10
server, not against production.

- Distribution: EDB Windows x86-64 binaries linked from the official
  PostgreSQL Windows download page, archive version `17.10-2`.
- Downloaded archive SHA-256:
  `EF9B1E5E23D2E8A83914BA13D9DC536A72210FBA53FD1808FF1F7E06BB22B106`.
- Server reported `server_version=17.10` and `server_version_num=170010`.
- `pnpm --filter @zuocheng/db test:pg17` executed the migration and found
  exactly nine FORCE RLS tables.
- `zuocheng_owner`, `zuocheng_app` and `zuocheng_purge` were all confirmed
  `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT` and
  `NOBYPASSRLS`; every business table owner was `zuocheng_owner`.
- Three separate LOGIN principals were bound to tenant/user pairs. Tenant B
  saw zero tenant A projects; a tenant A viewer saw only its one authorized
  project out of two.
- That viewer saw zero hidden-project audit events, zero foreign idempotency
  responses and zero occurrences of the seeded secret marker.
- Cross-tenant `require_app_context` failed and direct app-role UPDATE on
  `idempotency_record` failed with insufficient privilege.
- A second fresh database ran the automated two-backend CAS gate: backend B
  was observed waiting on backend A's row lock, A committed version 2, B failed
  with SQLSTATE `40001`, and exactly two project snapshots remained.

The source page is <https://www.postgresql.org/download/windows/> and the
binary archive provider linked there is
<https://www.enterprisedb.com/download-postgresql-binaries>.

## Current non-release gaps

- The native gate must be repeated in CI and on the exact release commit; this
  local isolated server is development evidence only.
- Production requires a real customer-supplied Better Auth instance and a
  tenant-and-user-bound pool adapter. A test adapter is not acceptable release
  evidence.
- ZC-R05 also requires password, Passkey, three OAuth providers, recovery,
  session rotation/revocation, account export/deletion, local-to-cloud
  migration and two-device E2E. Those belong to later ZC stages.
- Object storage, backups, restore drills, deployed monitoring and customer
  resource identifiers are not yet present.

## Evidence policy

No requirement may move to `已满足` from this document alone. A release verdict
also needs the exact commit/image digest, native migration version, a
customer-managed deployment, production smoke traces and deletion-after-backup
verification.
