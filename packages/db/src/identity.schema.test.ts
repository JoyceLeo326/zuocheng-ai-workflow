import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  account,
  accountDeletionRequest,
  BETTER_AUTH_SCHEMA_VERSION,
  identityAuditEvent,
  identityTables,
  passkey,
  session,
  user,
  verification,
} from './schema.js';

const migration = readFileSync(
  fileURLToPath(new URL('../migrations/0001_identity.sql', import.meta.url)),
  'utf8',
);
const nativePg17Qa = readFileSync(
  fileURLToPath(new URL('../qa/postgres17.mjs', import.meta.url)),
  'utf8',
);

const expectedIdentityTableNames = [
  'account',
  'session',
  'verification',
  'passkey',
  'identity_audit_event',
  'account_deletion_request',
] as const;

const checkNames = (table: (typeof identityTables)[number]) =>
  getTableConfig(table).checks.map((constraint) => constraint.name);

describe('ZC-03 identity schema', () => {
  it('pins the stable Better Auth core and Passkey schema contract', () => {
    expect(BETTER_AUTH_SCHEMA_VERSION).toBe('1.6.25');
    expect(identityTables.map(getTableName)).toEqual(expectedIdentityTableNames);

    for (const table of identityTables) {
      expect(getTableConfig(table).schema).toBe('zuocheng');
      expect(getTableConfig(table).enableRLS, `${getTableName(table)} RLS metadata`).toBe(true);
      expect(table.id).toMatchObject({
        notNull: true,
        hasDefault: true,
      });
      expect(table.id.getSQLType()).toBe('uuid');
    }
  });

  it('extends the existing user instead of creating an incompatible auth user', () => {
    expect(getTableName(user)).toBe('user');
    expect(user.displayName).toMatchObject({ notNull: true });
    expect(user.emailVerified).toMatchObject({ notNull: true, hasDefault: true });
    expect(user.image).toMatchObject({ notNull: false });
    expect(user.accountStatus).toMatchObject({ notNull: true, hasDefault: true });
    expect(user.activeTenantId).toMatchObject({ notNull: false });
    expect(getTableConfig(user).checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining(['user_account_status_valid', 'user_deletion_state_valid']),
    );
  });

  it('contains every stable Better Auth core field with explicit secure storage semantics', () => {
    expect(account).toMatchObject({
      id: expect.anything(),
      userId: expect.anything(),
      accountId: expect.anything(),
      providerId: expect.anything(),
      accessToken: expect.anything(),
      refreshToken: expect.anything(),
      accessTokenExpiresAt: expect.anything(),
      refreshTokenExpiresAt: expect.anything(),
      scope: expect.anything(),
      idToken: expect.anything(),
      password: expect.anything(),
      createdAt: expect.anything(),
      updatedAt: expect.anything(),
    });
    expect(session).toMatchObject({
      id: expect.anything(),
      userId: expect.anything(),
      token: expect.anything(),
      expiresAt: expect.anything(),
      ipAddress: expect.anything(),
      userAgent: expect.anything(),
      createdAt: expect.anything(),
      updatedAt: expect.anything(),
    });
    expect(verification).toMatchObject({
      id: expect.anything(),
      identifier: expect.anything(),
      value: expect.anything(),
      expiresAt: expect.anything(),
      createdAt: expect.anything(),
      updatedAt: expect.anything(),
    });
  });

  it('stores selectors as hashes and recoverable OAuth material only as versioned ciphertext', () => {
    expect(session.token.name).toBe('token_hash');
    expect(session.token.getSQLType()).toBe('char(64)');
    expect(session.ipAddress.name).toBe('ip_address_hash');
    expect(account.accessToken.name).toBe('access_token_ciphertext');
    expect(account.refreshToken.name).toBe('refresh_token_ciphertext');
    expect(account.idToken.name).toBe('id_token_ciphertext');
    expect(account.tokenTenantId.name).toBe('token_tenant_id');
    expect(account.tokenKeyVersion.name).toBe('token_key_version');
    expect(account.tokenAadHash.name).toBe('token_aad_hash');
    expect(verification.identifier.name).toBe('identifier_hash');
    expect(verification.identifier.getSQLType()).toBe('varchar(64)');
    expect(verification.value.name).toBe('subject_value');
    expect(verification.stateCiphertext.name).toBe('state_ciphertext');
    expect(verification.ciphertextKeyVersion.name).toBe('ciphertext_key_version');
    expect(verification.ciphertextAadHash.name).toBe('ciphertext_aad_hash');
    expect(accountDeletionRequest.confirmationToken.name).toBe('confirmation_token_hash');

    expect(migration).not.toMatch(
      /\b(session_token|confirmation_token)\s+(?:text|varchar)\b/i,
    );
    expect(migration).toMatch(/session_token_hash_valid[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
    expect(migration).toMatch(
      /verification_identifier_hash_valid[\s\S]*\^\[A-Za-z0-9_-\]\{43\}\$/i,
    );
    expect(migration).toMatch(
      /account_token_ciphertext_valid[\s\S]*\\\$ba\\\$[\s\S]*token_key_version/i,
    );
    expect(migration).toMatch(
      /verification_state_ciphertext_valid[\s\S]*\\\$ba\\\$[\s\S]*ciphertext_key_version/i,
    );
    expect(migration).not.toMatch(/\baccess_token_hash\b|\brefresh_token_hash\b|\bid_token_hash\b/i);
  });

  it('models password credentials and generic OAuth linkage without inventing providers', () => {
    const config = getTableConfig(account);
    expect(account.password.name).toBe('password_hash');
    expect(
      config.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
    ).toContainEqual(['provider_id', 'account_id']);
    expect(checkNames(account)).toEqual(
      expect.arrayContaining([
        'account_provider_id_nonempty',
        'account_account_id_nonempty',
        'account_credential_shape_valid',
        'account_token_bundle_valid',
        'account_token_ciphertext_valid',
        'account_token_aad_valid',
      ]),
    );
    expect(migration).not.toMatch(/INSERT\s+INTO\s+zuocheng\.account/i);
    expect(migration).not.toMatch(/provider_id\s+IN\s*\(\s*'google'/i);
  });

  it('atomically consumes only live verification values and deletion confirmations once', () => {
    expect(checkNames(verification)).toEqual(
      expect.arrayContaining([
        'verification_identifier_hash_valid',
        'verification_payload_storage_valid',
        'verification_state_ciphertext_valid',
        'verification_state_aad_valid',
      ]),
    );
    expect(migration).toMatch(
      /CREATE\s+FUNCTION\s+zuocheng\.consume_verification_value[\s\S]*UPDATE\s+zuocheng\.verification[\s\S]*consumed_at\s+IS\s+NULL[\s\S]*expires_at\s*>\s*now\(\)/i,
    );
    expect(migration).toMatch(
      /CREATE\s+FUNCTION\s+zuocheng\.confirm_account_deletion_request[\s\S]*status\s*=\s*'pending_confirmation'[\s\S]*confirmation_expires_at\s*>\s*now\(\)/i,
    );
  });

  it('persists device, expiry, revocation, active tenant, and account status gates', () => {
    expect(session.activeTenantId).toMatchObject({ notNull: false });
    expect(session.accountStatusSnapshot).toMatchObject({ notNull: true, hasDefault: true });
    expect(session.deviceIdHash.getSQLType()).toBe('char(64)');
    expect(session.revokedAt).toMatchObject({ notNull: false });
    expect(session.lastSeenAt).toMatchObject({ notNull: true, hasDefault: true });
    expect(checkNames(session)).toEqual(
      expect.arrayContaining([
        'session_token_hash_valid',
        'session_device_id_hash_valid',
        'session_account_status_valid',
        'session_expiry_valid',
        'session_revocation_valid',
      ]),
    );

    const sessionForeignKeys = getTableConfig(session).foreignKeys.map((foreignKey) =>
      foreignKey.reference().columns.map((column) => column.name),
    );
    expect(sessionForeignKeys).toContainEqual(['active_tenant_id', 'user_id']);
    expect(migration).toMatch(
      /CREATE\s+FUNCTION\s+zuocheng\.resolve_identity_session[\s\S]*account_status\s*=\s*'active'[\s\S]*membership_status\s*=\s*'active'/i,
    );
  });

  it('matches the Better Auth Passkey plugin and adds revocation/audit fields', () => {
    expect(passkey).toMatchObject({
      id: expect.anything(),
      name: expect.anything(),
      publicKey: expect.anything(),
      userId: expect.anything(),
      credentialId: expect.anything(),
      counter: expect.anything(),
      deviceType: expect.anything(),
      backedUp: expect.anything(),
      transports: expect.anything(),
      createdAt: expect.anything(),
      aaguid: expect.anything(),
      lastUsedAt: expect.anything(),
      revokedAt: expect.anything(),
    });
    expect(passkey.credentialId.name).toBe('credential_id');
    expect(
      getTableConfig(passkey).uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
    ).toContainEqual(['credential_id']);
    expect(checkNames(passkey)).toEqual(
      expect.arrayContaining(['passkey_counter_nonnegative', 'passkey_device_type_valid']),
    );
  });

  it('has auditable account-deletion and data-export lifecycle persistence', () => {
    expect(accountDeletionRequest).toMatchObject({
      userId: expect.anything(),
      requestedBySessionId: expect.anything(),
      status: expect.anything(),
      exportStatus: expect.anything(),
      requestedAt: expect.anything(),
      scheduledFor: expect.anything(),
      completedAt: expect.anything(),
      cancelledAt: expect.anything(),
    });
    expect(identityAuditEvent).toMatchObject({
      userId: expect.anything(),
      tenantId: expect.anything(),
      sessionId: expect.anything(),
      eventType: expect.anything(),
      payload: expect.anything(),
      occurredAt: expect.anything(),
    });
    expect(checkNames(accountDeletionRequest)).toEqual(
      expect.arrayContaining([
        'account_deletion_request_status_valid',
        'account_deletion_request_export_status_valid',
        'account_deletion_request_lifecycle_valid',
      ]),
    );
    expect(migration).toMatch(
      /CREATE\s+TRIGGER\s+identity_audit_event_append_only[\s\S]*reject_append_only_mutation/i,
    );
  });

  it('forces RLS and isolates the auth role from tenant business tables', () => {
    for (const tableName of expectedIdentityTableNames) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE zuocheng\\.${tableName} ENABLE ROW LEVEL SECURITY;[\\s\\S]*` +
            `ALTER TABLE zuocheng\\.${tableName} FORCE ROW LEVEL SECURITY;`,
          'i',
        ),
      );
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE zuocheng\\.${tableName} OWNER TO zuocheng_owner`, 'i'),
      );
    }

    expect(migration).toMatch(
      /CREATE ROLE zuocheng_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/i,
    );
    expect(migration).not.toMatch(/GRANT\s+zuocheng_app\s+TO\s+zuocheng_auth/i);
    expect(migration).not.toMatch(/GRANT[\s\S]*ON\s+zuocheng\.project[\s\S]*TO\s+zuocheng_auth/i);
    expect(migration).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA zuocheng FROM PUBLIC/i);
  });

  it('extends the native PostgreSQL 17 release gate through ordered identity attacks', () => {
    expect(nativePg17Qa).toMatch(
      /0000_foundation\.sql[\s\S]*0001_identity\.sql[\s\S]*0002_account_rights\.sql[\s\S]*for \(const migrationPath of migrationPaths\)/i,
    );
    expect(nativePg17Qa).toMatch(/forcedRlsCount !== 17/i);
    expect(nativePg17Qa).toMatch(/SET SESSION AUTHORIZATION zuocheng_qa_auth/i);
    expect(nativePg17Qa).toMatch(/resolve_identity_session/i);
    expect(nativePg17Qa).toMatch(/plaintext-session-token/i);
    expect(nativePg17Qa).toMatch(/raw-access-token/i);
    expect(nativePg17Qa).toMatch(/plaintext-oauth-state/i);
    expect(nativePg17Qa).toMatch(/consume_verification_value/i);
    expect(nativePg17Qa).toMatch(/capture_account_export/i);
    expect(nativePg17Qa).toMatch(/raw identity idempotency key attack/i);
    expect(nativePg17Qa).toMatch(/zuocheng_auth[\s\S]*zuocheng\.project/i);
  });
});
