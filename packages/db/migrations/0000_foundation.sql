BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zuocheng_owner') THEN
    CREATE ROLE zuocheng_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE zuocheng_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zuocheng_app') THEN
    CREATE ROLE zuocheng_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE zuocheng_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zuocheng_purge') THEN
    CREATE ROLE zuocheng_purge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE zuocheng_purge NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

-- PostgreSQL 17 gives a non-superuser role creator ADMIN but not SET on a
-- newly created role. SET is required before ownership can be transferred.
GRANT zuocheng_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;

CREATE SCHEMA IF NOT EXISTS zuocheng;
GRANT USAGE, CREATE ON SCHEMA zuocheng TO zuocheng_owner;

-- RFC 9562 UUIDv7: 48-bit Unix millisecond timestamp, version 7, RFC variant,
-- and 74 cryptographically random bits. Keeping this database-side makes every
-- writer use the same identifier contract.
CREATE OR REPLACE FUNCTION zuocheng.uuid_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
PARALLEL RESTRICTED
SET search_path = pg_catalog
AS $function$
DECLARE
  unix_ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  uuid_bytes bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
BEGIN
  uuid_bytes := set_byte(uuid_bytes, 0, ((unix_ts_ms >> 40) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 1, ((unix_ts_ms >> 32) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 2, ((unix_ts_ms >> 24) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 3, ((unix_ts_ms >> 16) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 4, ((unix_ts_ms >> 8) & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 5, (unix_ts_ms & 255)::integer);
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 0x0f) | 0x70);
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 0x3f) | 0x80);
  RETURN encode(uuid_bytes, 'hex')::uuid;
END
$function$;

CREATE OR REPLACE FUNCTION zuocheng.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_user = 'zuocheng_owner'
     AND current_setting('zuocheng.purge_guard', true) = 'project'
     AND OLD.tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$function$;

CREATE TABLE zuocheng.tenant (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  slug varchar(63) NOT NULL,
  display_name varchar(200) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT tenant_slug_unique UNIQUE (slug),
  CONSTRAINT tenant_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$' AND slug !~ '-$'),
  CONSTRAINT tenant_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT tenant_version_positive CHECK (version > 0)
);

CREATE TABLE zuocheng."user" (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  email varchar(320) NOT NULL,
  display_name varchar(200) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT user_email_unique UNIQUE (email),
  CONSTRAINT user_email_normalized CHECK (email = lower(btrim(email))),
  CONSTRAINT user_email_shape CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+$'),
  CONSTRAINT user_display_name_nonempty CHECK (btrim(display_name) <> ''),
  CONSTRAINT user_version_positive CHECK (version > 0)
);

CREATE TABLE zuocheng.membership (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT zuocheng.uuid_v7(),
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT membership_tenant_id_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT membership_tenant_user_unique UNIQUE (tenant_id, user_id),
  CONSTRAINT membership_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT membership_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT membership_role_valid CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  CONSTRAINT membership_status_valid CHECK (status IN ('invited', 'active', 'suspended')),
  CONSTRAINT membership_version_positive CHECK (version > 0)
);

CREATE INDEX membership_user_idx ON zuocheng.membership (user_id);

-- Owner-only binding from a real database login to exactly one tenant/user
-- principal. App roles never receive table privileges; RLS and mutation
-- routines consult it through narrow SECURITY DEFINER lookups keyed by
-- session_user, so an actor UUID in a request is not trusted on its own.
CREATE TABLE zuocheng.runtime_principal (
  login_role text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_principal_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT runtime_principal_membership_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT runtime_principal_login_role_nonempty CHECK (btrim(login_role) <> '')
);

CREATE FUNCTION zuocheng.current_session_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
  SELECT principal.tenant_id
    FROM zuocheng.runtime_principal AS principal
    JOIN zuocheng.membership AS active_membership
      ON active_membership.tenant_id = principal.tenant_id
     AND active_membership.user_id = principal.user_id
     AND active_membership.status = 'active'
     AND active_membership.deleted_at IS NULL
   WHERE principal.login_role = session_user::text
$function$;

CREATE FUNCTION zuocheng.current_session_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
  SELECT principal.user_id
    FROM zuocheng.runtime_principal AS principal
    JOIN zuocheng.membership AS active_membership
      ON active_membership.tenant_id = principal.tenant_id
     AND active_membership.user_id = principal.user_id
     AND active_membership.status = 'active'
     AND active_membership.deleted_at IS NULL
   WHERE principal.login_role = session_user::text
$function$;

CREATE TABLE zuocheng.project (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT zuocheng.uuid_v7(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  name varchar(160) NOT NULL,
  description text,
  copied_from_project_id uuid,
  status text NOT NULL DEFAULT 'active',
  deletion_status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT project_tenant_id_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT project_creator_membership_fk FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT project_updater_membership_fk FOREIGN KEY (tenant_id, updated_by_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT project_copied_from_fk FOREIGN KEY (tenant_id, copied_from_project_id)
    REFERENCES zuocheng.project (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT project_copied_from_not_self
    CHECK (copied_from_project_id IS NULL OR copied_from_project_id <> id),
  CONSTRAINT project_status_valid CHECK (status IN ('active', 'archived')),
  CONSTRAINT project_deletion_status_valid
    CHECK (deletion_status IN ('active', 'soft_deleted', 'purge_pending', 'purged')),
  CONSTRAINT project_creator_required_unless_purged
    CHECK (created_by_user_id IS NOT NULL OR deletion_status = 'purged'),
  CONSTRAINT project_updater_required_unless_purged
    CHECK (updated_by_user_id IS NOT NULL OR deletion_status = 'purged'),
  CONSTRAINT project_deletion_state_valid CHECK (
    (deletion_status = 'active' AND deleted_at IS NULL)
    OR (deletion_status IN ('soft_deleted', 'purge_pending', 'purged') AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT project_archive_state_valid CHECK (
    (status = 'active' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  ),
  CONSTRAINT project_version_positive CHECK (version > 0)
);

COMMENT ON COLUMN zuocheng.project.deletion_status IS
  'deletion_request pending/processing -> purge_pending; completed -> purged; cancelled/rejected -> prior_deletion_status';

CREATE INDEX project_tenant_updated_idx ON zuocheng.project (tenant_id, updated_at);

CREATE TABLE zuocheng.project_version (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_version_tenant_project_version_pk
    PRIMARY KEY (tenant_id, project_id, version),
  CONSTRAINT project_version_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT project_version_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES zuocheng.project (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_version_creator_membership_fk FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT project_version_version_positive CHECK (version > 0),
  CONSTRAINT project_version_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX project_version_creator_idx
  ON zuocheng.project_version (tenant_id, created_by_user_id);

CREATE TABLE zuocheng.project_acl (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT zuocheng.uuid_v7(),
  project_id uuid NOT NULL,
  principal_user_id uuid NOT NULL,
  access_level text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT project_acl_tenant_id_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT project_acl_principal_unique UNIQUE (tenant_id, project_id, principal_user_id),
  CONSTRAINT project_acl_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT project_acl_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES zuocheng.project (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_acl_principal_membership_fk FOREIGN KEY (tenant_id, principal_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT project_acl_access_level_valid CHECK (access_level IN ('owner', 'editor', 'viewer')),
  CONSTRAINT project_acl_version_positive CHECK (version > 0)
);

CREATE INDEX project_acl_principal_idx
  ON zuocheng.project_acl (tenant_id, principal_user_id);

CREATE TABLE zuocheng.idempotency_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT zuocheng.uuid_v7(),
  principal_user_id uuid NOT NULL,
  project_id uuid,
  scope varchar(120) NOT NULL,
  idempotency_key_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT idempotency_record_tenant_id_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT idempotency_record_tenant_principal_scope_key_hash_unique
    UNIQUE (tenant_id, principal_user_id, scope, idempotency_key_hash),
  CONSTRAINT idempotency_record_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_record_principal_membership_fk
    FOREIGN KEY (tenant_id, principal_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_record_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES zuocheng.project (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT idempotency_record_scope_nonempty CHECK (btrim(scope) <> ''),
  CONSTRAINT idempotency_record_key_hash_valid
    CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_record_hash_valid CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_record_response_status_valid
    CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  -- Threat boundary: app INSERT is only an actor-bound atomic claim. Completion
  -- goes through complete_idempotency_record, never a general UPDATE grant. A
  -- completed response must either name a live, actor-visible project (also
  -- protected by the FK/parent guard), or be canonical project-less not-found.
  CONSTRAINT idempotency_record_completed_response_valid CHECK (
    (response_status IS NULL AND response_body IS NULL)
    OR (
      response_status IS NOT NULL AND response_body IS NOT NULL
      AND (
        project_id IS NOT NULL
        OR response_body = '{"kind":"not_found"}'::jsonb
      )
    )
  ),
  CONSTRAINT idempotency_record_version_positive CHECK (version > 0)
);

CREATE INDEX idempotency_record_expiry_idx
  ON zuocheng.idempotency_record (tenant_id, expires_at);

CREATE TABLE zuocheng.audit_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT zuocheng.uuid_v7(),
  actor_user_id uuid,
  event_type varchar(160) NOT NULL,
  subject_type varchar(120) NOT NULL,
  subject_id uuid,
  request_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT audit_event_tenant_id_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_event_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT audit_event_actor_membership_fk FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT audit_event_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT audit_event_subject_type_nonempty CHECK (btrim(subject_type) <> ''),
  CONSTRAINT audit_event_version_positive CHECK (version > 0)
);

CREATE INDEX audit_event_tenant_occurred_idx
  ON zuocheng.audit_event (tenant_id, occurred_at);

CREATE TABLE zuocheng.deletion_request (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT zuocheng.uuid_v7(),
  requested_by_user_id uuid,
  subject_type text NOT NULL,
  subject_id uuid,
  subject_hash char(64) NOT NULL,
  subject_user_id uuid,
  project_id uuid,
  prior_deletion_status text,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  scheduled_for timestamptz NOT NULL,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT deletion_request_tenant_id_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT deletion_request_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT deletion_request_requester_membership_fk FOREIGN KEY (tenant_id, requested_by_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT deletion_request_subject_membership_fk FOREIGN KEY (tenant_id, subject_user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT deletion_request_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES zuocheng.project (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT deletion_request_subject_type_valid
    CHECK (subject_type IN ('user', 'project', 'tenant')),
  CONSTRAINT deletion_request_subject_hash_valid
    CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT deletion_request_prior_status_valid
    CHECK (prior_deletion_status IS NULL OR prior_deletion_status IN ('active', 'soft_deleted')),
  CONSTRAINT deletion_request_subject_valid CHECK (
    (status = 'completed' AND subject_id IS NULL
      AND subject_user_id IS NULL AND project_id IS NULL)
    OR (status <> 'completed' AND subject_type = 'user' AND subject_id = subject_user_id
      AND subject_user_id IS NOT NULL AND project_id IS NULL)
    OR (status <> 'completed' AND subject_type = 'project' AND subject_id = project_id
      AND project_id IS NOT NULL AND subject_user_id IS NULL
      AND prior_deletion_status IS NOT NULL)
    OR (status <> 'completed' AND subject_type = 'tenant' AND subject_id = tenant_id
      AND subject_user_id IS NULL AND project_id IS NULL)
  ),
  CONSTRAINT deletion_request_requester_valid
    CHECK (requested_by_user_id IS NOT NULL OR status = 'completed'),
  CONSTRAINT deletion_request_status_valid
    CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'rejected')),
  CONSTRAINT deletion_request_schedule_valid CHECK (scheduled_for >= requested_at),
  CONSTRAINT deletion_request_completion_valid
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT deletion_request_version_positive CHECK (version > 0)
);

CREATE INDEX deletion_request_status_idx
  ON zuocheng.deletion_request (tenant_id, status, scheduled_for);

CREATE FUNCTION zuocheng.require_app_tenant(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
BEGIN
  IF p_tenant_id IS NULL
     OR p_tenant_id IS DISTINCT FROM zuocheng.current_session_tenant_id()
     OR p_tenant_id IS DISTINCT FROM
       NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'database login is not bound to tenant context'
      USING ERRCODE = '42501';
  END IF;
END
$function$;

CREATE FUNCTION zuocheng.require_active_member(p_tenant_id uuid, p_actor_user_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
BEGIN
  PERFORM 1
    FROM zuocheng.membership
   WHERE tenant_id = p_tenant_id
     AND user_id = p_actor_user_id
     AND status = 'active'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'actor is not an active tenant member'
      USING ERRCODE = '42501';
  END IF;
END
$function$;

CREATE FUNCTION zuocheng.require_app_context(p_tenant_id uuid, p_actor_user_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
BEGIN
  PERFORM zuocheng.require_app_tenant(p_tenant_id);

  IF p_actor_user_id IS NULL
     OR p_actor_user_id IS DISTINCT FROM zuocheng.current_session_user_id() THEN
    RAISE EXCEPTION 'actor does not match database login context'
      USING ERRCODE = '42501';
  END IF;

  PERFORM zuocheng.require_active_member(p_tenant_id, p_actor_user_id);
END
$function$;

CREATE FUNCTION zuocheng.require_project_access(
  p_tenant_id uuid,
  p_project_id uuid,
  p_actor_user_id uuid,
  p_required_access text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  tenant_role text;
  project_access text;
  required_rank integer;
  actual_rank integer;
BEGIN
  PERFORM zuocheng.require_active_member(p_tenant_id, p_actor_user_id);

  required_rank := CASE p_required_access
    WHEN 'viewer' THEN 1
    WHEN 'editor' THEN 2
    WHEN 'owner' THEN 3
    ELSE NULL
  END;
  IF required_rank IS NULL THEN
    RAISE EXCEPTION 'unknown project access level'
      USING ERRCODE = '22023';
  END IF;

  SELECT role INTO tenant_role
    FROM zuocheng.membership
   WHERE tenant_id = p_tenant_id
     AND user_id = p_actor_user_id
     AND status = 'active'
     AND deleted_at IS NULL;

  IF tenant_role IN ('owner', 'admin') THEN
    RETURN;
  END IF;

  SELECT access_level INTO project_access
    FROM zuocheng.project_acl
   WHERE tenant_id = p_tenant_id
     AND project_id = p_project_id
     AND principal_user_id = p_actor_user_id
     AND deleted_at IS NULL;

  actual_rank := CASE project_access
    WHEN 'viewer' THEN 1
    WHEN 'editor' THEN 2
    WHEN 'owner' THEN 3
    ELSE 0
  END;
  IF actual_rank < required_rank THEN
    RAISE EXCEPTION 'actor lacks required project access'
      USING ERRCODE = '42501';
  END IF;
END
$function$;

CREATE FUNCTION zuocheng.lock_project_for_mutation(
  p_tenant_id uuid,
  p_project_id uuid,
  p_actor_user_id uuid
)
RETURNS SETOF zuocheng.project
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    p_tenant_id, p_project_id, p_actor_user_id, 'editor'
  );

  RETURN QUERY
    SELECT project.*
      FROM zuocheng.project AS project
     WHERE project.tenant_id = p_tenant_id
       AND project.id = p_project_id
     FOR UPDATE;
END
$function$;

CREATE FUNCTION zuocheng.lock_project_for_deletion(
  p_tenant_id uuid,
  p_project_id uuid,
  p_actor_user_id uuid
)
RETURNS SETOF zuocheng.project
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    p_tenant_id, p_project_id, p_actor_user_id, 'owner'
  );

  RETURN QUERY
    SELECT project.*
      FROM zuocheng.project AS project
     WHERE project.tenant_id = p_tenant_id
       AND project.id = p_project_id
     FOR UPDATE;
END
$function$;

CREATE FUNCTION zuocheng.claim_idempotency_record(
  p_tenant_id uuid,
  p_scope text,
  p_idempotency_key_hash text,
  p_request_hash text,
  p_project_id uuid
)
RETURNS TABLE (
  claimed boolean,
  stored_request_hash text,
  stored_response_body jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  session_user_id uuid;
  existing_record record;
BEGIN
  PERFORM zuocheng.require_app_tenant(p_tenant_id);
  session_user_id := zuocheng.current_session_user_id();
  IF session_user_id IS NULL THEN
    RAISE EXCEPTION 'database login has no active user context'
      USING ERRCODE = '42501';
  END IF;
  IF p_project_id IS NOT NULL THEN
    PERFORM zuocheng.require_project_access(
      p_tenant_id, p_project_id, session_user_id, 'viewer'
    );
  END IF;

  LOOP
    SELECT record.id, record.request_hash::text AS request_hash,
           record.response_body, record.expires_at
      INTO existing_record
      FROM zuocheng.idempotency_record AS record
     WHERE record.tenant_id = p_tenant_id
       AND record.principal_user_id = session_user_id
       AND record.scope = p_scope
       AND record.idempotency_key_hash = p_idempotency_key_hash
     FOR UPDATE;

    IF FOUND THEN
      IF existing_record.expires_at <= clock_timestamp() THEN
        UPDATE zuocheng.idempotency_record
           SET project_id = p_project_id,
               request_hash = p_request_hash,
               response_status = NULL,
               response_body = NULL,
               expires_at = clock_timestamp() + interval '24 hours',
               updated_at = clock_timestamp(),
               deleted_at = NULL,
               version = version + 1
         WHERE tenant_id = p_tenant_id AND id = existing_record.id;
        RETURN QUERY SELECT true, p_request_hash, NULL::jsonb;
        RETURN;
      END IF;

      RETURN QUERY SELECT false, existing_record.request_hash, existing_record.response_body;
      RETURN;
    END IF;

    BEGIN
      INSERT INTO zuocheng.idempotency_record
        (tenant_id, principal_user_id, project_id, scope, idempotency_key_hash,
         request_hash, expires_at)
      VALUES (
        p_tenant_id, session_user_id, p_project_id, p_scope,
        p_idempotency_key_hash, p_request_hash, clock_timestamp() + interval '24 hours'
      );
      RETURN QUERY SELECT true, p_request_hash, NULL::jsonb;
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent claimant won the insert. Re-read it under FOR UPDATE so
      -- only one transaction can reclaim or own this principal-scoped key.
    END;
  END LOOP;
END
$function$;

CREATE FUNCTION zuocheng.complete_idempotency_record(
  p_tenant_id uuid,
  p_scope text,
  p_idempotency_key_hash text,
  p_project_id uuid,
  p_response_status integer,
  p_response_body jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  session_user_id uuid;
  affected_rows integer;
BEGIN
  PERFORM zuocheng.require_app_tenant(p_tenant_id);
  session_user_id := zuocheng.current_session_user_id();
  IF session_user_id IS NULL THEN
    RAISE EXCEPTION 'database login has no active user context'
      USING ERRCODE = '42501';
  END IF;

  IF p_project_id IS NOT NULL THEN
    PERFORM zuocheng.require_project_access(
      p_tenant_id, p_project_id, session_user_id, 'viewer'
    );
  ELSIF p_response_body IS DISTINCT FROM '{"kind":"not_found"}'::jsonb THEN
    RAISE EXCEPTION 'project-less completion must be canonical not-found'
      USING ERRCODE = '23514';
  END IF;

  UPDATE zuocheng.idempotency_record
     SET project_id = p_project_id,
         response_status = p_response_status,
         response_body = p_response_body,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id
     AND principal_user_id = session_user_id
     AND scope = p_scope
     AND idempotency_key_hash = p_idempotency_key_hash
     AND response_status IS NULL
     AND response_body IS NULL;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'idempotency claim is missing, foreign, or already completed'
      USING ERRCODE = 'P0002';
  END IF;
END
$function$;

CREATE FUNCTION zuocheng.purge_expired_idempotency_records(
  p_tenant_id uuid,
  p_batch_size integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  deleted_rows integer;
BEGIN
  IF p_tenant_id IS NULL OR p_batch_size < 1 OR p_batch_size > 10000 THEN
    RAISE EXCEPTION 'invalid idempotency cleanup batch'
      USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('zuocheng.current_tenant_id', p_tenant_id::text, true);

  WITH expired AS MATERIALIZED (
    SELECT record.tenant_id, record.id
      FROM zuocheng.idempotency_record AS record
     WHERE record.tenant_id = p_tenant_id
       AND record.expires_at <= clock_timestamp()
     ORDER BY record.expires_at, record.id
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM zuocheng.idempotency_record AS record
   USING expired
   WHERE record.tenant_id = expired.tenant_id
     AND record.id = expired.id;
  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RETURN deleted_rows;
END
$function$;

CREATE FUNCTION zuocheng.guard_project_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  write_guard text := current_setting('zuocheng.project_write_guard', true);
BEGIN
  IF current_user <> 'zuocheng_owner'
     OR OLD.tenant_id IS DISTINCT FROM
       NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (
       current_setting('zuocheng.purge_guard', true) IS DISTINCT FROM 'project'
       AND COALESCE(write_guard, '') NOT IN (
         'content', 'archive', 'soft_delete', 'restore',
         'deletion_prepare', 'deletion_cancel'
       )
     ) THEN
    RAISE EXCEPTION 'project updates require a guarded owner routine'
      USING ERRCODE = '42501';
  END IF;

  IF current_setting('zuocheng.purge_guard', true) IS DISTINCT FROM 'project'
     AND NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'project creator is immutable'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER project_update_guard
BEFORE UPDATE ON zuocheng.project
FOR EACH ROW EXECUTE FUNCTION zuocheng.guard_project_update();

CREATE FUNCTION zuocheng.guard_project_parent_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  parent_status text;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT deletion_status
    INTO parent_status
    FROM zuocheng.project
   WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id
   FOR KEY SHARE;

  IF NOT FOUND OR parent_status = 'purged' THEN
    RAISE EXCEPTION 'cannot attach data to a purged project'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER project_version_parent_state_guard
BEFORE INSERT OR UPDATE ON zuocheng.project_version
FOR EACH ROW EXECUTE FUNCTION zuocheng.guard_project_parent_state();

CREATE TRIGGER project_acl_parent_state_guard
BEFORE INSERT OR UPDATE ON zuocheng.project_acl
FOR EACH ROW EXECUTE FUNCTION zuocheng.guard_project_parent_state();

CREATE TRIGGER idempotency_record_parent_state_guard
BEFORE INSERT OR UPDATE ON zuocheng.idempotency_record
FOR EACH ROW EXECUTE FUNCTION zuocheng.guard_project_parent_state();

CREATE FUNCTION zuocheng.guard_project_copy_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  source_status text;
BEGIN
  IF NEW.copied_from_project_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT deletion_status
    INTO source_status
    FROM zuocheng.project
   WHERE tenant_id = NEW.tenant_id AND id = NEW.copied_from_project_id
   FOR KEY SHARE;

  IF NOT FOUND OR source_status = 'purged' THEN
    RAISE EXCEPTION 'cannot copy a purged project'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER project_copy_source_guard
BEFORE INSERT OR UPDATE OF copied_from_project_id ON zuocheng.project
FOR EACH ROW EXECUTE FUNCTION zuocheng.guard_project_copy_source();

CREATE FUNCTION zuocheng.append_project_version(
  p_tenant_id uuid,
  p_project_id uuid,
  p_actor_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  project_row zuocheng.project%ROWTYPE;
  next_snapshot_version integer;
BEGIN
  SELECT * INTO project_row
    FROM zuocheng.project
   WHERE tenant_id = p_tenant_id AND id = p_project_id
   FOR SHARE;

  IF NOT FOUND OR project_row.deletion_status = 'purged' THEN
    RAISE EXCEPTION 'cannot append history to a purged project'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(max(version), 0) + 1
    INTO next_snapshot_version
    FROM zuocheng.project_version
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id;

  INSERT INTO zuocheng.project_version
    (tenant_id, project_id, version, snapshot, created_by_user_id)
  VALUES (
    p_tenant_id,
    p_project_id,
    next_snapshot_version,
    jsonb_build_object(
      'name', project_row.name,
      'description', project_row.description,
      'status', project_row.status,
      'deletionStatus', project_row.deletion_status,
      'projectVersion', project_row.version,
      'sourceProjectId', project_row.copied_from_project_id
    ),
    p_actor_user_id
  );
END
$function$;

CREATE FUNCTION zuocheng.append_audit_event(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_event_type text,
  p_subject_type text,
  p_subject_id uuid,
  p_request_id uuid,
  p_payload jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
BEGIN
  INSERT INTO zuocheng.audit_event
    (tenant_id, actor_user_id, event_type, subject_type, subject_id, request_id, payload)
  VALUES (
    p_tenant_id,
    p_actor_user_id,
    p_event_type,
    p_subject_type,
    p_subject_id,
    p_request_id,
    COALESCE(p_payload, '{}'::jsonb)
  );
END
$function$;

CREATE FUNCTION zuocheng.create_project(
  p_actor_user_id uuid,
  p_name text,
  p_description text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  app_tenant_id uuid := zuocheng.current_session_tenant_id();
  new_project_id uuid := zuocheng.uuid_v7();
BEGIN
  PERFORM zuocheng.require_app_context(app_tenant_id, p_actor_user_id);

  INSERT INTO zuocheng.project
    (tenant_id, id, created_by_user_id, updated_by_user_id, name, description)
  VALUES (app_tenant_id, new_project_id, p_actor_user_id, p_actor_user_id, p_name, p_description);

  INSERT INTO zuocheng.project_acl
    (tenant_id, project_id, principal_user_id, access_level)
  VALUES (app_tenant_id, new_project_id, p_actor_user_id, 'owner');

  PERFORM zuocheng.append_project_version(app_tenant_id, new_project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(
    app_tenant_id, p_actor_user_id, 'project.created', 'project', new_project_id, NULL,
    jsonb_build_object('projectVersion', 1)
  );
  RETURN new_project_id;
END
$function$;

CREATE FUNCTION zuocheng.copy_project(
  p_source_project_id uuid,
  p_actor_user_id uuid,
  p_expected_source_version integer,
  p_name text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  app_tenant_id uuid := zuocheng.current_session_tenant_id();
  source_row zuocheng.project%ROWTYPE;
  new_project_id uuid := zuocheng.uuid_v7();
BEGIN
  PERFORM zuocheng.require_app_context(app_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    app_tenant_id, p_source_project_id, p_actor_user_id, 'viewer'
  );

  SELECT * INTO source_row
    FROM zuocheng.project
   WHERE tenant_id = app_tenant_id AND id = p_source_project_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source project not found' USING ERRCODE = 'P0002';
  END IF;
  IF source_row.version <> p_expected_source_version THEN
    RAISE EXCEPTION 'source project version conflict' USING ERRCODE = '40001';
  END IF;
  IF source_row.deletion_status <> 'active' THEN
    RAISE EXCEPTION 'deleted projects cannot be copied' USING ERRCODE = '23514';
  END IF;

  INSERT INTO zuocheng.project
    (tenant_id, id, created_by_user_id, updated_by_user_id, name, description,
     copied_from_project_id)
  VALUES (
    app_tenant_id, new_project_id, p_actor_user_id, p_actor_user_id, p_name,
    source_row.description, p_source_project_id
  );
  INSERT INTO zuocheng.project_acl
    (tenant_id, project_id, principal_user_id, access_level)
  VALUES (app_tenant_id, new_project_id, p_actor_user_id, 'owner');
  PERFORM zuocheng.append_project_version(app_tenant_id, new_project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(
    app_tenant_id, p_actor_user_id, 'project.copied', 'project', new_project_id, NULL,
    jsonb_build_object('sourceProjectId', p_source_project_id, 'projectVersion', 1)
  );
  RETURN new_project_id;
END
$function$;

CREATE PROCEDURE zuocheng.update_project_content(
  p_tenant_id uuid,
  p_project_id uuid,
  p_expected_version integer,
  p_actor_user_id uuid,
  p_name text,
  p_description text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $procedure$
DECLARE
  project_row zuocheng.project%ROWTYPE;
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    p_tenant_id, p_project_id, p_actor_user_id, 'editor'
  );
  SELECT * INTO project_row FROM zuocheng.project
   WHERE tenant_id = p_tenant_id AND id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002'; END IF;
  IF project_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'project version conflict' USING ERRCODE = '40001';
  END IF;
  IF project_row.status <> 'active' OR project_row.deletion_status <> 'active' THEN
    RAISE EXCEPTION 'project content is not mutable in its current state' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('zuocheng.project_write_guard', 'content', true);
  UPDATE zuocheng.project SET
    name = p_name, description = p_description, updated_by_user_id = p_actor_user_id,
    updated_at = clock_timestamp(), version = version + 1
   WHERE tenant_id = p_tenant_id AND id = p_project_id;
  PERFORM zuocheng.append_project_version(p_tenant_id, p_project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(
    p_tenant_id, p_actor_user_id, 'project.updated', 'project', p_project_id, NULL,
    jsonb_build_object('projectVersion', p_expected_version + 1)
  );
END
$procedure$;

CREATE PROCEDURE zuocheng.archive_project(
  p_tenant_id uuid, p_project_id uuid, p_expected_version integer, p_actor_user_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, zuocheng
AS $procedure$
DECLARE project_row zuocheng.project%ROWTYPE;
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    p_tenant_id, p_project_id, p_actor_user_id, 'editor'
  );
  SELECT * INTO project_row FROM zuocheng.project
   WHERE tenant_id = p_tenant_id AND id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002'; END IF;
  IF project_row.version <> p_expected_version THEN RAISE EXCEPTION 'project version conflict' USING ERRCODE = '40001'; END IF;
  IF project_row.status <> 'active' OR project_row.deletion_status <> 'active' THEN
    RAISE EXCEPTION 'only active projects can be archived' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('zuocheng.project_write_guard', 'archive', true);
  UPDATE zuocheng.project SET
    status = 'archived', archived_at = clock_timestamp(), updated_by_user_id = p_actor_user_id,
    updated_at = clock_timestamp(), version = version + 1
   WHERE tenant_id = p_tenant_id AND id = p_project_id;
  PERFORM zuocheng.append_project_version(p_tenant_id, p_project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(p_tenant_id, p_actor_user_id, 'project.archived', 'project', p_project_id, NULL, '{}'::jsonb);
END
$procedure$;

CREATE PROCEDURE zuocheng.soft_delete_project(
  p_tenant_id uuid, p_project_id uuid, p_expected_version integer, p_actor_user_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, zuocheng
AS $procedure$
DECLARE project_row zuocheng.project%ROWTYPE;
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    p_tenant_id, p_project_id, p_actor_user_id, 'editor'
  );
  SELECT * INTO project_row FROM zuocheng.project
   WHERE tenant_id = p_tenant_id AND id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002'; END IF;
  IF project_row.version <> p_expected_version THEN RAISE EXCEPTION 'project version conflict' USING ERRCODE = '40001'; END IF;
  IF project_row.deletion_status <> 'active' THEN
    RAISE EXCEPTION 'only active projects can be soft deleted' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('zuocheng.project_write_guard', 'soft_delete', true);
  UPDATE zuocheng.project SET
    deletion_status = 'soft_deleted', deleted_at = clock_timestamp(),
    updated_by_user_id = p_actor_user_id, updated_at = clock_timestamp(), version = version + 1
   WHERE tenant_id = p_tenant_id AND id = p_project_id;
  PERFORM zuocheng.append_project_version(p_tenant_id, p_project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(p_tenant_id, p_actor_user_id, 'project.soft_deleted', 'project', p_project_id, NULL, '{}'::jsonb);
END
$procedure$;

CREATE PROCEDURE zuocheng.restore_project(
  p_tenant_id uuid, p_project_id uuid, p_expected_version integer, p_actor_user_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, zuocheng
AS $procedure$
DECLARE project_row zuocheng.project%ROWTYPE;
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    p_tenant_id, p_project_id, p_actor_user_id, 'editor'
  );
  SELECT * INTO project_row FROM zuocheng.project
   WHERE tenant_id = p_tenant_id AND id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002'; END IF;
  IF project_row.version <> p_expected_version THEN RAISE EXCEPTION 'project version conflict' USING ERRCODE = '40001'; END IF;
  IF project_row.deletion_status <> 'soft_deleted' THEN
    RAISE EXCEPTION 'only soft-deleted projects can be restored' USING ERRCODE = '23514';
  END IF;
  PERFORM set_config('zuocheng.project_write_guard', 'restore', true);
  UPDATE zuocheng.project SET
    deletion_status = 'active', deleted_at = NULL, updated_by_user_id = p_actor_user_id,
    updated_at = clock_timestamp(), version = version + 1
   WHERE tenant_id = p_tenant_id AND id = p_project_id;
  PERFORM zuocheng.append_project_version(p_tenant_id, p_project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(p_tenant_id, p_actor_user_id, 'project.restored', 'project', p_project_id, NULL, '{}'::jsonb);
END
$procedure$;

CREATE OR REPLACE FUNCTION zuocheng.prepare_project_deletion_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  current_deletion_status text;
BEGIN
  IF NEW.subject_type <> 'project' THEN
    RETURN NEW;
  END IF;

  IF NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'project deletion requests must start pending'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM
     NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant context does not match deletion request'
      USING ERRCODE = '42501';
  END IF;

  SELECT deletion_status
    INTO current_deletion_status
    FROM zuocheng.project
   WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project does not exist in tenant'
      USING ERRCODE = '23503';
  END IF;

  IF current_deletion_status <> 'soft_deleted' THEN
    RAISE EXCEPTION 'project cannot enter purge from %', current_deletion_status
      USING ERRCODE = '23514';
  END IF;

  NEW.prior_deletion_status := current_deletion_status;

  PERFORM set_config('zuocheng.project_write_guard', 'deletion_prepare', true);
  UPDATE zuocheng.project
     SET deletion_status = 'purge_pending',
         deleted_at = COALESCE(deleted_at, clock_timestamp()),
         updated_by_user_id = NEW.requested_by_user_id,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id;

  RETURN NEW;
END
$function$;

CREATE TRIGGER deletion_request_prepare_project
BEFORE INSERT ON zuocheng.deletion_request
FOR EACH ROW EXECUTE FUNCTION zuocheng.prepare_project_deletion_request();

CREATE FUNCTION zuocheng.request_project_deletion(
  p_tenant_id uuid,
  p_project_id uuid,
  p_expected_project_version integer,
  p_actor_user_id uuid,
  p_scheduled_for timestamptz,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $function$
DECLARE
  project_row zuocheng.project%ROWTYPE;
  request_id uuid := zuocheng.uuid_v7();
  request_time timestamptz := clock_timestamp();
  subject_proof text :=
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  PERFORM zuocheng.require_project_access(
    p_tenant_id, p_project_id, p_actor_user_id, 'owner'
  );
  SELECT * INTO project_row FROM zuocheng.project
   WHERE tenant_id = p_tenant_id AND id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project not found' USING ERRCODE = 'P0002'; END IF;
  IF project_row.version <> p_expected_project_version THEN
    RAISE EXCEPTION 'project version conflict' USING ERRCODE = '40001';
  END IF;
  IF project_row.deletion_status <> 'soft_deleted' THEN
    RAISE EXCEPTION 'permanent deletion requires a soft-deleted project' USING ERRCODE = '23514';
  END IF;

  INSERT INTO zuocheng.deletion_request
    (tenant_id, id, requested_by_user_id, subject_type, subject_id, subject_hash,
     project_id, status, reason, requested_at, scheduled_for)
  VALUES (
    p_tenant_id, request_id, p_actor_user_id, 'project', p_project_id, subject_proof,
    p_project_id, 'pending', p_reason, request_time,
    GREATEST(COALESCE(p_scheduled_for, request_time), request_time)
  );
  PERFORM zuocheng.append_project_version(p_tenant_id, p_project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(
    p_tenant_id, p_actor_user_id, 'project.deletion_requested', 'project', p_project_id,
    request_id, jsonb_build_object('scheduledFor', GREATEST(COALESCE(p_scheduled_for, request_time), request_time))
  );
  RETURN request_id;
END
$function$;

CREATE PROCEDURE zuocheng.cancel_project_deletion(
  p_tenant_id uuid,
  p_request_id uuid,
  p_expected_request_version integer,
  p_actor_user_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $procedure$
DECLARE
  request_row zuocheng.deletion_request%ROWTYPE;
BEGIN
  PERFORM zuocheng.require_app_context(p_tenant_id, p_actor_user_id);
  SELECT * INTO request_row FROM zuocheng.deletion_request
   WHERE tenant_id = p_tenant_id AND id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion request not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM zuocheng.require_project_access(
    p_tenant_id, request_row.project_id, p_actor_user_id, 'owner'
  );
  IF request_row.version <> p_expected_request_version THEN
    RAISE EXCEPTION 'deletion request version conflict' USING ERRCODE = '40001';
  END IF;
  IF request_row.status <> 'pending'
     OR request_row.project_id IS NULL
     OR request_row.requested_by_user_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'only the requester may cancel a pending deletion' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('zuocheng.project_write_guard', 'deletion_cancel', true);
  UPDATE zuocheng.project SET
    deletion_status = request_row.prior_deletion_status,
    deleted_at = CASE WHEN request_row.prior_deletion_status = 'active' THEN NULL ELSE deleted_at END,
    updated_by_user_id = p_actor_user_id,
    updated_at = clock_timestamp(), version = version + 1
   WHERE tenant_id = p_tenant_id AND id = request_row.project_id;
  UPDATE zuocheng.deletion_request SET
    status = 'cancelled', updated_at = clock_timestamp(), version = version + 1
   WHERE tenant_id = p_tenant_id AND id = p_request_id;
  PERFORM zuocheng.append_project_version(p_tenant_id, request_row.project_id, p_actor_user_id);
  PERFORM zuocheng.append_audit_event(
    p_tenant_id, p_actor_user_id, 'project.deletion_cancelled', 'project',
    request_row.project_id, p_request_id, '{}'::jsonb
  );
END
$procedure$;

CREATE PROCEDURE zuocheng.transition_project_deletion(
  p_tenant_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_new_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $procedure$
DECLARE
  request_row zuocheng.deletion_request%ROWTYPE;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'tenant context does not match deletion request'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO request_row
    FROM zuocheng.deletion_request
   WHERE tenant_id = p_tenant_id AND id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion request not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF request_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'deletion request version conflict'
      USING ERRCODE = '40001';
  END IF;

  IF request_row.subject_type <> 'project' OR request_row.project_id IS NULL THEN
    RAISE EXCEPTION 'request is not an active project deletion'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (request_row.status = 'pending' AND p_new_status IN ('processing', 'rejected'))
    OR (request_row.status = 'processing' AND p_new_status = 'rejected')
  ) THEN
    RAISE EXCEPTION 'illegal deletion transition: % -> %', request_row.status, p_new_status
      USING ERRCODE = '23514';
  END IF;

  IF p_new_status = 'processing' AND request_row.scheduled_for > clock_timestamp() THEN
    RAISE EXCEPTION 'deletion request is not due'
      USING ERRCODE = '23514';
  END IF;

  IF p_new_status = 'rejected' THEN
    PERFORM set_config('zuocheng.project_write_guard', 'deletion_cancel', true);
    UPDATE zuocheng.project
       SET deletion_status = request_row.prior_deletion_status,
           deleted_at = CASE
             WHEN request_row.prior_deletion_status = 'active' THEN NULL
             ELSE deleted_at
           END,
           updated_by_user_id = request_row.requested_by_user_id,
           updated_at = clock_timestamp(),
           version = version + 1
     WHERE tenant_id = p_tenant_id AND id = request_row.project_id;
  END IF;

  UPDATE zuocheng.deletion_request
     SET status = p_new_status,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id AND id = p_request_id;

  IF p_new_status = 'rejected' THEN
    PERFORM zuocheng.append_project_version(
      p_tenant_id, request_row.project_id, request_row.requested_by_user_id
    );
  END IF;
  PERFORM zuocheng.append_audit_event(
    p_tenant_id, request_row.requested_by_user_id,
    'project.deletion_' || p_new_status, 'project', request_row.project_id,
    p_request_id, '{}'::jsonb
  );
END
$procedure$;

CREATE PROCEDURE zuocheng.purge_project(
  p_tenant_id uuid,
  p_request_id uuid,
  p_expected_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, zuocheng
AS $procedure$
DECLARE
  request_row zuocheng.deletion_request%ROWTYPE;
BEGIN
  PERFORM set_config('zuocheng.current_tenant_id', p_tenant_id::text, true);
  PERFORM set_config('zuocheng.purge_guard', 'project', true);

  SELECT * INTO request_row
    FROM zuocheng.deletion_request
   WHERE tenant_id = p_tenant_id AND id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion request not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF request_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'deletion request version conflict'
      USING ERRCODE = '40001';
  END IF;

  IF request_row.subject_type <> 'project'
     OR request_row.project_id IS NULL
     OR request_row.status <> 'processing' THEN
    RAISE EXCEPTION 'project purge requires a processing request'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM zuocheng.project
   WHERE tenant_id = p_tenant_id
     AND id = request_row.project_id
     AND deletion_status = 'purge_pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project is not purge_pending'
      USING ERRCODE = '23514';
  END IF;

  UPDATE zuocheng.project
     SET copied_from_project_id = NULL,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id
     AND copied_from_project_id = request_row.project_id;

  DELETE FROM zuocheng.project_version
   WHERE tenant_id = p_tenant_id AND project_id = request_row.project_id;

  DELETE FROM zuocheng.project_acl
   WHERE tenant_id = p_tenant_id AND project_id = request_row.project_id;

  DELETE FROM zuocheng.idempotency_record
   WHERE tenant_id = p_tenant_id AND project_id = request_row.project_id;

  UPDATE zuocheng.audit_event
     SET subject_id = NULL,
         payload = '{"purged":true}'::jsonb,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id
     AND subject_type = 'project'
     AND subject_id = request_row.project_id;

  -- A copied project can persist its source UUID in snapshots, audit payloads,
  -- or an idempotent response even after copied_from_project_id is cleared.
  -- Purge treats the UUID itself as identifying data, so any JSON document
  -- containing it is replaced by a non-identifying tombstone.
  UPDATE zuocheng.project_version
     SET snapshot = '{"sourcePurged":true}'::jsonb
   WHERE tenant_id = p_tenant_id
     AND lower(snapshot::text) LIKE '%' || request_row.project_id::text || '%';

  UPDATE zuocheng.audit_event
     SET payload = '{"sourcePurged":true}'::jsonb,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id
     AND lower(payload::text) LIKE '%' || request_row.project_id::text || '%';

  UPDATE zuocheng.idempotency_record
     SET response_body = '{"kind":"purged_reference"}'::jsonb,
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id
     AND lower(response_body::text) LIKE '%' || request_row.project_id::text || '%';

  UPDATE zuocheng.project
     SET created_by_user_id = NULL,
         updated_by_user_id = NULL,
         name = '[purged]',
         description = NULL,
         copied_from_project_id = NULL,
         status = 'active',
         archived_at = NULL,
         deletion_status = 'purged',
         deleted_at = COALESCE(deleted_at, clock_timestamp()),
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id AND id = request_row.project_id;

  UPDATE zuocheng.deletion_request
     SET requested_by_user_id = NULL,
         subject_id = NULL,
         subject_user_id = NULL,
         project_id = NULL,
         status = 'completed',
         reason = NULL,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         version = version + 1
   WHERE tenant_id = p_tenant_id AND id = p_request_id;

  IF EXISTS (
       SELECT 1 FROM zuocheng.project_version
        WHERE tenant_id = p_tenant_id AND project_id = request_row.project_id
     )
     OR EXISTS (
       SELECT 1 FROM zuocheng.project_acl
        WHERE tenant_id = p_tenant_id AND project_id = request_row.project_id
     )
     OR EXISTS (
       SELECT 1 FROM zuocheng.idempotency_record
        WHERE tenant_id = p_tenant_id AND project_id = request_row.project_id
     )
     OR EXISTS (
       SELECT 1 FROM zuocheng.project
        WHERE tenant_id = p_tenant_id AND copied_from_project_id = request_row.project_id
     )
     OR NOT EXISTS (
       SELECT 1 FROM zuocheng.project
        WHERE tenant_id = p_tenant_id AND id = request_row.project_id
          AND created_by_user_id IS NULL AND updated_by_user_id IS NULL
          AND name = '[purged]' AND description IS NULL
          AND copied_from_project_id IS NULL AND deletion_status = 'purged'
     )
     OR EXISTS (
       SELECT 1 FROM zuocheng.audit_event
        WHERE tenant_id = p_tenant_id AND subject_type = 'project'
          AND subject_id = request_row.project_id
     ) THEN
    RAISE EXCEPTION 'project purge postcondition failed'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    NOT EXISTS (
      SELECT 1 FROM zuocheng.project_version
       WHERE tenant_id = p_tenant_id
         AND lower(snapshot::text) LIKE '%' || request_row.project_id::text || '%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM zuocheng.audit_event
       WHERE tenant_id = p_tenant_id
         AND lower(payload::text) LIKE '%' || request_row.project_id::text || '%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM zuocheng.idempotency_record
       WHERE tenant_id = p_tenant_id
         AND lower(response_body::text) LIKE '%' || request_row.project_id::text || '%'
    )
  ) THEN
    RAISE EXCEPTION 'project purge source-reference postcondition failed'
      USING ERRCODE = '55000';
  END IF;
END
$procedure$;

CREATE TRIGGER project_version_append_only
BEFORE UPDATE OR DELETE ON zuocheng.project_version
FOR EACH ROW EXECUTE FUNCTION zuocheng.reject_append_only_mutation();

CREATE TRIGGER audit_event_append_only
BEFORE UPDATE OR DELETE ON zuocheng.audit_event
FOR EACH ROW EXECUTE FUNCTION zuocheng.reject_append_only_mutation();

-- RLS is both enabled and forced. The missing_ok form returns NULL when the
-- transaction has no tenant context, so every tenant predicate fails closed.
ALTER TABLE zuocheng.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng."user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng."user" FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.membership FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.project FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.project_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.project_version FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.project_acl ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.project_acl FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.idempotency_record FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.audit_event FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.deletion_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.deletion_request FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_current_tenant_policy ON zuocheng.tenant
  FOR ALL TO zuocheng_app
  USING (
    id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND id = zuocheng.current_session_tenant_id()
  )
  WITH CHECK (
    id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND id = zuocheng.current_session_tenant_id()
  );

CREATE POLICY user_current_tenant_select_policy ON zuocheng."user"
  FOR SELECT TO zuocheng_app
  USING (
    EXISTS (
      SELECT 1
      FROM zuocheng.membership AS visible_membership
      WHERE visible_membership.tenant_id =
        NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
        AND visible_membership.tenant_id = zuocheng.current_session_tenant_id()
        AND visible_membership.user_id = "user".id
        AND visible_membership.deleted_at IS NULL
    )
  );

CREATE POLICY membership_current_tenant_policy ON zuocheng.membership
  FOR SELECT TO zuocheng_app
  USING (
    tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
  );

CREATE POLICY project_current_tenant_policy ON zuocheng.project
  FOR SELECT TO zuocheng_app
  USING (
    tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
    AND deletion_status <> 'purged'
    AND (
      EXISTS (
        SELECT 1 FROM zuocheng.membership AS project_tenant_member
         WHERE project_tenant_member.tenant_id = project.tenant_id
           AND project_tenant_member.user_id = zuocheng.current_session_user_id()
           AND project_tenant_member.status = 'active'
           AND project_tenant_member.deleted_at IS NULL
           AND project_tenant_member.role IN ('owner', 'admin')
      )
      OR EXISTS (
        SELECT 1 FROM zuocheng.project_acl AS visible_project_acl
         WHERE visible_project_acl.tenant_id = project.tenant_id
           AND visible_project_acl.project_id = project.id
           AND visible_project_acl.principal_user_id = zuocheng.current_session_user_id()
           AND visible_project_acl.deleted_at IS NULL
      )
    )
  );

CREATE POLICY project_version_current_tenant_policy ON zuocheng.project_version
  FOR SELECT TO zuocheng_app
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
    AND EXISTS (
      SELECT 1 FROM zuocheng.project AS visible_project
       WHERE visible_project.tenant_id = project_version.tenant_id
         AND visible_project.id = project_version.project_id
    ));

CREATE POLICY project_acl_current_tenant_policy ON zuocheng.project_acl
  FOR SELECT TO zuocheng_app
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
    AND (
      principal_user_id = zuocheng.current_session_user_id()
      OR EXISTS (
        SELECT 1 FROM zuocheng.membership AS acl_tenant_member
         WHERE acl_tenant_member.tenant_id = project_acl.tenant_id
           AND acl_tenant_member.user_id = zuocheng.current_session_user_id()
           AND acl_tenant_member.status = 'active'
           AND acl_tenant_member.deleted_at IS NULL
           AND acl_tenant_member.role IN ('owner', 'admin')
      )
    ));

CREATE POLICY idempotency_record_current_principal_select_policy
  ON zuocheng.idempotency_record
  FOR SELECT TO zuocheng_app
  USING (
    tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
    AND principal_user_id = zuocheng.current_session_user_id()
    AND (
      project_id IS NULL
      OR EXISTS (
        SELECT 1 FROM zuocheng.project AS visible_idempotency_project
         WHERE visible_idempotency_project.tenant_id = idempotency_record.tenant_id
           AND visible_idempotency_project.id = idempotency_record.project_id
      )
    )
  );

CREATE POLICY idempotency_record_current_principal_insert_policy
  ON zuocheng.idempotency_record
  FOR INSERT TO zuocheng_app
  WITH CHECK (
    tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
    AND principal_user_id = zuocheng.current_session_user_id()
    AND response_status IS NULL
    AND response_body IS NULL
    AND (
      project_id IS NULL
      OR EXISTS (
        SELECT 1 FROM zuocheng.project AS writable_idempotency_project
         WHERE writable_idempotency_project.tenant_id = idempotency_record.tenant_id
           AND writable_idempotency_project.id = idempotency_record.project_id
      )
    )
  );

CREATE POLICY audit_event_project_visibility_policy ON zuocheng.audit_event
  FOR SELECT TO zuocheng_app
  USING (
    tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
    AND (
      actor_user_id = zuocheng.current_session_user_id()
      OR EXISTS (
        SELECT 1 FROM zuocheng.project AS visible_audit_project
         WHERE visible_audit_project.tenant_id = audit_event.tenant_id
           AND visible_audit_project.id = audit_event.subject_id
           AND audit_event.subject_type = 'project'
      )
      OR EXISTS (
        SELECT 1 FROM zuocheng.membership AS audit_tenant_admin
         WHERE audit_tenant_admin.tenant_id = audit_event.tenant_id
           AND audit_tenant_admin.user_id = zuocheng.current_session_user_id()
           AND audit_tenant_admin.role IN ('owner', 'admin')
           AND audit_tenant_admin.status = 'active'
           AND audit_tenant_admin.deleted_at IS NULL
      )
    )
  );

CREATE POLICY deletion_request_project_visibility_policy ON zuocheng.deletion_request
  FOR SELECT TO zuocheng_app
  USING (
    tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid
    AND tenant_id = zuocheng.current_session_tenant_id()
    AND (
      requested_by_user_id = zuocheng.current_session_user_id()
      OR EXISTS (
        SELECT 1 FROM zuocheng.project AS visible_deletion_project
         WHERE visible_deletion_project.tenant_id = deletion_request.tenant_id
           AND visible_deletion_project.id = deletion_request.project_id
      )
      OR EXISTS (
        SELECT 1 FROM zuocheng.membership AS deletion_tenant_admin
         WHERE deletion_tenant_admin.tenant_id = deletion_request.tenant_id
           AND deletion_tenant_admin.user_id = zuocheng.current_session_user_id()
           AND deletion_tenant_admin.role IN ('owner', 'admin')
           AND deletion_tenant_admin.status = 'active'
           AND deletion_tenant_admin.deleted_at IS NULL
      )
    )
  );

-- FORCE ROW LEVEL SECURITY also applies to table owners. These narrowly scoped
-- owner policies let SECURITY DEFINER maintenance routines see only the tenant
-- selected in the current transaction.
CREATE POLICY membership_owner_maintenance_policy ON zuocheng.membership
  FOR SELECT TO zuocheng_owner
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid);

CREATE POLICY project_owner_maintenance_policy ON zuocheng.project
  FOR ALL TO zuocheng_owner
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid);

CREATE POLICY project_version_owner_maintenance_policy ON zuocheng.project_version
  FOR ALL TO zuocheng_owner
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid);

CREATE POLICY project_acl_owner_maintenance_policy ON zuocheng.project_acl
  FOR ALL TO zuocheng_owner
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid);

CREATE POLICY idempotency_record_owner_maintenance_policy ON zuocheng.idempotency_record
  FOR ALL TO zuocheng_owner
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid);

CREATE POLICY audit_event_owner_maintenance_policy ON zuocheng.audit_event
  FOR ALL TO zuocheng_owner
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid);

CREATE POLICY deletion_request_owner_maintenance_policy ON zuocheng.deletion_request
  FOR ALL TO zuocheng_owner
  USING (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('zuocheng.current_tenant_id', true), '')::uuid);

REVOKE ALL ON SCHEMA zuocheng FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA zuocheng FROM PUBLIC;
REVOKE ALL ON ALL ROUTINES IN SCHEMA zuocheng FROM PUBLIC;
REVOKE ALL ON FUNCTION zuocheng.uuid_v7() FROM PUBLIC;
REVOKE ALL ON FUNCTION zuocheng.reject_append_only_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION zuocheng.prepare_project_deletion_request() FROM PUBLIC;
REVOKE ALL ON PROCEDURE zuocheng.transition_project_deletion(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON PROCEDURE zuocheng.purge_project(uuid, uuid, integer) FROM PUBLIC;

GRANT USAGE ON SCHEMA zuocheng TO zuocheng_app;
GRANT USAGE ON SCHEMA zuocheng TO zuocheng_purge;
GRANT EXECUTE ON FUNCTION zuocheng.uuid_v7() TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.current_session_tenant_id() TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.current_session_user_id() TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.require_app_tenant(uuid) TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.require_app_context(uuid, uuid) TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.lock_project_for_mutation(uuid, uuid, uuid)
  TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.lock_project_for_deletion(uuid, uuid, uuid)
  TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.claim_idempotency_record(uuid, text, text, text, uuid)
  TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.complete_idempotency_record(
  uuid, text, text, uuid, integer, jsonb
) TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.create_project(uuid, text, text) TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.copy_project(uuid, uuid, integer, text) TO zuocheng_app;
GRANT EXECUTE ON FUNCTION zuocheng.request_project_deletion(
  uuid, uuid, integer, uuid, timestamptz, text
) TO zuocheng_app;
GRANT EXECUTE ON PROCEDURE zuocheng.update_project_content(uuid, uuid, integer, uuid, text, text)
  TO zuocheng_app;
GRANT EXECUTE ON PROCEDURE zuocheng.archive_project(uuid, uuid, integer, uuid) TO zuocheng_app;
GRANT EXECUTE ON PROCEDURE zuocheng.soft_delete_project(uuid, uuid, integer, uuid) TO zuocheng_app;
GRANT EXECUTE ON PROCEDURE zuocheng.restore_project(uuid, uuid, integer, uuid) TO zuocheng_app;
GRANT EXECUTE ON PROCEDURE zuocheng.cancel_project_deletion(uuid, uuid, integer, uuid)
  TO zuocheng_app;
GRANT EXECUTE ON PROCEDURE zuocheng.transition_project_deletion(uuid, uuid, integer, text)
  TO zuocheng_purge;
GRANT EXECUTE ON PROCEDURE zuocheng.purge_project(uuid, uuid, integer)
  TO zuocheng_purge;
GRANT EXECUTE ON FUNCTION zuocheng.purge_expired_idempotency_records(uuid, integer)
  TO zuocheng_purge;
REVOKE ALL ON PROCEDURE zuocheng.transition_project_deletion(uuid, uuid, integer, text)
  FROM zuocheng_app;
REVOKE ALL ON PROCEDURE zuocheng.purge_project(uuid, uuid, integer) FROM zuocheng_app;
REVOKE ALL ON FUNCTION zuocheng.purge_expired_idempotency_records(uuid, integer)
  FROM zuocheng_app;
GRANT SELECT, UPDATE ON zuocheng.tenant TO zuocheng_app;
GRANT SELECT ON zuocheng."user" TO zuocheng_app;
GRANT SELECT ON zuocheng.membership, zuocheng.project_acl TO zuocheng_app;
GRANT SELECT ON zuocheng.idempotency_record TO zuocheng_app;
GRANT SELECT ON
  zuocheng.project,
  zuocheng.deletion_request,
  zuocheng.project_version,
  zuocheng.audit_event
TO zuocheng_app;

-- Ownership is deliberately transferred to a NOLOGIN role. The application
-- role therefore cannot acquire the owner bypass, and it is also NOBYPASSRLS.
ALTER TABLE zuocheng.tenant OWNER TO zuocheng_owner;
ALTER TABLE zuocheng."user" OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.membership OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.runtime_principal OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.project OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.project_version OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.project_acl OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.idempotency_record OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.audit_event OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.deletion_request OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.uuid_v7() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.reject_append_only_mutation() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.current_session_tenant_id() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.current_session_user_id() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.require_app_tenant(uuid) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.require_active_member(uuid, uuid) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.require_app_context(uuid, uuid) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.require_project_access(uuid, uuid, uuid, text) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.lock_project_for_mutation(uuid, uuid, uuid) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.lock_project_for_deletion(uuid, uuid, uuid) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.claim_idempotency_record(uuid, text, text, text, uuid)
  OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.complete_idempotency_record(uuid, text, text, uuid, integer, jsonb)
  OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.purge_expired_idempotency_records(uuid, integer)
  OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.guard_project_update() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.guard_project_parent_state() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.guard_project_copy_source() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.append_project_version(uuid, uuid, uuid) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.append_audit_event(uuid, uuid, text, text, uuid, uuid, jsonb)
  OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.create_project(uuid, text, text) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.copy_project(uuid, uuid, integer, text) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.prepare_project_deletion_request() OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.request_project_deletion(uuid, uuid, integer, uuid, timestamptz, text)
  OWNER TO zuocheng_owner;
ALTER PROCEDURE zuocheng.update_project_content(uuid, uuid, integer, uuid, text, text)
  OWNER TO zuocheng_owner;
ALTER PROCEDURE zuocheng.archive_project(uuid, uuid, integer, uuid) OWNER TO zuocheng_owner;
ALTER PROCEDURE zuocheng.soft_delete_project(uuid, uuid, integer, uuid) OWNER TO zuocheng_owner;
ALTER PROCEDURE zuocheng.restore_project(uuid, uuid, integer, uuid) OWNER TO zuocheng_owner;
ALTER PROCEDURE zuocheng.cancel_project_deletion(uuid, uuid, integer, uuid)
  OWNER TO zuocheng_owner;
ALTER PROCEDURE zuocheng.transition_project_deletion(uuid, uuid, integer, text)
  OWNER TO zuocheng_owner;
ALTER PROCEDURE zuocheng.purge_project(uuid, uuid, integer) OWNER TO zuocheng_owner;

COMMIT;
