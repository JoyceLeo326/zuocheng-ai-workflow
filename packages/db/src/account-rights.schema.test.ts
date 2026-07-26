import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(
    new URL('../migrations/0002_account_rights.sql', import.meta.url),
  ),
  'utf8',
);

describe('ZC-03 account rights persistence', () => {
  it('persists account exports, identity idempotency and public device ids', () => {
    expect(migration).toMatch(
      /CREATE TABLE zuocheng\.identity_idempotency/,
    );
    expect(migration).toMatch(
      /CREATE TABLE zuocheng\.account_export_request/,
    );
    expect(migration).toMatch(
      /ADD COLUMN device_public_id uuid NOT NULL DEFAULT zuocheng\.uuid_v7\(\)/,
    );
    expect(migration).toMatch(
      /manifest_sha256 char\(64\)/,
    );
    expect(migration).toMatch(
      /artifact_sha256 char\(64\)/,
    );
  });

  it('keeps sensitive keys as digests and rights tables behind forced RLS', () => {
    expect(migration).toMatch(
      /idempotency_key_hash_valid[\s\S]*\^\[0-9a-f\]\{64\}\$/,
    );
    expect(migration).not.toMatch(
      /\b(?:raw_token|recent_auth_token|confirmation_token)\s+(?:text|varchar)/i,
    );
    for (const table of [
      'identity_idempotency',
      'account_export_request',
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE zuocheng\\.${table} ENABLE ROW LEVEL SECURITY;[\\s\\S]*` +
            `ALTER TABLE zuocheng\\.${table} FORCE ROW LEVEL SECURITY;`,
          'i',
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE zuocheng\\.${table} OWNER TO zuocheng_owner`,
          'i',
        ),
      );
    }
  });

  it('allows only the customer identity role and never grants project-party fallbacks', () => {
    expect(migration).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON[\s\S]*identity_idempotency[\s\S]*account_export_request[\s\S]*TO zuocheng_auth/i,
    );
    expect(migration).not.toMatch(
      /GRANT[\s\S]*TO\s+(?:PUBLIC|zuocheng_app)/i,
    );
  });
});
