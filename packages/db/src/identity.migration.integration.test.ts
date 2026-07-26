import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
  .sort();
const migrations = migrationFiles.map((file) =>
  readFileSync(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), 'utf8'),
);

type PgError = Error & { code?: string };

async function expectSqlState(operation: Promise<unknown>, expectedCode: string) {
  try {
    await operation;
  } catch (error) {
    expect((error as PgError).code).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected PostgreSQL SQLSTATE ${expectedCode}`);
}

describe.sequential('ZC-03 ordered identity migrations and attacks', () => {
  const db = new PGlite();
  let tenantA = '';
  let tenantB = '';
  let userA = '';
  let sessionA = '';
  const sessionTokenHash = 'a'.repeat(64);
  const verificationIdentifierHash = 'd'.repeat(43);
  const oauthStateIdentifierHash = 'e'.repeat(43);
  const tokenAadHash = 'f'.repeat(64);
  const versionedCiphertext = `$ba$7$${'ab'.repeat(32)}`;

  async function becomeAdmin() {
    await db.exec('RESET ROLE');
    await db.exec('RESET SESSION AUTHORIZATION');
  }

  async function becomeAuth() {
    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_auth');
  }

  beforeAll(async () => {
    expect(migrationFiles).toEqual([
      '0000_foundation.sql',
      '0001_identity.sql',
      '0002_account_rights.sql',
    ]);
    for (const migration of migrations) {
      await db.exec(migration);
    }

    const ids = await db.query<{
      tenant_a: string;
      tenant_b: string;
      user_a: string;
      session_a: string;
    }>(`SELECT
      zuocheng.uuid_v7()::text AS tenant_a,
      zuocheng.uuid_v7()::text AS tenant_b,
      zuocheng.uuid_v7()::text AS user_a,
      zuocheng.uuid_v7()::text AS session_a`);
    ({
      tenant_a: tenantA,
      tenant_b: tenantB,
      user_a: userA,
      session_a: sessionA,
    } = ids.rows[0]!);

    await db.query(
      `INSERT INTO zuocheng.tenant (id, slug, display_name)
       VALUES ($1, 'identity-a', 'Identity A'), ($2, 'identity-b', 'Identity B')`,
      [tenantA, tenantB],
    );
    await db.query(
      `INSERT INTO zuocheng."user"
         (id, email, display_name, email_verified, account_status, active_tenant_id)
       VALUES ($1, 'identity@example.test', 'Identity User', true, 'active', $2)`,
      [userA, tenantA],
    );
    await db.query(
      `INSERT INTO zuocheng.membership (tenant_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active')`,
      [tenantA, userA],
    );
    await db.exec(
      `CREATE ROLE zuocheng_auth_runtime
         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       GRANT zuocheng_auth TO zuocheng_auth_runtime WITH SET TRUE, INHERIT FALSE;`,
    );

    await becomeAuth();
    await db.query(
      `INSERT INTO zuocheng.account
         (user_id, account_id, provider_id, password_hash)
       VALUES ($1::uuid, ($1::uuid)::text, 'credential', '$scrypt$production-password-hash')`,
      [userA],
    );
    await db.query(
      `INSERT INTO zuocheng.account
         (user_id, account_id, provider_id, scope, access_token_ciphertext,
          refresh_token_ciphertext, token_tenant_id, token_key_version, token_aad_hash)
       VALUES (
         $1, 'real-provider-subject', 'external-provider', 'openid email', $2, $2,
         $3, 7, $4
       )`,
      [userA, versionedCiphertext, tenantA, tokenAadHash],
    );
    await db.query(
      `INSERT INTO zuocheng.session
         (id, user_id, token_hash, expires_at, active_tenant_id, account_status_snapshot,
          device_id_hash, device_name, user_agent, ip_address_hash)
       VALUES ($1, $2, $3, now() + interval '1 hour', $4, 'active',
               repeat('b', 64), 'Primary browser', 'Test Agent', repeat('c', 64))`,
      [sessionA, userA, sessionTokenHash, tenantA],
    );
    await db.query(
      `INSERT INTO zuocheng.verification
         (user_id, purpose, identifier_hash, subject_value, expires_at)
       VALUES ($1::uuid, 'password_reset', $2, ($1::uuid)::text,
               now() + interval '10 minutes')`,
      [userA, verificationIdentifierHash],
    );
    await db.query(
      `INSERT INTO zuocheng.verification
         (user_id, tenant_id, purpose, provider_id, identifier_hash, state_ciphertext,
          ciphertext_key_version, ciphertext_aad_hash, expires_at)
       VALUES ($1, $2, 'oauth_state', 'external-provider', $3, $4, 7, $5,
               now() + interval '10 minutes')`,
      [userA, tenantA, oauthStateIdentifierHash, versionedCiphertext, tokenAadHash],
    );
    await db.query(
      `INSERT INTO zuocheng.passkey
         (user_id, name, public_key, credential_id, counter, device_type, backed_up,
          transports, aaguid)
       VALUES ($1, 'Security key', 'base64url-public-key', 'credential-id', 0,
               'singleDevice', false, 'usb,nfc', '00000000-0000-0000-0000-000000000000')`,
      [userA],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it('requires the foundation migration before identity', async () => {
    const identityOnly = new PGlite();
    try {
      await expectSqlState(identityOnly.exec(migrations[1]!), '3F000');
    } finally {
      await identityOnly.close();
    }
  });

  it('applies 0000 then 0001 and exposes the stable Better Auth/Passkey shape', async () => {
    await becomeAdmin();
    const relations = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'zuocheng'
          AND table_name IN (
            'user', 'account', 'session', 'verification', 'passkey',
            'identity_audit_event', 'account_deletion_request'
          )
        ORDER BY table_name`,
    );
    expect(relations.rows.map((row) => row.table_name)).toEqual([
      'account',
      'account_deletion_request',
      'identity_audit_event',
      'passkey',
      'session',
      'user',
      'verification',
    ]);

    const forced = await db.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'zuocheng'
          AND relation.relname IN (
            'account', 'session', 'verification', 'passkey',
            'identity_audit_event', 'account_deletion_request'
          )
          AND relation.relrowsecurity
          AND relation.relforcerowsecurity`,
    );
    expect(forced.rows).toEqual([{ count: 6 }]);
  });

  it('applies account-rights persistence with digest-only idempotency and export integrity', async () => {
    await becomeAuth();
    const sessionDevice = await db.query<{ device_public_id: string }>(
      `SELECT device_public_id::text
         FROM zuocheng.session
        WHERE id = $1`,
      [sessionA],
    );
    expect(sessionDevice.rows[0]?.device_public_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    await db.query(
      `INSERT INTO zuocheng.identity_idempotency
         (actor_scope_hash, operation, key_hash, request_hash)
       VALUES (repeat('1', 64), 'account-export-request',
               repeat('2', 64), repeat('3', 64))`,
    );
    const idempotency = await db.query<{
      key_hash: string;
      request_hash: string;
      status: string;
    }>(
      `SELECT key_hash, request_hash, status
         FROM zuocheng.identity_idempotency`,
    );
    expect(idempotency.rows).toEqual([
      {
        key_hash: '2'.repeat(64),
        request_hash: '3'.repeat(64),
        status: 'processing',
      },
    ]);

    const captured = await db.query<{ snapshot: unknown }>(
      `SELECT zuocheng.capture_account_export($1)::jsonb AS snapshot`,
      [userA],
    );
    // PGlite validates the function body and returned shape but does not
    // emulate PostgreSQL SECURITY DEFINER role switching through FORCE RLS.
    // The native PostgreSQL 17 gate below asserts the actual user projection.
    expect(captured.rows[0]?.snapshot).toMatchObject({
      memberships: expect.any(Array),
      projects: expect.any(Array),
      versions: expect.any(Array),
      audit: expect.any(Array),
      courses: [],
      usage: [],
      ledger: [],
    });

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO zuocheng.account_export_request
         (user_id, requested_by_session_id)
       VALUES ($1, $2)
       RETURNING id::text`,
      [userA, sessionA],
    );
    await db.query(
      `UPDATE zuocheng.account_export_request
          SET status = 'ready',
              manifest = '{"schemaVersion":1}'::jsonb,
              manifest_sha256 = repeat('a', 64),
              artifact_url = 'https://customer-storage.example/export.json',
              artifact_sha256 = repeat('a', 64),
              completed_at = now(),
              expires_at = now() + interval '1 day'
        WHERE id = $1`,
      [inserted.rows[0]?.id],
    );
    const exportRow = await db.query<{
      status: string;
      integrity_matches: boolean;
    }>(
      `SELECT status,
              manifest_sha256 = artifact_sha256 AS integrity_matches
         FROM zuocheng.account_export_request
        WHERE id = $1`,
      [inserted.rows[0]?.id],
    );
    expect(exportRow.rows).toEqual([
      { status: 'ready', integrity_matches: true },
    ]);
  });

  it('resolves only unexpired, unrevoked sessions for active users and memberships', async () => {
    await becomeAuth();
    const active = await db.query<{
      session_id: string;
      user_id: string;
      active_tenant_id: string;
    }>(
      `SELECT session_id::text, user_id::text, active_tenant_id::text
         FROM zuocheng.resolve_identity_session($1)`,
      [sessionTokenHash],
    );
    expect(active.rows).toEqual([
      { session_id: sessionA, user_id: userA, active_tenant_id: tenantA },
    ]);

    await db.query(
      `UPDATE zuocheng.session SET revoked_at = now(), revocation_reason = 'user_request'
        WHERE id = $1`,
      [sessionA],
    );
    const revoked = await db.query(
      'SELECT * FROM zuocheng.resolve_identity_session($1)',
      [sessionTokenHash],
    );
    expect(revoked.rows).toEqual([]);

    await db.query(
      `UPDATE zuocheng.session
          SET revoked_at = NULL, revocation_reason = NULL, expires_at = now() - interval '1 second'
        WHERE id = $1`,
      [sessionA],
    );
    const expired = await db.query(
      'SELECT * FROM zuocheng.resolve_identity_session($1)',
      [sessionTokenHash],
    );
    expect(expired.rows).toEqual([]);

    await db.query(
      `UPDATE zuocheng.session SET expires_at = now() + interval '1 hour' WHERE id = $1`,
      [sessionA],
    );
    await db.query(
      `UPDATE zuocheng."user" SET account_status = 'suspended' WHERE id = $1`,
      [userA],
    );
    const suspended = await db.query(
      'SELECT * FROM zuocheng.resolve_identity_session($1)',
      [sessionTokenHash],
    );
    expect(suspended.rows).toEqual([]);
    await db.query(
      `UPDATE zuocheng."user" SET account_status = 'active' WHERE id = $1`,
      [userA],
    );
  });

  it('atomically consumes a live verification value once and rejects expired values', async () => {
    await becomeAuth();
    const liveIdentifier = 'g'.repeat(43);
    const expiredIdentifier = 'h'.repeat(43);
    await db.query(
      `INSERT INTO zuocheng.verification
         (user_id, purpose, identifier_hash, subject_value, created_at, expires_at)
       VALUES
         ($1::uuid, 'recent_auth', $2, ($1::uuid)::text, now(), now() + interval '5 minutes'),
         (
           $1::uuid, 'recent_auth', $3, ($1::uuid)::text,
           now() - interval '2 hours', now() - interval '1 second'
         )`,
      [userA, liveIdentifier, expiredIdentifier],
    );

    const consumed = await db.query<{ identifier_hash: string; subject_value: string }>(
      `SELECT identifier_hash, subject_value
         FROM zuocheng.consume_verification_value($1)`,
      [liveIdentifier],
    );
    expect(consumed.rows).toEqual([
      { identifier_hash: liveIdentifier, subject_value: userA },
    ]);
    expect(
      (await db.query('SELECT * FROM zuocheng.consume_verification_value($1)', [liveIdentifier]))
        .rows,
    ).toEqual([]);
    expect(
      (
        await db.query('SELECT * FROM zuocheng.consume_verification_value($1)', [
          expiredIdentifier,
        ])
      ).rows,
    ).toEqual([]);
  });

  it('rejects plaintext and malformed bearer or recoverable OAuth secrets', async () => {
    await becomeAuth();
    const attacks = [
      db.query(
        `INSERT INTO zuocheng.session
           (user_id, token_hash, expires_at, active_tenant_id, account_status_snapshot)
         VALUES ($1, 'plaintext-session-token', now() + interval '1 hour', $2, 'active')`,
        [userA, tenantA],
      ),
      db.query(
        `INSERT INTO zuocheng.verification
           (user_id, purpose, identifier_hash, subject_value, expires_at)
         VALUES ($1::uuid, 'password_reset', 'plaintext-identifier', ($1::uuid)::text,
                  now() + interval '1 hour')`,
        [userA],
      ),
      db.query(
        `INSERT INTO zuocheng.account
           (user_id, account_id, provider_id, access_token_ciphertext, token_tenant_id,
            token_key_version, token_aad_hash)
         VALUES (
           $1, 'second-provider-subject', 'external-provider', 'raw-access-token',
           $2, 7, repeat('1', 64)
         )`,
        [userA, tenantA],
      ),
      db.query(
        `INSERT INTO zuocheng.verification
           (user_id, tenant_id, purpose, provider_id, identifier_hash, state_ciphertext,
            ciphertext_key_version, ciphertext_aad_hash, expires_at)
         VALUES (
           $1, $2, 'oauth_state', 'external-provider', repeat('i', 43),
           'plaintext-oauth-state', 7, repeat('2', 64), now() + interval '10 minutes'
         )`,
        [userA, tenantA],
      ),
      db.query(
        `INSERT INTO zuocheng.verification
           (purpose, identifier_hash, subject_value, expires_at)
         VALUES (
           'generic', repeat('j', 43), '{"codeVerifier":"plaintext-pkce"}',
           now() + interval '10 minutes'
         )`,
      ),
      db.query(
        `INSERT INTO zuocheng.account
           (user_id, account_id, provider_id, access_token_ciphertext, token_tenant_id,
            token_key_version, token_aad_hash)
         VALUES (
           $1, 'wrong-key-version-subject', 'external-provider', $2,
           $3, 8, repeat('3', 64)
         )`,
        [userA, versionedCiphertext, tenantA],
      ),
    ];

    for (const attack of attacks) {
      await expectSqlState(attack, '23514');
    }
  });

  it('rejects duplicate provider linkage and cross-tenant active-session forgery', async () => {
    await becomeAuth();
    await expectSqlState(
      db.query(
        `INSERT INTO zuocheng.account (user_id, account_id, provider_id)
         VALUES ($1, 'real-provider-subject', 'external-provider')`,
        [userA],
      ),
      '23505',
    );
    await expectSqlState(
      db.query(
        `INSERT INTO zuocheng.session
           (user_id, token_hash, expires_at, active_tenant_id, account_status_snapshot)
         VALUES ($1, repeat('9', 64), now() + interval '1 hour', $2, 'active')`,
        [userA, tenantB],
      ),
      '23503',
    );
    await expectSqlState(
      db.query(
        `INSERT INTO zuocheng.account
           (user_id, account_id, provider_id, access_token_ciphertext, token_tenant_id,
            token_key_version, token_aad_hash)
         VALUES (
           $1, 'cross-tenant-token-subject', 'external-provider', $2,
           $3, 7, repeat('4', 64)
         )`,
        [userA, versionedCiphertext, tenantB],
      ),
      '23503',
    );
  });

  it('keeps tenant application and auth credentials mutually isolated', async () => {
    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_app');
    await expectSqlState(db.query('SELECT * FROM zuocheng.session'), '42501');
    await becomeAuth();
    await expectSqlState(db.query('SELECT * FROM zuocheng.project'), '42501');
    await expectSqlState(db.query('UPDATE zuocheng.identity_audit_event SET payload = payload'), '42501');
  });

  it('persists deletion confirmation/export state and rejects token replay', async () => {
    await becomeAuth();
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO zuocheng.account_deletion_request
         (user_id, requested_by_session_id, confirmation_token_hash, status, export_status,
          scheduled_for)
       VALUES ($1, $2, repeat('7', 64), 'pending_confirmation', 'requested',
               now() + interval '7 days')
       RETURNING id::text`,
      [userA, sessionA],
    );
    expect(inserted.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    const confirmed = await db.query<{ id: string; status: string }>(
      `SELECT id::text, status
         FROM zuocheng.confirm_account_deletion_request(repeat('7', 64))`,
    );
    expect(confirmed.rows).toEqual([{ id: inserted.rows[0]!.id, status: 'pending' }]);
    expect(
      (
        await db.query(
          `SELECT * FROM zuocheng.confirm_account_deletion_request(repeat('7', 64))`,
        )
      ).rows,
    ).toEqual([]);
    await expectSqlState(
      db.query(
        `INSERT INTO zuocheng.account_deletion_request
           (user_id, requested_by_session_id, confirmation_token_hash, status, export_status,
            scheduled_for)
         VALUES ($1, $2, repeat('7', 64), 'pending_confirmation', 'requested',
                 now() + interval '7 days')`,
        [userA, sessionA],
      ),
      '23505',
    );
  });

  it('keeps identity security audit events append-only', async () => {
    await becomeAuth();
    const audit = await db.query<{ id: string }>(
      `INSERT INTO zuocheng.identity_audit_event
         (user_id, tenant_id, session_id, event_type, ip_address_hash, payload)
       VALUES ($1, $2, $3, 'session.revoked', repeat('8', 64), '{"reason":"user_request"}')
       RETURNING id::text`,
      [userA, tenantA, sessionA],
    );
    await becomeAdmin();
    await db.query("SELECT set_config('zuocheng.current_tenant_id', $1, false)", [tenantA]);
    await db.exec('SET ROLE zuocheng_owner');
    await expectSqlState(
      db.query(`UPDATE zuocheng.identity_audit_event SET payload = '{}' WHERE id = $1`, [
        audit.rows[0]!.id,
      ]),
      '55000',
    );
  });
});
