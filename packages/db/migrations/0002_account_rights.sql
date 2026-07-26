BEGIN;

DO $dependency$
BEGIN
  IF to_regclass('zuocheng.session') IS NULL
     OR to_regclass('zuocheng.account_deletion_request') IS NULL
     OR to_regprocedure('zuocheng.uuid_v7()') IS NULL THEN
    RAISE EXCEPTION '0002_account_rights.sql requires 0001_identity.sql'
      USING ERRCODE = '3F000';
  END IF;
END
$dependency$;

SET LOCAL ROLE zuocheng_owner;

-- A public device identifier is safe to return to the account UI. The
-- existing device_id_hash remains the non-reversible correlation key and is
-- never exposed.
ALTER TABLE zuocheng.session
  ADD COLUMN device_public_id uuid NOT NULL DEFAULT zuocheng.uuid_v7(),
  ADD CONSTRAINT session_device_public_id_unique UNIQUE (device_public_id);

ALTER TABLE zuocheng.account_deletion_request
  ADD COLUMN irreversible_at timestamptz,
  ADD COLUMN failure_code varchar(160),
  ADD CONSTRAINT account_deletion_irreversible_state_valid CHECK (
    (irreversible_at IS NULL)
    OR status IN ('processing', 'completed')
  ),
  ADD CONSTRAINT account_deletion_failure_state_valid CHECK (
    (failure_code IS NULL)
    OR status = 'rejected'
  );

-- Raw idempotency keys and request bodies are not identity data. Only SHA-256
-- digests are retained. No response body is stored because lifecycle
-- responses can contain signed session cookies or recent-auth bearer values.
CREATE TABLE zuocheng.identity_idempotency (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  actor_scope_hash char(64) NOT NULL,
  operation varchar(96) NOT NULL,
  key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CONSTRAINT identity_idempotency_actor_operation_key_unique
    UNIQUE (actor_scope_hash, operation, key_hash),
  CONSTRAINT identity_idempotency_actor_scope_hash_valid
    CHECK (actor_scope_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_key_hash_valid
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_idempotency_request_hash_valid
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT identity_idempotency_operation_nonempty
    CHECK (btrim(operation) <> ''),
  CONSTRAINT identity_idempotency_status_valid
    CHECK (status IN ('processing', 'completed')),
  CONSTRAINT identity_idempotency_completion_valid CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT identity_idempotency_expiry_valid CHECK (
    expires_at > created_at
  )
);

CREATE INDEX identity_idempotency_expiry_idx
  ON zuocheng.identity_idempotency (expires_at);

-- The manifest is the non-secret inventory used to prove what was exported.
-- The artifact itself belongs to customer/tenant BYOS and is referenced only
-- after its integrity receipt matches artifact_sha256.
CREATE TABLE zuocheng.account_export_request (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  user_id uuid NOT NULL,
  requested_by_session_id uuid,
  status text NOT NULL DEFAULT 'processing',
  manifest jsonb,
  manifest_sha256 char(64),
  artifact_url text,
  artifact_sha256 char(64),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  failure_code varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_export_request_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT account_export_request_session_fk
    FOREIGN KEY (requested_by_session_id)
    REFERENCES zuocheng.session (id) ON DELETE RESTRICT,
  CONSTRAINT account_export_request_status_valid CHECK (
    status IN ('pending', 'processing', 'ready', 'failed', 'expired')
  ),
  CONSTRAINT account_export_manifest_shape_valid CHECK (
    manifest IS NULL OR jsonb_typeof(manifest) = 'object'
  ),
  CONSTRAINT account_export_manifest_hash_valid CHECK (
    manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT account_export_artifact_hash_valid CHECK (
    artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT account_export_ready_state_valid CHECK (
    (
      status = 'ready'
      AND manifest IS NOT NULL
      AND manifest_sha256 IS NOT NULL
      AND artifact_url IS NOT NULL
      AND artifact_sha256 = manifest_sha256
      AND completed_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND expires_at > completed_at
      AND failure_code IS NULL
    )
    OR (
      status <> 'ready'
      AND (
        manifest IS NULL
        OR (
          manifest_sha256 IS NOT NULL
          AND artifact_url IS NOT NULL
          AND artifact_sha256 IS NOT NULL
        )
      )
    )
  ),
  CONSTRAINT account_export_failure_state_valid CHECK (
    (status = 'failed') = (failure_code IS NOT NULL)
  )
);

CREATE INDEX account_export_request_user_requested_idx
  ON zuocheng.account_export_request (user_id, requested_at);
CREATE INDEX account_export_request_expiry_idx
  ON zuocheng.account_export_request (expires_at)
  WHERE status = 'ready';

-- This owner-defined projection is the only identity-runtime path into
-- business tables. It returns explicit non-secret fields for one user and
-- cannot be repurposed to read project ACL, idempotency payloads or deletion
-- internals. Product areas not installed yet remain explicit empty indexes.
--
-- FORCE RLS still applies inside the SECURITY DEFINER function. These policies
-- expose only rows associated with the transaction-local export subject that
-- the function installs before reading. The runtime role cannot assume the
-- NOLOGIN owner role, and no policy accepts a missing export subject.
CREATE POLICY user_owner_export_policy ON zuocheng."user"
  FOR SELECT TO zuocheng_owner
  USING (
    id = NULLIF(
      current_setting('zuocheng.current_export_user_id', true),
      ''
    )::uuid
  );

CREATE POLICY membership_owner_export_policy ON zuocheng.membership
  FOR SELECT TO zuocheng_owner
  USING (
    user_id = NULLIF(
      current_setting('zuocheng.current_export_user_id', true),
      ''
    )::uuid
  );

CREATE POLICY project_acl_owner_export_policy ON zuocheng.project_acl
  FOR SELECT TO zuocheng_owner
  USING (
    principal_user_id = NULLIF(
      current_setting('zuocheng.current_export_user_id', true),
      ''
    )::uuid
  );

CREATE POLICY project_owner_export_policy ON zuocheng.project
  FOR SELECT TO zuocheng_owner
  USING (
    created_by_user_id = NULLIF(
      current_setting('zuocheng.current_export_user_id', true),
      ''
    )::uuid
    OR updated_by_user_id = NULLIF(
      current_setting('zuocheng.current_export_user_id', true),
      ''
    )::uuid
    OR EXISTS (
      SELECT 1
      FROM zuocheng.project_acl AS export_acl
      WHERE export_acl.tenant_id = project.tenant_id
        AND export_acl.project_id = project.id
        AND export_acl.principal_user_id = NULLIF(
          current_setting('zuocheng.current_export_user_id', true),
          ''
        )::uuid
        AND export_acl.deleted_at IS NULL
    )
    OR EXISTS (
      SELECT 1
      FROM zuocheng.membership AS export_member
      WHERE export_member.tenant_id = project.tenant_id
        AND export_member.user_id = NULLIF(
          current_setting('zuocheng.current_export_user_id', true),
          ''
        )::uuid
        AND export_member.status = 'active'
        AND export_member.deleted_at IS NULL
    )
  );

CREATE POLICY project_version_owner_export_policy
  ON zuocheng.project_version
  FOR SELECT TO zuocheng_owner
  USING (
    EXISTS (
      SELECT 1
      FROM zuocheng.project AS export_project
      WHERE export_project.tenant_id = project_version.tenant_id
        AND export_project.id = project_version.project_id
    )
  );

CREATE FUNCTION zuocheng.capture_account_export(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
BEGIN
  PERFORM set_config(
    'zuocheng.current_export_user_id',
    p_user_id::text,
    true
  );

  RETURN jsonb_build_object(
    'account',
      (
        SELECT jsonb_build_object(
          'id', account_user.id,
          'email', account_user.email,
          'displayName', account_user.display_name,
          'accountStatus', account_user.account_status,
          'createdAt', account_user.created_at,
          'updatedAt', account_user.updated_at
        )
        FROM zuocheng."user" AS account_user
        WHERE account_user.id = p_user_id
      ),
    'memberships',
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'tenantId', membership.tenant_id,
              'role', membership.role,
              'status', membership.status,
              'createdAt', membership.created_at,
              'updatedAt', membership.updated_at
            )
            ORDER BY membership.tenant_id
          )
          FROM zuocheng.membership AS membership
          WHERE membership.user_id = p_user_id
        ),
        '[]'::jsonb
      ),
    'projects',
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'tenantId', project.tenant_id,
              'id', project.id,
              'name', project.name,
              'description', project.description,
              'status', project.status,
              'version', project.version,
              'createdAt', project.created_at,
              'updatedAt', project.updated_at,
              'archivedAt', project.archived_at,
              'deletedAt', project.deleted_at
            )
            ORDER BY project.tenant_id, project.id
          )
          FROM zuocheng.project AS project
          WHERE project.created_by_user_id = p_user_id
             OR project.updated_by_user_id = p_user_id
             OR EXISTS (
               SELECT 1
               FROM zuocheng.project_acl AS acl
               WHERE acl.tenant_id = project.tenant_id
                 AND acl.project_id = project.id
                 AND acl.principal_user_id = p_user_id
                 AND acl.deleted_at IS NULL
             )
             OR EXISTS (
               SELECT 1
               FROM zuocheng.membership AS member
               WHERE member.tenant_id = project.tenant_id
                 AND member.user_id = p_user_id
                 AND member.status = 'active'
                 AND member.deleted_at IS NULL
             )
        ),
        '[]'::jsonb
      ),
    'versions',
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'tenantId', version.tenant_id,
              'projectId', version.project_id,
              'version', version.version,
              'snapshot', version.snapshot,
              'createdAt', version.created_at
            )
            ORDER BY version.tenant_id, version.project_id, version.version
          )
          FROM zuocheng.project_version AS version
          WHERE EXISTS (
            SELECT 1
            FROM zuocheng.project AS project
            WHERE project.tenant_id = version.tenant_id
              AND project.id = version.project_id
              AND (
                project.created_by_user_id = p_user_id
                OR project.updated_by_user_id = p_user_id
                OR EXISTS (
                  SELECT 1
                  FROM zuocheng.membership AS member
                  WHERE member.tenant_id = project.tenant_id
                    AND member.user_id = p_user_id
                    AND member.status = 'active'
                    AND member.deleted_at IS NULL
                )
              )
          )
        ),
        '[]'::jsonb
      ),
    'audit',
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', audit.id,
              'tenantId', audit.tenant_id,
              'sessionId', audit.session_id,
              'eventType', audit.event_type,
              'payload', audit.payload,
              'occurredAt', audit.occurred_at
            )
            ORDER BY audit.occurred_at, audit.id
          )
          FROM zuocheng.identity_audit_event AS audit
          WHERE audit.user_id = p_user_id
        ),
        '[]'::jsonb
      ),
    'courses', '[]'::jsonb,
    'usage', '[]'::jsonb,
    'ledger', '[]'::jsonb
  );
END
$function$;

ALTER TABLE zuocheng.identity_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.identity_idempotency FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.account_export_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.account_export_request FORCE ROW LEVEL SECURITY;

CREATE POLICY identity_idempotency_auth_maintenance_policy
  ON zuocheng.identity_idempotency
  FOR ALL TO zuocheng_auth USING (true) WITH CHECK (true);
CREATE POLICY account_export_request_auth_maintenance_policy
  ON zuocheng.account_export_request
  FOR ALL TO zuocheng_auth USING (true) WITH CHECK (true);

CREATE POLICY identity_idempotency_owner_maintenance_policy
  ON zuocheng.identity_idempotency
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);
CREATE POLICY account_export_request_owner_maintenance_policy
  ON zuocheng.account_export_request
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);

REVOKE ALL ON zuocheng.identity_idempotency FROM PUBLIC;
REVOKE ALL ON zuocheng.account_export_request FROM PUBLIC;
REVOKE ALL ON FUNCTION zuocheng.capture_account_export(uuid) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  zuocheng.identity_idempotency,
  zuocheng.account_export_request
TO zuocheng_auth;
GRANT EXECUTE ON FUNCTION zuocheng.capture_account_export(uuid)
TO zuocheng_auth;

ALTER TABLE zuocheng.identity_idempotency OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.account_export_request OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.capture_account_export(uuid) OWNER TO zuocheng_owner;

RESET ROLE;
GRANT USAGE ON SCHEMA zuocheng TO zuocheng_auth;

COMMIT;
