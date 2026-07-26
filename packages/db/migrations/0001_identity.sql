BEGIN;

-- ZC-03 depends on the UUID, tenant, membership, RLS and owner-role contract
-- installed by 0000_foundation.sql. Fail with a stable code when migrations
-- are attempted out of order.
DO $dependency$
BEGIN
  IF to_regclass('zuocheng."user"') IS NULL
     OR to_regclass('zuocheng.membership') IS NULL
     OR to_regprocedure('zuocheng.uuid_v7()') IS NULL THEN
    RAISE EXCEPTION '0001_identity.sql requires 0000_foundation.sql'
      USING ERRCODE = '3F000';
  END IF;
END
$dependency$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zuocheng_auth') THEN
    CREATE ROLE zuocheng_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE zuocheng_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

SET LOCAL ROLE zuocheng_owner;

-- Better Auth 1.6.25 user fields are mapped onto the existing domain user:
-- name -> display_name. The identity migration extends that table rather than
-- creating a second user authority.
ALTER TABLE zuocheng."user"
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN image text,
  ADD COLUMN account_status text,
  ADD COLUMN active_tenant_id uuid,
  ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();

UPDATE zuocheng."user"
   SET account_status = CASE WHEN deleted_at IS NULL THEN 'active' ELSE 'deleted' END
 WHERE account_status IS NULL;

ALTER TABLE zuocheng."user"
  ALTER COLUMN account_status SET DEFAULT 'active',
  ALTER COLUMN account_status SET NOT NULL,
  ADD CONSTRAINT user_account_status_valid
    CHECK (account_status IN ('active', 'suspended', 'deletion_pending', 'deleted')),
  ADD CONSTRAINT user_deletion_state_valid
    CHECK ((account_status = 'deleted') = (deleted_at IS NOT NULL)),
  ADD CONSTRAINT user_active_tenant_fk
    FOREIGN KEY (active_tenant_id) REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT;

-- Better Auth core account schema. Provider identifiers are deliberately data,
-- not seeded or restricted to fictitious configured providers. Credential
-- passwords are one-way hashes. OAuth bearer material must remain recoverable
-- for provider refresh/revocation, so it uses a versioned encrypted envelope.
-- The runtime binds purpose/provider/user/tenant as AEAD AAD and persists its
-- digest and key version beside the ciphertext; the tenant FK prevents context
-- substitution across memberships.
CREATE TABLE zuocheng.account (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  user_id uuid NOT NULL,
  account_id varchar(512) NOT NULL,
  provider_id varchar(128) NOT NULL,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  id_token_ciphertext text,
  token_tenant_id uuid,
  token_key_version integer,
  token_aad_hash char(64),
  password_hash text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_provider_account_unique UNIQUE (provider_id, account_id),
  CONSTRAINT account_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT account_token_membership_fk FOREIGN KEY (token_tenant_id, user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT account_provider_id_nonempty CHECK (btrim(provider_id) <> ''),
  CONSTRAINT account_account_id_nonempty CHECK (btrim(account_id) <> ''),
  CONSTRAINT account_credential_shape_valid CHECK (
    (
      provider_id = 'credential'
      AND account_id = user_id::text
      AND password_hash IS NOT NULL
      AND btrim(password_hash) <> ''
      AND access_token_ciphertext IS NULL
      AND refresh_token_ciphertext IS NULL
      AND id_token_ciphertext IS NULL
      AND token_tenant_id IS NULL
      AND token_key_version IS NULL
      AND token_aad_hash IS NULL
    )
    OR (provider_id <> 'credential' AND password_hash IS NULL)
  ),
  CONSTRAINT account_token_bundle_valid CHECK (
    (
      access_token_ciphertext IS NULL
      AND refresh_token_ciphertext IS NULL
      AND id_token_ciphertext IS NULL
      AND token_tenant_id IS NULL
      AND token_key_version IS NULL
      AND token_aad_hash IS NULL
    )
    OR (
      (
        access_token_ciphertext IS NOT NULL
        OR refresh_token_ciphertext IS NOT NULL
        OR id_token_ciphertext IS NOT NULL
      )
      AND provider_id <> 'credential'
      AND token_tenant_id IS NOT NULL
      AND token_key_version IS NOT NULL
      AND token_aad_hash IS NOT NULL
    )
  ),
  CONSTRAINT account_token_ciphertext_valid CHECK (
    (
      access_token_ciphertext IS NULL
      OR access_token_ciphertext ~
        ('^\$ba\$' || token_key_version::text || '\$([0-9a-f]{2})+$')
    )
    AND (
      refresh_token_ciphertext IS NULL
      OR refresh_token_ciphertext ~
        ('^\$ba\$' || token_key_version::text || '\$([0-9a-f]{2})+$')
    )
    AND (
      id_token_ciphertext IS NULL
      OR id_token_ciphertext ~
        ('^\$ba\$' || token_key_version::text || '\$([0-9a-f]{2})+$')
    )
  ),
  CONSTRAINT account_token_aad_valid CHECK (
    (token_key_version IS NULL OR token_key_version > 0)
    AND (token_aad_hash IS NULL OR token_aad_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT account_token_expiry_valid CHECK (
    (access_token_expires_at IS NULL OR access_token_ciphertext IS NOT NULL)
    AND (refresh_token_expires_at IS NULL OR refresh_token_ciphertext IS NOT NULL)
  )
);

CREATE INDEX account_user_idx ON zuocheng.account (user_id);
CREATE INDEX account_provider_user_idx ON zuocheng.account (provider_id, user_id);

-- Better Auth core session fields plus the device and active-tenant snapshot
-- needed to reject a live cookie after account/membership suspension.
CREATE TABLE zuocheng.session (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  user_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  ip_address_hash char(64),
  user_agent text,
  active_tenant_id uuid,
  account_status_snapshot text NOT NULL DEFAULT 'active',
  device_id_hash char(64),
  device_name varchar(200),
  device_type varchar(80),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revocation_reason varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT session_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT session_active_tenant_fk FOREIGN KEY (active_tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT session_active_membership_fk FOREIGN KEY (active_tenant_id, user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT session_token_hash_valid CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT session_ip_address_hash_valid
    CHECK (ip_address_hash IS NULL OR ip_address_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT session_device_id_hash_valid
    CHECK (device_id_hash IS NULL OR device_id_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT session_account_status_valid
    CHECK (account_status_snapshot IN ('active', 'suspended', 'deletion_pending', 'deleted')),
  CONSTRAINT session_expiry_valid CHECK (isfinite(expires_at)),
  CONSTRAINT session_revocation_valid
    CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

CREATE INDEX session_user_expiry_idx ON zuocheng.session (user_id, expires_at);
CREATE INDEX session_active_tenant_user_idx ON zuocheng.session (active_tenant_id, user_id);
CREATE INDEX session_device_idx ON zuocheng.session (user_id, device_id_hash);
CREATE INDEX session_active_expiry_idx ON zuocheng.session (expires_at)
  WHERE revoked_at IS NULL;

-- Better Auth hashes identifiers with SHA-256 base64url (43 characters) when
-- verification.storeIdentifier = 'hashed'. Ordinary recovery selectors stay
-- hash-only while their non-secret subject value (usually a user UUID) remains
-- compatible with the stable core schema. OAuth state/PKCE is the exception:
-- it must be recovered once, so a custom identity adapter stores a versioned
-- ciphertext with purpose/provider/user/tenant-bound AEAD AAD metadata.
CREATE TABLE zuocheng.verification (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  user_id uuid,
  tenant_id uuid,
  purpose varchar(80) NOT NULL DEFAULT 'generic',
  provider_id varchar(128),
  identifier_hash varchar(64) NOT NULL,
  subject_value text,
  state_ciphertext text,
  ciphertext_key_version integer,
  ciphertext_aad_hash char(64),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_identifier_hash_unique UNIQUE (identifier_hash),
  CONSTRAINT verification_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT verification_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT verification_tenant_membership_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES zuocheng.membership (tenant_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT verification_purpose_valid CHECK (
    purpose IN (
      'generic', 'email_verification', 'password_reset', 'oauth_state',
      'webauthn_challenge', 'account_deletion', 'recent_auth'
    )
  ),
  CONSTRAINT verification_identifier_hash_valid
    CHECK (identifier_hash ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT verification_payload_storage_valid CHECK (
    (
      purpose = 'oauth_state'
      AND subject_value IS NULL
      AND state_ciphertext IS NOT NULL
      AND provider_id IS NOT NULL
      AND btrim(provider_id) <> ''
      AND ciphertext_key_version IS NOT NULL
      AND ciphertext_aad_hash IS NOT NULL
      AND (
        (user_id IS NULL AND tenant_id IS NULL)
        OR (user_id IS NOT NULL AND tenant_id IS NOT NULL)
      )
    )
    OR (
      purpose <> 'oauth_state'
      AND subject_value IS NOT NULL
      AND btrim(subject_value) <> ''
      AND left(ltrim(subject_value), 1) NOT IN ('{', '[')
      AND state_ciphertext IS NULL
      AND provider_id IS NULL
      AND ciphertext_key_version IS NULL
      AND ciphertext_aad_hash IS NULL
    )
  ),
  CONSTRAINT verification_state_ciphertext_valid CHECK (
    state_ciphertext IS NULL
    OR state_ciphertext ~
      ('^\$ba\$' || ciphertext_key_version::text || '\$([0-9a-f]{2})+$')
  ),
  CONSTRAINT verification_state_aad_valid CHECK (
    (ciphertext_key_version IS NULL OR ciphertext_key_version > 0)
    AND (
      ciphertext_aad_hash IS NULL
      OR ciphertext_aad_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT verification_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT verification_attempts_valid
    CHECK (attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts),
  CONSTRAINT verification_terminal_state_valid
    CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX verification_user_purpose_idx
  ON zuocheng.verification (user_id, purpose);
CREATE INDEX verification_expiry_idx ON zuocheng.verification (expires_at);

-- @better-auth/passkey 1.6.25 plugin schema, with revocation and last-use
-- extensions. Only the WebAuthn public key is stored; private key material
-- never leaves the authenticator.
CREATE TABLE zuocheng.passkey (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  name varchar(200),
  public_key text NOT NULL,
  user_id uuid NOT NULL,
  credential_id varchar(1024) NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  device_type varchar(32) NOT NULL,
  backed_up boolean NOT NULL DEFAULT false,
  transports text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  aaguid varchar(36),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revocation_reason varchar(160),
  CONSTRAINT passkey_credential_id_unique UNIQUE (credential_id),
  CONSTRAINT passkey_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT passkey_public_key_nonempty CHECK (btrim(public_key) <> ''),
  CONSTRAINT passkey_credential_id_nonempty CHECK (btrim(credential_id) <> ''),
  CONSTRAINT passkey_counter_nonnegative CHECK (counter >= 0),
  CONSTRAINT passkey_device_type_valid CHECK (device_type IN ('singleDevice', 'multiDevice')),
  CONSTRAINT passkey_aaguid_valid CHECK (
    aaguid IS NULL
    OR aaguid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT passkey_revocation_valid
    CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

CREATE INDEX passkey_user_idx ON zuocheng.passkey (user_id);

CREATE TABLE zuocheng.identity_audit_event (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  user_id uuid,
  tenant_id uuid,
  session_id uuid,
  event_type varchar(160) NOT NULL,
  request_id uuid,
  ip_address_hash char(64),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_audit_event_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT identity_audit_event_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES zuocheng.tenant (id) ON DELETE RESTRICT,
  CONSTRAINT identity_audit_event_session_fk FOREIGN KEY (session_id)
    REFERENCES zuocheng.session (id) ON DELETE RESTRICT,
  CONSTRAINT identity_audit_event_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT identity_audit_event_ip_hash_valid
    CHECK (ip_address_hash IS NULL OR ip_address_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX identity_audit_event_user_occurred_idx
  ON zuocheng.identity_audit_event (user_id, occurred_at);
CREATE INDEX identity_audit_event_tenant_occurred_idx
  ON zuocheng.identity_audit_event (tenant_id, occurred_at);

CREATE TABLE zuocheng.account_deletion_request (
  id uuid PRIMARY KEY DEFAULT zuocheng.uuid_v7(),
  user_id uuid NOT NULL,
  requested_by_session_id uuid,
  confirmation_token_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'pending_confirmation',
  export_status text NOT NULL DEFAULT 'not_requested',
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmation_expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  confirmed_at timestamptz,
  scheduled_for timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_deletion_request_confirmation_token_unique
    UNIQUE (confirmation_token_hash),
  CONSTRAINT account_deletion_request_user_fk FOREIGN KEY (user_id)
    REFERENCES zuocheng."user" (id) ON DELETE RESTRICT,
  CONSTRAINT account_deletion_request_session_fk FOREIGN KEY (requested_by_session_id)
    REFERENCES zuocheng.session (id) ON DELETE RESTRICT,
  CONSTRAINT account_deletion_request_confirmation_hash_valid
    CHECK (confirmation_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT account_deletion_request_status_valid CHECK (
    status IN ('pending_confirmation', 'pending', 'processing', 'completed', 'cancelled', 'rejected')
  ),
  CONSTRAINT account_deletion_request_export_status_valid CHECK (
    export_status IN ('not_requested', 'requested', 'ready', 'failed')
  ),
  CONSTRAINT account_deletion_request_schedule_valid CHECK (
    scheduled_for >= requested_at AND confirmation_expires_at > requested_at
  ),
  CONSTRAINT account_deletion_request_lifecycle_valid CHECK (
    ((status = 'completed') = (completed_at IS NOT NULL))
    AND ((status IN ('cancelled', 'rejected')) = (cancelled_at IS NOT NULL))
    AND NOT (completed_at IS NOT NULL AND cancelled_at IS NOT NULL)
    AND (
      (status = 'pending_confirmation' AND confirmed_at IS NULL)
      OR (status IN ('pending', 'processing', 'completed') AND confirmed_at IS NOT NULL)
      OR status IN ('cancelled', 'rejected')
    )
  )
);

CREATE UNIQUE INDEX account_deletion_request_active_user_unique
  ON zuocheng.account_deletion_request (user_id)
  WHERE status IN ('pending_confirmation', 'pending', 'processing');
CREATE INDEX account_deletion_request_status_idx
  ON zuocheng.account_deletion_request (status, scheduled_for);

-- Atomic one-time consumption prevents two callbacks or recovery requests from
-- observing the same live value. The caller receives either exactly one row or
-- none for malformed, expired, revoked, exhausted, or already-consumed input.
CREATE FUNCTION zuocheng.consume_verification_value(p_identifier_hash varchar)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  tenant_id uuid,
  purpose varchar,
  provider_id varchar,
  identifier_hash varchar,
  subject_value text,
  state_ciphertext text,
  ciphertext_key_version integer,
  ciphertext_aad_hash char(64),
  expires_at timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, zuocheng
AS $function$
  UPDATE zuocheng.verification AS candidate
     SET consumed_at = now(),
         updated_at = now()
   WHERE candidate.identifier_hash = p_identifier_hash
     AND candidate.identifier_hash ~ '^[A-Za-z0-9_-]{43}$'
     AND candidate.consumed_at IS NULL
     AND candidate.revoked_at IS NULL
     AND candidate.expires_at > now()
     AND candidate.attempts < candidate.max_attempts
  RETURNING
    candidate.id,
    candidate.user_id,
    candidate.tenant_id,
    candidate.purpose,
    candidate.provider_id,
    candidate.identifier_hash,
    candidate.subject_value,
    candidate.state_ciphertext,
    candidate.ciphertext_key_version,
    candidate.ciphertext_aad_hash,
    candidate.expires_at
$function$;

CREATE FUNCTION zuocheng.confirm_account_deletion_request(p_confirmation_token_hash text)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  status text,
  confirmed_at timestamptz
)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, zuocheng
AS $function$
  UPDATE zuocheng.account_deletion_request AS candidate
     SET status = 'pending',
         confirmed_at = now(),
         updated_at = now()
   WHERE candidate.confirmation_token_hash = p_confirmation_token_hash
     AND p_confirmation_token_hash ~ '^[0-9a-f]{64}$'
     AND candidate.status = 'pending_confirmation'
     AND candidate.confirmed_at IS NULL
     AND candidate.confirmation_expires_at > now()
  RETURNING candidate.id, candidate.user_id, candidate.status, candidate.confirmed_at
$function$;

CREATE TRIGGER identity_audit_event_append_only
BEFORE UPDATE OR DELETE ON zuocheng.identity_audit_event
FOR EACH ROW EXECUTE FUNCTION zuocheng.reject_append_only_mutation();

-- This is the canonical database session gate. It re-checks current user,
-- tenant and membership state on every database-backed validation instead of
-- trusting the status snapshots in a cookie.
CREATE FUNCTION zuocheng.resolve_identity_session(p_token_hash text)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  active_tenant_id uuid,
  account_status text,
  membership_status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, zuocheng
AS $function$
  WITH resolved AS (
    SELECT
      identity_session.id AS session_id,
      identity_session.user_id,
      identity_session.active_tenant_id,
      account_identity.account_status,
      active_membership.status AS membership_status,
      identity_session.account_status_snapshot,
      identity_session.expires_at,
      identity_session.revoked_at,
      account_identity.deleted_at AS user_deleted_at,
      active_membership.deleted_at AS membership_deleted_at,
      active_tenant.deleted_at AS tenant_deleted_at
    FROM zuocheng.session AS identity_session
    JOIN zuocheng."user" AS account_identity
      ON account_identity.id = identity_session.user_id
    JOIN zuocheng.membership AS active_membership
      ON active_membership.tenant_id = identity_session.active_tenant_id
     AND active_membership.user_id = identity_session.user_id
    JOIN zuocheng.tenant AS active_tenant
      ON active_tenant.id = identity_session.active_tenant_id
    WHERE p_token_hash ~ '^[0-9a-f]{64}$'
      AND identity_session.token_hash = p_token_hash
  )
  SELECT session_id, user_id, active_tenant_id, account_status, membership_status
    FROM resolved
   WHERE account_status = 'active'
     AND membership_status = 'active'
     AND account_status_snapshot = 'active'
     AND expires_at > now()
     AND revoked_at IS NULL
     AND user_deleted_at IS NULL
     AND membership_deleted_at IS NULL
     AND tenant_deleted_at IS NULL
$function$;

ALTER TABLE zuocheng.account ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.account FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.session FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.verification FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.passkey ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.passkey FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.identity_audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.identity_audit_event FORCE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.account_deletion_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE zuocheng.account_deletion_request FORCE ROW LEVEL SECURITY;

-- The identity adapter is a separate database capability from tenant business
-- persistence. It can read tenant/membership state only to validate the active
-- session context and has no project/application table privileges.
CREATE POLICY tenant_auth_select_policy ON zuocheng.tenant
  FOR SELECT TO zuocheng_auth
  USING (true);

CREATE POLICY membership_auth_select_policy ON zuocheng.membership
  FOR SELECT TO zuocheng_auth
  USING (true);

CREATE POLICY user_auth_maintenance_policy ON zuocheng."user"
  FOR ALL TO zuocheng_auth
  USING (true)
  WITH CHECK (true);

CREATE POLICY account_auth_maintenance_policy ON zuocheng.account
  FOR ALL TO zuocheng_auth
  USING (true)
  WITH CHECK (true);

CREATE POLICY session_auth_maintenance_policy ON zuocheng.session
  FOR ALL TO zuocheng_auth
  USING (true)
  WITH CHECK (true);

CREATE POLICY verification_auth_maintenance_policy ON zuocheng.verification
  FOR ALL TO zuocheng_auth
  USING (true)
  WITH CHECK (true);

CREATE POLICY passkey_auth_maintenance_policy ON zuocheng.passkey
  FOR ALL TO zuocheng_auth
  USING (true)
  WITH CHECK (true);

CREATE POLICY identity_audit_event_auth_select_policy ON zuocheng.identity_audit_event
  FOR SELECT TO zuocheng_auth
  USING (true);

CREATE POLICY identity_audit_event_auth_insert_policy ON zuocheng.identity_audit_event
  FOR INSERT TO zuocheng_auth
  WITH CHECK (true);

CREATE POLICY account_deletion_request_auth_maintenance_policy
  ON zuocheng.account_deletion_request
  FOR ALL TO zuocheng_auth
  USING (true)
  WITH CHECK (true);

-- FORCE RLS also applies to the NOLOGIN owner. Owner policies are only for
-- offline migrations and append-only enforcement; no runtime login may assume
-- zuocheng_owner.
CREATE POLICY account_owner_maintenance_policy ON zuocheng.account
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);
CREATE POLICY session_owner_maintenance_policy ON zuocheng.session
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);
CREATE POLICY verification_owner_maintenance_policy ON zuocheng.verification
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);
CREATE POLICY passkey_owner_maintenance_policy ON zuocheng.passkey
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);
CREATE POLICY identity_audit_event_owner_maintenance_policy ON zuocheng.identity_audit_event
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);
CREATE POLICY account_deletion_request_owner_maintenance_policy
  ON zuocheng.account_deletion_request
  FOR ALL TO zuocheng_owner USING (true) WITH CHECK (true);

REVOKE ALL ON ALL TABLES IN SCHEMA zuocheng FROM PUBLIC;
REVOKE ALL ON ALL ROUTINES IN SCHEMA zuocheng FROM PUBLIC;
REVOKE ALL ON FUNCTION zuocheng.resolve_identity_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION zuocheng.consume_verification_value(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION zuocheng.confirm_account_deletion_request(text) FROM PUBLIC;

GRANT SELECT ON zuocheng.tenant, zuocheng.membership TO zuocheng_auth;
GRANT SELECT, INSERT, UPDATE ON zuocheng."user" TO zuocheng_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  zuocheng.account,
  zuocheng.session,
  zuocheng.verification,
  zuocheng.passkey
TO zuocheng_auth;
GRANT SELECT, INSERT ON zuocheng.identity_audit_event TO zuocheng_auth;
GRANT SELECT, INSERT, UPDATE ON zuocheng.account_deletion_request TO zuocheng_auth;
GRANT EXECUTE ON FUNCTION zuocheng.uuid_v7() TO zuocheng_auth;
GRANT EXECUTE ON FUNCTION zuocheng.resolve_identity_session(text) TO zuocheng_auth;
GRANT EXECUTE ON FUNCTION zuocheng.consume_verification_value(varchar) TO zuocheng_auth;
GRANT EXECUTE ON FUNCTION zuocheng.confirm_account_deletion_request(text) TO zuocheng_auth;

ALTER TABLE zuocheng.account OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.session OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.verification OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.passkey OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.identity_audit_event OWNER TO zuocheng_owner;
ALTER TABLE zuocheng.account_deletion_request OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.resolve_identity_session(text) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.consume_verification_value(varchar) OWNER TO zuocheng_owner;
ALTER FUNCTION zuocheng.confirm_account_deletion_request(text) OWNER TO zuocheng_owner;

RESET ROLE;

-- Schema ownership remains with the offline migration principal from 0000.
-- Only that principal can delegate namespace access to the identity role.
GRANT USAGE ON SCHEMA zuocheng TO zuocheng_auth;

COMMIT;
