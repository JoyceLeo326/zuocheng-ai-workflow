import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const databaseUrl = process.env.PG17_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('PG17_DATABASE_URL is required for the native PostgreSQL 17 release gate');
}

const migrationPaths = [
  fileURLToPath(new URL('../migrations/0000_foundation.sql', import.meta.url)),
  fileURLToPath(new URL('../migrations/0001_identity.sql', import.meta.url)),
];
const basePsqlArgs = [
  '--no-psqlrc',
  '--set',
  'ON_ERROR_STOP=1',
  '--set',
  'VERBOSITY=verbose',
  '--dbname',
  databaseUrl,
];

function psqlResult(args) {
  return spawnSync(
    'psql',
    [...basePsqlArgs, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function psql(args) {
  const result = psqlResult(args);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `psql exited with status ${result.status}`);
  }

  return result.stdout.trim();
}

function expectPsqlFailure(sql, expectedCode, description) {
  const result = psqlResult(['--command', sql]);
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stderr}\n${result.stdout}`;
  if (result.status === 0 || !output.includes(expectedCode)) {
    throw new Error(
      `${description} did not fail with SQLSTATE ${expectedCode}\n${output}`.trim(),
    );
  }
}

function startPsql(sql) {
  const child = spawn(
    'psql',
    [...basePsqlArgs, '--command', sql],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
  return result;
}

async function waitForCount(sql, expected, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = Number(psql(['--tuples-only', '--no-align', '--command', sql]));
    if (count === expected) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

const serverVersion = Number(
  psql(['--tuples-only', '--no-align', '--command', 'SHOW server_version_num']),
);

if (serverVersion < 170000 || serverVersion >= 180000) {
  throw new Error(`PostgreSQL 17 required; server_version_num was ${serverVersion}`);
}

for (const migrationPath of migrationPaths) {
  psql(['--file', migrationPath]);
}

const forcedRlsCount = Number(
  psql([
    '--tuples-only',
    '--no-align',
    '--command',
    `SELECT count(*)
       FROM pg_catalog.pg_class AS relation
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'zuocheng'
        AND relation.relkind = 'r'
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity`,
  ]),
);

if (forcedRlsCount !== 15) {
  throw new Error(`expected fifteen FORCE RLS tables; found ${forcedRlsCount}`);
}

const tenantId = '01900000-0000-7000-8000-000000000101';
const userA = '01900000-0000-7000-8000-000000000102';
const userB = '01900000-0000-7000-8000-000000000103';
const projectId = '01900000-0000-7000-8000-000000000104';
const identitySessionId = '01900000-0000-7000-8000-000000000107';
const identityTokenHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const verificationIdentifierHash = 'ddddddddddddddddddddddddddddddddddddddddddd';
const oauthStateIdentifierHash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const expiredVerificationIdentifierHash = 'ggggggggggggggggggggggggggggggggggggggggggg';
const tokenAadHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const versionedCiphertext = `$ba$7$${'ab'.repeat(32)}`;
const advisoryKey = 20260723;

psql([
  '--command',
  `DO $roles$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zuocheng_qa_device_a') THEN
       CREATE ROLE zuocheng_qa_device_a LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zuocheng_qa_device_b') THEN
       CREATE ROLE zuocheng_qa_device_b LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zuocheng_qa_auth') THEN
       CREATE ROLE zuocheng_qa_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
     END IF;
   END
   $roles$;
   GRANT zuocheng_app TO zuocheng_qa_device_a, zuocheng_qa_device_b;
   GRANT zuocheng_auth TO zuocheng_qa_auth WITH SET TRUE, INHERIT FALSE;
   BEGIN;
   SELECT set_config('zuocheng.current_tenant_id', '${tenantId}', true);
   INSERT INTO zuocheng.tenant (id, slug, display_name)
     VALUES ('${tenantId}', 'native-cas', 'Native CAS');
   INSERT INTO zuocheng."user" (id, email, display_name) VALUES
     ('${userA}', 'device-a@example.test', 'Device A'),
     ('${userB}', 'device-b@example.test', 'Device B');
   INSERT INTO zuocheng.membership (tenant_id, id, user_id, role, status) VALUES
     ('${tenantId}', '01900000-0000-7000-8000-000000000105', '${userA}', 'member', 'active'),
     ('${tenantId}', '01900000-0000-7000-8000-000000000106', '${userB}', 'member', 'active');
   INSERT INTO zuocheng.runtime_principal (login_role, tenant_id, user_id) VALUES
     ('zuocheng_qa_device_a', '${tenantId}', '${userA}'),
     ('zuocheng_qa_device_b', '${tenantId}', '${userB}');
   INSERT INTO zuocheng.project
     (tenant_id, id, created_by_user_id, updated_by_user_id, name, description)
     VALUES ('${tenantId}', '${projectId}', '${userA}', '${userA}', 'Concurrent baseline', 'Initial');
   INSERT INTO zuocheng.project_acl
     (tenant_id, project_id, principal_user_id, access_level) VALUES
     ('${tenantId}', '${projectId}', '${userA}', 'owner'),
     ('${tenantId}', '${projectId}', '${userB}', 'editor');
   INSERT INTO zuocheng.project_version
     (tenant_id, project_id, version, snapshot, created_by_user_id)
     VALUES (
       '${tenantId}', '${projectId}', 1,
       '{"name":"Concurrent baseline","description":"Initial","status":"active","deletionStatus":"active"}'::jsonb,
       '${userA}'
     );
   COMMIT;`,
]);

psql([
  '--command',
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   INSERT INTO zuocheng.account
     (user_id, account_id, provider_id, password_hash)
     VALUES (
       '${userA}', '${userA}', 'credential', '$scrypt$native-password-hash'
     );
   INSERT INTO zuocheng.account
     (user_id, account_id, provider_id, scope, access_token_ciphertext,
      refresh_token_ciphertext, token_tenant_id, token_key_version, token_aad_hash)
     VALUES (
       '${userA}', 'native-real-subject', 'native-external-provider', 'openid email',
       '${versionedCiphertext}', '${versionedCiphertext}', '${tenantId}', 7, '${tokenAadHash}'
     );
   INSERT INTO zuocheng.session
     (id, user_id, token_hash, expires_at, active_tenant_id, account_status_snapshot,
      device_id_hash, device_name, user_agent, ip_address_hash)
     VALUES (
       '${identitySessionId}', '${userA}', '${identityTokenHash}',
       now() + interval '1 hour', '${tenantId}', 'active', repeat('b', 64),
       'Native browser', 'PostgreSQL 17 QA', repeat('c', 64)
     );
   INSERT INTO zuocheng.verification
     (user_id, purpose, identifier_hash, subject_value, expires_at)
     VALUES (
       '${userA}', 'password_reset', '${verificationIdentifierHash}', '${userA}',
       now() + interval '10 minutes'
     );
   INSERT INTO zuocheng.verification
     (user_id, tenant_id, purpose, provider_id, identifier_hash, state_ciphertext,
      ciphertext_key_version, ciphertext_aad_hash, expires_at)
     VALUES (
       '${userA}', '${tenantId}', 'oauth_state', 'native-external-provider',
       '${oauthStateIdentifierHash}', '${versionedCiphertext}', 7, '${tokenAadHash}',
       now() + interval '10 minutes'
     );
   INSERT INTO zuocheng.verification
     (user_id, purpose, identifier_hash, subject_value, created_at, expires_at)
     VALUES (
       '${userA}', 'recent_auth', '${expiredVerificationIdentifierHash}', '${userA}',
       now() - interval '2 hours', now() - interval '1 hour'
     );
   INSERT INTO zuocheng.passkey
     (user_id, name, public_key, credential_id, counter, device_type, backed_up,
      transports, aaguid)
     VALUES (
       '${userA}', 'Native security key', 'base64url-public-key',
       'native-credential-id', 0, 'singleDevice', false, 'usb,nfc',
       '00000000-0000-0000-0000-000000000000'
     );`,
]);

const activeIdentitySessionCount = Number(psql([
  '--tuples-only',
  '--no-align',
  '--command',
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   SELECT count(*) FROM zuocheng.resolve_identity_session('${identityTokenHash}');`,
]).split(/\r?\n/).at(-1));
if (activeIdentitySessionCount !== 1) {
  throw new Error(`expected one active identity session; found ${activeIdentitySessionCount}`);
}

const consumedVerificationCount = Number(psql([
  '--tuples-only',
  '--no-align',
  '--command',
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   SELECT count(*)
     FROM zuocheng.consume_verification_value('${verificationIdentifierHash}');`,
]).split(/\r?\n/).at(-1));
if (consumedVerificationCount !== 1) {
  throw new Error(`expected one consumed verification value; found ${consumedVerificationCount}`);
}

const replayedOrExpiredVerificationCount = Number(psql([
  '--tuples-only',
  '--no-align',
  '--command',
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   SELECT (
     (SELECT count(*)
        FROM zuocheng.consume_verification_value('${verificationIdentifierHash}'))
     +
     (SELECT count(*)
        FROM zuocheng.consume_verification_value('${expiredVerificationIdentifierHash}'))
   );`,
]).split(/\r?\n/).at(-1));
if (replayedOrExpiredVerificationCount !== 0) {
  throw new Error(
    `expected replayed and expired verification values to be rejected; found ${replayedOrExpiredVerificationCount}`,
  );
}

expectPsqlFailure(
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   INSERT INTO zuocheng.session
     (user_id, token_hash, expires_at, active_tenant_id, account_status_snapshot)
     VALUES (
       '${userA}', 'plaintext-session-token', now() + interval '1 hour',
       '${tenantId}', 'active'
     );`,
  '23514',
  'plaintext session token attack',
);

expectPsqlFailure(
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   INSERT INTO zuocheng.account
     (user_id, account_id, provider_id, access_token_ciphertext, token_tenant_id,
      token_key_version, token_aad_hash)
     VALUES (
       '${userA}', 'native-plaintext-token-subject', 'native-external-provider',
       'raw-access-token', '${tenantId}', 7, repeat('1', 64)
     );`,
  '23514',
  'plaintext OAuth access token attack',
);

expectPsqlFailure(
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   INSERT INTO zuocheng.verification
     (user_id, tenant_id, purpose, provider_id, identifier_hash, state_ciphertext,
      ciphertext_key_version, ciphertext_aad_hash, expires_at)
     VALUES (
       '${userA}', '${tenantId}', 'oauth_state', 'native-external-provider',
       'iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii', 'plaintext-oauth-state',
       7, repeat('2', 64), now() + interval '10 minutes'
     );`,
  '23514',
  'plaintext OAuth state attack',
);

expectPsqlFailure(
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   INSERT INTO zuocheng.verification
     (purpose, identifier_hash, subject_value, expires_at)
     VALUES (
       'generic', 'jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj',
       '{"codeVerifier":"plaintext-pkce"}', now() + interval '10 minutes'
     );`,
  '23514',
  'unadapted plaintext OAuth state attack',
);

expectPsqlFailure(
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   INSERT INTO zuocheng.account
     (user_id, account_id, provider_id, access_token_ciphertext, token_tenant_id,
      token_key_version, token_aad_hash)
     VALUES (
       '${userA}', 'native-wrong-key-version-subject', 'native-external-provider',
       '${versionedCiphertext}', '${tenantId}', 8, repeat('3', 64)
     );`,
  '23514',
  'OAuth ciphertext key-version substitution attack',
);

expectPsqlFailure(
  `SET SESSION AUTHORIZATION zuocheng_qa_device_a;
   SET ROLE zuocheng_app;
   SELECT * FROM zuocheng.account;`,
  '42501',
  'tenant application OAuth-ciphertext read',
);

expectPsqlFailure(
  `SET SESSION AUTHORIZATION zuocheng_qa_auth;
   SET ROLE zuocheng_auth;
   SELECT * FROM zuocheng.project;`,
  '42501',
  'zuocheng_auth project-table read',
);

const deviceA = startPsql(
  `BEGIN;
   SET application_name = 'zuocheng-qa-device-a';
   SET SESSION AUTHORIZATION zuocheng_qa_device_a;
   SET LOCAL ROLE zuocheng_app;
   SELECT set_config('zuocheng.current_tenant_id', '${tenantId}', true);
   SELECT zuocheng.require_app_context('${tenantId}', '${userA}');
   SELECT count(*) FROM zuocheng.lock_project_for_mutation('${tenantId}', '${projectId}', '${userA}');
   SELECT pg_advisory_xact_lock(${advisoryKey});
   SELECT pg_sleep(5);
   CALL zuocheng.update_project_content(
     '${tenantId}', '${projectId}', 1, '${userA}', 'Device A edit', 'Committed winner'
   );
   COMMIT;`,
);

await waitForCount(
  `SELECT count(*) FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory' AND classid = 0
      AND objid = ${advisoryKey} AND objsubid = 1 AND granted`,
  1,
  'device A to hold the project row',
);

const deviceB = startPsql(
  `BEGIN;
   SET application_name = 'zuocheng-qa-device-b';
   SET SESSION AUTHORIZATION zuocheng_qa_device_b;
   SET LOCAL ROLE zuocheng_app;
   SELECT set_config('zuocheng.current_tenant_id', '${tenantId}', true);
   SELECT zuocheng.require_app_context('${tenantId}', '${userB}');
   CALL zuocheng.update_project_content(
     '${tenantId}', '${projectId}', 1, '${userB}', 'Device B stale edit', 'Must not commit'
   );
   COMMIT;`,
);

await waitForCount(
  `SELECT count(*) FROM pg_catalog.pg_stat_activity
    WHERE application_name = 'zuocheng-qa-device-b'
      AND wait_event_type = 'Lock'`,
  1,
  'device B to block on the project row lock',
);

const [deviceAResult, deviceBResult] = await Promise.all([deviceA, deviceB]);
if (deviceAResult.status !== 0) {
  throw new Error(deviceAResult.stderr || deviceAResult.stdout || 'device A CAS failed');
}
if (deviceBResult.status === 0 || !`${deviceBResult.stderr}\n${deviceBResult.stdout}`.includes('40001')) {
  throw new Error(
    deviceBResult.stderr || deviceBResult.stdout || 'device B did not fail with SQLSTATE 40001',
  );
}

const finalProject = psql([
  '--tuples-only',
  '--no-align',
  '--command',
  `SELECT version::text || '|' || name
     FROM zuocheng.project
    WHERE tenant_id = '${tenantId}' AND id = '${projectId}'`,
]);
if (finalProject !== '2|Device A edit') {
  throw new Error(`unexpected concurrent CAS winner state: ${finalProject}`);
}

const versionCount = Number(psql([
  '--tuples-only',
  '--no-align',
  '--command',
  `SELECT count(*) FROM zuocheng.project_version
    WHERE tenant_id = '${tenantId}' AND project_id = '${projectId}'`,
]));
if (versionCount !== 2) {
  throw new Error(`expected exactly two project_version snapshots; found ${versionCount}`);
}

process.stdout.write(
  'PostgreSQL 17 ordered migrations, identity attacks, FORCE RLS and two-connection CAS gate passed\n',
);
