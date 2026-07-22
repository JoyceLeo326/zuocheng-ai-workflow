import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const databaseUrl = process.env.PG17_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('PG17_DATABASE_URL is required for the native PostgreSQL 17 release gate');
}

const migrationPath = fileURLToPath(new URL('../migrations/0000_foundation.sql', import.meta.url));
const basePsqlArgs = [
  '--no-psqlrc',
  '--set',
  'ON_ERROR_STOP=1',
  '--set',
  'VERBOSITY=verbose',
  '--dbname',
  databaseUrl,
];

function psql(args) {
  const result = spawnSync(
    'psql',
    [...basePsqlArgs, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `psql exited with status ${result.status}`);
  }

  return result.stdout.trim();
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

psql(['--file', migrationPath]);

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

if (forcedRlsCount !== 9) {
  throw new Error(`expected nine FORCE RLS tables; found ${forcedRlsCount}`);
}

const tenantId = '01900000-0000-7000-8000-000000000101';
const userA = '01900000-0000-7000-8000-000000000102';
const userB = '01900000-0000-7000-8000-000000000103';
const projectId = '01900000-0000-7000-8000-000000000104';
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
   END
   $roles$;
   GRANT zuocheng_app TO zuocheng_qa_device_a, zuocheng_qa_device_b;
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
  'PostgreSQL 17 migration, FORCE RLS and two-connection CAS gate passed\n',
);
