-- NH-027 / M04 Organization data layer.
-- M01 owns Entity identity and authorization. M04 owns only organization business
-- metadata, membership/role history, charter references, and an opaque KB account
-- reference. No M04 balance, ledger, escrow, or local organization wallet is created.
--
-- M04 slices share the social schema and are independently deployable. Referential
-- integrity for this slice is enforced with fail-closed triggers rather than adding
-- schema-global foreign-key metadata that would couple independently owned M04 slices.

CREATE SCHEMA IF NOT EXISTS social;

CREATE TABLE social.organizations (
  world_id text NOT NULL,
  organization_entity_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  charter_ref text NULL,
  kb_account_ref text NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, organization_entity_id),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (charter_ref IS NULL OR length(btrim(charter_ref)) BETWEEN 1 AND 2000),
  CHECK (kb_account_ref IS NULL OR length(btrim(kb_account_ref)) BETWEEN 1 AND 2000)
);

CREATE TABLE social.organization_revisions (
  world_id text NOT NULL,
  organization_entity_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  metadata jsonb NOT NULL,
  charter_ref text NULL,
  kb_account_ref text NULL,
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (world_id, organization_entity_id, version),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE social.memberships (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  organization_entity_id uuid NOT NULL,
  member_entity_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz NULL,
  leave_reason text NULL,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, membership_id),
  UNIQUE (world_id, organization_entity_id, membership_id),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  CHECK (leave_reason IS NULL OR length(btrim(leave_reason)) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX memberships_one_active_member_idx
  ON social.memberships(world_id, organization_entity_id, member_entity_id)
  WHERE left_at IS NULL;
CREATE INDEX memberships_member_history_idx
  ON social.memberships(world_id, member_entity_id, joined_at DESC);

CREATE TABLE social.organization_roles (
  role_assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  organization_entity_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_key text NOT NULL CHECK (role_key IN ('OWNER','DIRECTOR','MANAGER','SIGNER','MEMBER')),
  role_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  granted_by uuid NOT NULL,
  revoked_by uuid NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, role_assignment_id),
  CHECK (jsonb_typeof(role_metadata) = 'object'),
  CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_at >= granted_at)
  )
);
CREATE UNIQUE INDEX organization_roles_one_active_role_idx
  ON social.organization_roles(world_id, membership_id, role_key)
  WHERE revoked_at IS NULL;

CREATE TABLE social.organization_role_history (
  history_id bigserial PRIMARY KEY,
  world_id text NOT NULL,
  organization_entity_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_assignment_id uuid NOT NULL,
  role_key text NOT NULL,
  role_metadata jsonb NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('GRANTED','UPDATED','REVOKED')),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL,
  UNIQUE (world_id, role_assignment_id, version),
  CHECK (jsonb_typeof(role_metadata) = 'object')
);
CREATE INDEX organization_role_history_membership_idx
  ON social.organization_role_history(world_id, membership_id, changed_at, history_id);

CREATE OR REPLACE FUNCTION social.assert_organization_entity_ref(
  p_world_id text,
  p_entity_id uuid,
  p_label text,
  p_allowed_types text[] DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  entity_kind text;
BEGIN
  SELECT entity_type INTO entity_kind
    FROM core.entities
   WHERE world_id = p_world_id AND entity_id = p_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% must reference an existing M01 Entity in the same world', p_label
      USING ERRCODE='23503';
  END IF;
  IF p_allowed_types IS NOT NULL AND NOT (entity_kind = ANY(p_allowed_types)) THEN
    RAISE EXCEPTION '% must reference an M01 COMPANY or ORGANIZATION Entity', p_label
      USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION social.guard_organization_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM social.assert_organization_entity_ref(
    NEW.world_id,
    NEW.organization_entity_id,
    'organization_entity_id',
    ARRAY['COMPANY','ORGANIZATION']::text[]
  );
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.created_by, 'created_by');
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.updated_by, 'updated_by');

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'organization initial version must be 1' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.world_id <> OLD.world_id
     OR NEW.organization_entity_id <> OLD.organization_entity_id
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'organization identity and creation evidence are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'organization version must advance exactly once' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_guard
  BEFORE INSERT OR UPDATE ON social.organizations
  FOR EACH ROW EXECUTE FUNCTION social.guard_organization_row();

CREATE OR REPLACE FUNCTION social.guard_organization_revision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM social.organizations
   WHERE world_id = NEW.world_id
     AND organization_entity_id = NEW.organization_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization revision must reference an existing organization'
      USING ERRCODE='23503';
  END IF;
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.changed_by, 'changed_by');
  RETURN NEW;
END $$;
CREATE TRIGGER organization_revisions_reference_guard
  BEFORE INSERT ON social.organization_revisions
  FOR EACH ROW EXECUTE FUNCTION social.guard_organization_revision_insert();

CREATE OR REPLACE FUNCTION social.capture_organization_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO social.organization_revisions
    (world_id,organization_entity_id,version,metadata,charter_ref,kb_account_ref,changed_by,changed_at)
  VALUES
    (NEW.world_id,NEW.organization_entity_id,NEW.version,NEW.metadata,NEW.charter_ref,NEW.kb_account_ref,NEW.updated_by,NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER organizations_revision_history
  AFTER INSERT OR UPDATE ON social.organizations
  FOR EACH ROW EXECUTE FUNCTION social.capture_organization_revision();

CREATE OR REPLACE FUNCTION social.guard_membership_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM social.organizations
   WHERE world_id = NEW.world_id
     AND organization_entity_id = NEW.organization_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'membership must reference an existing organization' USING ERRCODE='23503';
  END IF;
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.member_entity_id, 'member_entity_id');
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.created_by, 'created_by');
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.updated_by, 'updated_by');

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'membership initial version must be 1' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.world_id <> OLD.world_id
     OR NEW.organization_entity_id <> OLD.organization_entity_id
     OR NEW.member_entity_id <> OLD.member_entity_id
     OR NEW.membership_id <> OLD.membership_id
     OR NEW.joined_at <> OLD.joined_at
     OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'membership identity and join evidence are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.left_at IS NOT NULL THEN
    RAISE EXCEPTION 'exited membership is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'membership version must advance exactly once' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_guard
  BEFORE INSERT OR UPDATE ON social.memberships
  FOR EACH ROW EXECUTE FUNCTION social.guard_membership_row();

CREATE OR REPLACE FUNCTION social.guard_organization_role_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  membership_left_at timestamptz;
BEGIN
  SELECT left_at INTO membership_left_at
    FROM social.memberships
   WHERE world_id = NEW.world_id
     AND organization_entity_id = NEW.organization_entity_id
     AND membership_id = NEW.membership_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role assignment must reference an organization membership' USING ERRCODE='23503';
  END IF;

  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.granted_by, 'granted_by');
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.updated_by, 'updated_by');
  IF NEW.revoked_by IS NOT NULL THEN
    PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.revoked_by, 'revoked_by');
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF membership_left_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot grant a role to an exited member' USING ERRCODE='23514';
    END IF;
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'role assignment initial version must be 1' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.world_id <> OLD.world_id
     OR NEW.organization_entity_id <> OLD.organization_entity_id
     OR NEW.membership_id <> OLD.membership_id
     OR NEW.role_assignment_id <> OLD.role_assignment_id
     OR NEW.role_key <> OLD.role_key
     OR NEW.granted_at <> OLD.granted_at
     OR NEW.granted_by <> OLD.granted_by THEN
    RAISE EXCEPTION 'role assignment identity and grant evidence are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'revoked role assignment is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'role assignment version must advance exactly once' USING ERRCODE='23514';
  END IF;
  IF NEW.revoked_at IS NULL AND membership_left_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot update an active role for an exited member' USING ERRCODE='23514';
  END IF;
  IF NEW.revoked_at IS NOT NULL AND NEW.updated_by <> NEW.revoked_by THEN
    RAISE EXCEPTION 'role revocation actor must be the role updater' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER organization_roles_guard
  BEFORE INSERT OR UPDATE ON social.organization_roles
  FOR EACH ROW EXECUTE FUNCTION social.guard_organization_role_row();

CREATE OR REPLACE FUNCTION social.guard_organization_role_history_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM social.memberships
   WHERE world_id = NEW.world_id
     AND organization_entity_id = NEW.organization_entity_id
     AND membership_id = NEW.membership_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role history must reference an organization membership' USING ERRCODE='23503';
  END IF;
  PERFORM 1 FROM social.organization_roles
   WHERE world_id = NEW.world_id
     AND organization_entity_id = NEW.organization_entity_id
     AND membership_id = NEW.membership_id
     AND role_assignment_id = NEW.role_assignment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'role history must reference an organization role assignment' USING ERRCODE='23503';
  END IF;
  PERFORM social.assert_organization_entity_ref(NEW.world_id, NEW.changed_by, 'changed_by');
  RETURN NEW;
END $$;
CREATE TRIGGER organization_role_history_reference_guard
  BEFORE INSERT ON social.organization_role_history
  FOR EACH ROW EXECUTE FUNCTION social.guard_organization_role_history_insert();

CREATE OR REPLACE FUNCTION social.capture_organization_role_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  history_status text;
BEGIN
  history_status := CASE
    WHEN TG_OP = 'INSERT' THEN 'GRANTED'
    WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN 'REVOKED'
    ELSE 'UPDATED'
  END;
  INSERT INTO social.organization_role_history
    (world_id,organization_entity_id,membership_id,role_assignment_id,role_key,role_metadata,version,status,changed_by,changed_at)
  VALUES
    (NEW.world_id,NEW.organization_entity_id,NEW.membership_id,NEW.role_assignment_id,NEW.role_key,NEW.role_metadata,NEW.version,history_status,NEW.updated_by,NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER organization_roles_history
  AFTER INSERT OR UPDATE ON social.organization_roles
  FOR EACH ROW EXECUTE FUNCTION social.capture_organization_role_history();

CREATE OR REPLACE FUNCTION social.revoke_roles_on_membership_exit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
    UPDATE social.organization_roles
       SET revoked_at = NEW.left_at,
           revoked_by = NEW.updated_by,
           updated_by = NEW.updated_by,
           version = version + 1
     WHERE world_id = NEW.world_id
       AND organization_entity_id = NEW.organization_entity_id
       AND membership_id = NEW.membership_id
       AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_exit_revoke_roles
  AFTER UPDATE ON social.memberships
  FOR EACH ROW EXECUTE FUNCTION social.revoke_roles_on_membership_exit();

CREATE OR REPLACE FUNCTION social.reject_organization_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only organization evidence', TG_TABLE_NAME USING ERRCODE='55000';
END $$;
CREATE TRIGGER organization_revisions_append_only
  BEFORE UPDATE OR DELETE ON social.organization_revisions
  FOR EACH ROW EXECUTE FUNCTION social.reject_organization_evidence_mutation();
CREATE TRIGGER organization_role_history_append_only
  BEFORE UPDATE OR DELETE ON social.organization_role_history
  FOR EACH ROW EXECUTE FUNCTION social.reject_organization_evidence_mutation();

CREATE OR REPLACE FUNCTION social.reject_organization_record_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records must be retired/versioned instead of deleted', TG_TABLE_NAME USING ERRCODE='55000';
END $$;
CREATE TRIGGER organizations_no_delete
  BEFORE DELETE ON social.organizations
  FOR EACH ROW EXECUTE FUNCTION social.reject_organization_record_delete();
CREATE TRIGGER memberships_no_delete
  BEFORE DELETE ON social.memberships
  FOR EACH ROW EXECUTE FUNCTION social.reject_organization_record_delete();
CREATE TRIGGER organization_roles_no_delete
  BEFORE DELETE ON social.organization_roles
  FOR EACH ROW EXECUTE FUNCTION social.reject_organization_record_delete();

CREATE OR REPLACE FUNCTION social.guard_core_entity_organization_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  referenced boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.world_id = OLD.world_id AND NEW.entity_id = OLD.entity_id THEN
    IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
       AND NEW.entity_type NOT IN ('COMPANY','ORGANIZATION')
       AND EXISTS (
         SELECT 1 FROM social.organizations
          WHERE world_id = OLD.world_id AND organization_entity_id = OLD.entity_id
       ) THEN
      RAISE EXCEPTION 'organization Entity type cannot change while M04 organization data references it'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT
    EXISTS (
      SELECT 1 FROM social.organizations
       WHERE world_id = OLD.world_id
         AND (organization_entity_id = OLD.entity_id OR created_by = OLD.entity_id OR updated_by = OLD.entity_id)
    ) OR EXISTS (
      SELECT 1 FROM social.organization_revisions
       WHERE world_id = OLD.world_id AND changed_by = OLD.entity_id
    ) OR EXISTS (
      SELECT 1 FROM social.memberships
       WHERE world_id = OLD.world_id
         AND (member_entity_id = OLD.entity_id OR created_by = OLD.entity_id OR updated_by = OLD.entity_id)
    ) OR EXISTS (
      SELECT 1 FROM social.organization_roles
       WHERE world_id = OLD.world_id
         AND (granted_by = OLD.entity_id OR revoked_by = OLD.entity_id OR updated_by = OLD.entity_id)
    ) OR EXISTS (
      SELECT 1 FROM social.organization_role_history
       WHERE world_id = OLD.world_id AND changed_by = OLD.entity_id
    )
  INTO referenced;

  IF referenced THEN
    RAISE EXCEPTION 'M01 Entity is referenced by M04 organization data' USING ERRCODE='23503';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_entities_organization_update_guard
  BEFORE UPDATE OF world_id, entity_id, entity_type ON core.entities
  FOR EACH ROW EXECUTE FUNCTION social.guard_core_entity_organization_references();
CREATE TRIGGER core_entities_organization_delete_guard
  BEFORE DELETE ON core.entities
  FOR EACH ROW EXECUTE FUNCTION social.guard_core_entity_organization_references();
