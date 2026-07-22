# ADR 0002: tenant-and-user-bound database principals

- Status: accepted for tenant-managed production
- Date: 2026-07-23

## Context

PostgreSQL row-level security that trusts only a caller-controlled custom GUC is
useful against accidental missing predicates, but it does not isolate tenants
after a shared application credential is compromised. A holder of that shared
credential can set the GUC to a known victim tenant ID.

The product requires a strict tenant boundary and owner-zero-fixed-cost
production. Production infrastructure is customer managed under ADR 0001, so
database principals can be provisioned inside the customer's PostgreSQL
instance without creating an owner-paid service.

## Decision

Formal tenant-managed production uses a tenant-and-user-bound runtime database
principal (or a customer-controlled broker that provides the same short-lived
database identity):

- an offline migration principal installs migrations and is never used by the
  API or worker;
- `zuocheng_owner` remains `NOLOGIN` and owns protected objects;
- `zuocheng_app` remains `NOLOGIN` and provides only the narrow application
  privilege set;
- each runtime login is mapped to exactly one tenant and one active user by
  owner-controlled security metadata and may assume only `zuocheng_app`;
- every RLS policy checks both the transaction-local tenant GUC and the immutable
  `session_user` tenant/user mapping;
- API persistence resolves a principal-specific connection pool before beginning
  a transaction; it does not send arbitrary tenants or actors through a shared
  login;
- database mutation procedures require the actor derived from the verified API
  session to equal the mapped database user and then enforce membership role and
  project ACL;
- the purge runtime login is separate, may assume only `zuocheng_purge`, and is
  never a member of the app or owner roles;
- migration, tenant runtime and purge credentials are distinct secrets with
  independent rotation and audit trails.

The transaction-local GUC is retained as defense in depth and to prevent a pool
connection from leaking tenant context after commit. It is not treated as the
root identity proof.

## Consequences

- Compromise of one runtime credential is contained to its mapped tenant and
  user at the database policy boundary.
- Multi-user API processes need a bounded pool cache or customer-provided
  connection broker that returns a principal-bound connection. Unknown tenant
  or user principals fail closed.
- Connection limits and credential rotation are customer deployment concerns;
  the deployment guide must give sizing, eviction and rotation procedures.
- A deployment using one shared database login for multiple tenants or users is
  not formal production and readiness must stay false.
- PGlite proves migration compatibility and policy behavior only. Release still
  requires native PostgreSQL 17 tests with separate login sessions.

## Rejected alternatives

- A shared app login plus `set_config`: the login can select any known tenant and
  can attribute mutations to another member.
- Trusting an HTTP tenant header inside the database: it merely moves the same
  caller-controlled value across layers.
- Giving the API owner or purge membership: either privilege can bypass normal
  lifecycle guarantees and expands a credential compromise across tenants.
