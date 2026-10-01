-- NH-024 M04 WorldObject data layer.
-- WorldObject content is append-only and versioned. A publication must present the
-- exact current version it observed; stale concurrent writers fail instead of
-- silently replacing each other.
--
-- M04 exposes the public surface in the social schema. The WorldObject aggregate
-- keeps its FK-bearing persistence in an objects sub-schema so independently
-- delivered M04 slices do not couple their table-constraint namespaces.

CREATE SCHEMA IF NOT EXISTS social;
CREATE SCHEMA IF NOT EXISTS objects;

CREATE TABLE objects.world_objects (
  world_id text NOT NULL,
  object_id uuid NOT NULL DEFAULT gen_random_uuid(),
  object_type text NOT NULL CHECK (btrim(object_type) <> ''),
  creator_entity_id uuid NOT NULL,
  controller_entity_id uuid NOT NULL,
  current_version bigint NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  lifecycle_status text NOT NULL DEFAULT 'DRAFT'
    CHECK (lifecycle_status IN ('DRAFT','PUBLISHED','ARCHIVED','RETIRED')),
  executable_actions text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, object_id),
  CONSTRAINT world_objects_creator_world_fkey
    FOREIGN KEY (world_id, creator_entity_id)
    REFERENCES core.entities(world_id, entity_id),
  CONSTRAINT world_objects_controller_world_fkey
    FOREIGN KEY (world_id, controller_entity_id)
    REFERENCES core.entities(world_id, entity_id)
);
CREATE INDEX world_objects_creator_idx
  ON objects.world_objects(world_id, creator_entity_id, created_at, object_id);
CREATE INDEX world_objects_controller_idx
  ON objects.world_objects(world_id, controller_entity_id, lifecycle_status, object_id);

CREATE TABLE objects.object_versions (
  world_id text NOT NULL,
  object_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  parent_version bigint NULL,
  content_ref text NOT NULL CHECK (btrim(content_ref) <> ''),
  content_digest text NOT NULL CHECK (btrim(content_digest) <> ''),
  digest_algorithm text NOT NULL DEFAULT 'sha256' CHECK (btrim(digest_algorithm) <> ''),
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(dependencies) = 'array'),
  change_summary text NULL,
  author_entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, object_id, version),
  CONSTRAINT object_versions_expected_sequence_check
    CHECK (version = expected_version + 1),
  CONSTRAINT object_versions_parent_presence_check
    CHECK ((version = 1 AND parent_version IS NULL) OR (version > 1 AND parent_version IS NOT NULL)),
  CONSTRAINT object_versions_object_fkey
    FOREIGN KEY (world_id, object_id)
    REFERENCES objects.world_objects(world_id, object_id) ON DELETE RESTRICT,
  CONSTRAINT object_versions_parent_fkey
    FOREIGN KEY (world_id, object_id, parent_version)
    REFERENCES objects.object_versions(world_id, object_id, version) ON DELETE RESTRICT,
  CONSTRAINT object_versions_author_world_fkey
    FOREIGN KEY (world_id, author_entity_id)
    REFERENCES core.entities(world_id, entity_id)
);
CREATE INDEX object_versions_author_idx
  ON objects.object_versions(world_id, author_entity_id, created_at, object_id, version);

CREATE TABLE objects.object_contributors (
  world_id text NOT NULL,
  object_id uuid NOT NULL,
  version bigint NOT NULL,
  contributor_entity_id uuid NOT NULL,
  contribution_role text NOT NULL DEFAULT 'CONTRIBUTOR'
    CHECK (btrim(contribution_role) <> ''),
  contribution_ref text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, object_id, version, contributor_entity_id, contribution_role),
  CONSTRAINT object_contributors_version_fkey
    FOREIGN KEY (world_id, object_id, version)
    REFERENCES objects.object_versions(world_id, object_id, version) ON DELETE RESTRICT,
  CONSTRAINT object_contributors_entity_world_fkey
    FOREIGN KEY (world_id, contributor_entity_id)
    REFERENCES core.entities(world_id, entity_id)
);
CREATE INDEX object_contributors_entity_idx
  ON objects.object_contributors(world_id, contributor_entity_id, created_at, object_id, version);

CREATE TABLE objects.object_license_refs (
  world_id text NOT NULL,
  object_id uuid NOT NULL,
  version bigint NOT NULL,
  license_ref text NOT NULL CHECK (btrim(license_ref) <> ''),
  license_scope text NOT NULL DEFAULT 'USE' CHECK (btrim(license_scope) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, object_id, version, license_ref, license_scope),
  CONSTRAINT object_license_refs_version_fkey
    FOREIGN KEY (world_id, object_id, version)
    REFERENCES objects.object_versions(world_id, object_id, version) ON DELETE RESTRICT
);
CREATE INDEX object_license_refs_lookup_idx
  ON objects.object_license_refs(world_id, license_ref, object_id, version);

-- Public M04 data surface. These are simple, automatically updatable views; all
-- authority triggers and foreign keys remain on the base tables above.
CREATE VIEW social.world_objects AS SELECT * FROM objects.world_objects;
CREATE VIEW social.object_versions AS SELECT * FROM objects.object_versions;
CREATE VIEW social.object_contributors AS SELECT * FROM objects.object_contributors;
CREATE VIEW social.object_license_refs AS SELECT * FROM objects.object_license_refs;

-- The object row is the serialized head lock. This trigger rejects a stale
-- expected_version before uniqueness checks can turn the race into an ambiguous
-- last-write-wins outcome.
CREATE OR REPLACE FUNCTION objects.guard_object_version_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_current bigint;
BEGIN
  SELECT current_version
    INTO v_current
    FROM objects.world_objects
   WHERE world_id = NEW.world_id
     AND object_id = NEW.object_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'world object %/% does not exist', NEW.world_id, NEW.object_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.expected_version <> v_current THEN
    RAISE EXCEPTION 'stale world object version: expected %, current %', NEW.expected_version, v_current
      USING ERRCODE = '40001',
            DETAIL = 'Reload the current version and merge, or create an explicit branch in a branch-capable workflow.';
  END IF;

  IF NEW.version <> v_current + 1 THEN
    RAISE EXCEPTION 'new world object version must be current version + 1'
      USING ERRCODE = '23514';
  END IF;

  IF v_current = 0 THEN
    IF NEW.parent_version IS NOT NULL THEN
      RAISE EXCEPTION 'first world object version cannot have a parent version'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.parent_version IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION 'parent_version % must equal current version % for mainline publication', NEW.parent_version, v_current
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER object_versions_expected_version_guard
  BEFORE INSERT ON objects.object_versions
  FOR EACH ROW EXECUTE FUNCTION objects.guard_object_version_insert();

-- current_version is derived only from a version row that successfully passed the
-- expected-version guard. Direct head edits cannot fabricate or rewind history.
CREATE OR REPLACE FUNCTION objects.guard_world_object_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_version <> 0 THEN
      RAISE EXCEPTION 'new world objects must start at version 0'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.world_id IS DISTINCT FROM OLD.world_id
     OR NEW.object_id IS DISTINCT FROM OLD.object_id
     OR NEW.object_type IS DISTINCT FROM OLD.object_type
     OR NEW.creator_entity_id IS DISTINCT FROM OLD.creator_entity_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'world object identity fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    IF NEW.current_version <> OLD.current_version + 1
       OR NOT EXISTS (
         SELECT 1
           FROM objects.object_versions v
          WHERE v.world_id = OLD.world_id
            AND v.object_id = OLD.object_id
            AND v.version = NEW.current_version
            AND v.expected_version = OLD.current_version
            AND ((OLD.current_version = 0 AND v.parent_version IS NULL)
                 OR v.parent_version = OLD.current_version)
       ) THEN
      RAISE EXCEPTION 'world object head can advance only from an accepted object version'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER world_objects_row_guard
  BEFORE INSERT OR UPDATE ON objects.world_objects
  FOR EACH ROW EXECUTE FUNCTION objects.guard_world_object_row();

CREATE OR REPLACE FUNCTION objects.advance_world_object_head()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE objects.world_objects
     SET current_version = NEW.version,
         updated_at = NEW.created_at
   WHERE world_id = NEW.world_id
     AND object_id = NEW.object_id
     AND current_version = NEW.expected_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'world object head changed while publishing version %', NEW.version
      USING ERRCODE = '40001';
  END IF;

  -- The author is always durable contributor evidence for this version.
  INSERT INTO objects.object_contributors(
    world_id, object_id, version, contributor_entity_id, contribution_role
  ) VALUES (
    NEW.world_id, NEW.object_id, NEW.version, NEW.author_entity_id, 'AUTHOR'
  ) ON CONFLICT DO NOTHING;

  RETURN NULL;
END $$;

CREATE TRIGGER object_versions_advance_head
  AFTER INSERT ON objects.object_versions
  FOR EACH ROW EXECUTE FUNCTION objects.advance_world_object_head();

CREATE OR REPLACE FUNCTION objects.reject_object_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; publish a new object version instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END $$;

CREATE TRIGGER object_versions_append_only
  BEFORE UPDATE OR DELETE ON objects.object_versions
  FOR EACH ROW EXECUTE FUNCTION objects.reject_object_history_mutation();
CREATE TRIGGER object_contributors_append_only
  BEFORE UPDATE OR DELETE ON objects.object_contributors
  FOR EACH ROW EXECUTE FUNCTION objects.reject_object_history_mutation();
CREATE TRIGGER object_license_refs_append_only
  BEFORE UPDATE OR DELETE ON objects.object_license_refs
  FOR EACH ROW EXECUTE FUNCTION objects.reject_object_history_mutation();

-- Canonical M04 publication entry point. Version creation plus contributor and
-- license evidence is one database statement/transaction. The base-table insert
-- trigger remains authoritative even if a caller writes through the public view.
CREATE OR REPLACE FUNCTION social.publish_object_version(
  p_world_id text,
  p_object_id uuid,
  p_expected_version bigint,
  p_content_ref text,
  p_content_digest text,
  p_author_entity_id uuid,
  p_dependencies jsonb DEFAULT '[]'::jsonb,
  p_change_summary text DEFAULT NULL,
  p_contributors jsonb DEFAULT '[]'::jsonb,
  p_license_refs jsonb DEFAULT '[]'::jsonb
) RETURNS objects.object_versions
LANGUAGE plpgsql AS $$
DECLARE
  v_version bigint := p_expected_version + 1;
  v_parent bigint := CASE WHEN p_expected_version = 0 THEN NULL ELSE p_expected_version END;
  v_item jsonb;
  v_row objects.object_versions%ROWTYPE;
BEGIN
  IF p_expected_version < 0 THEN
    RAISE EXCEPTION 'expected_version must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_dependencies, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_contributors, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_license_refs, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'dependencies, contributors, and license refs must be JSON arrays'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO objects.object_versions(
    world_id, object_id, version, expected_version, parent_version,
    content_ref, content_digest, dependencies, change_summary, author_entity_id
  ) VALUES (
    p_world_id, p_object_id, v_version, p_expected_version, v_parent,
    p_content_ref, p_content_digest, COALESCE(p_dependencies, '[]'::jsonb),
    p_change_summary, p_author_entity_id
  ) RETURNING * INTO v_row;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_contributors, '[]'::jsonb)) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NULLIF(v_item->>'entity_id', '') IS NULL THEN
      RAISE EXCEPTION 'each contributor requires entity_id' USING ERRCODE = '22023';
    END IF;
    INSERT INTO objects.object_contributors(
      world_id, object_id, version, contributor_entity_id,
      contribution_role, contribution_ref, metadata
    ) VALUES (
      p_world_id, p_object_id, v_version, (v_item->>'entity_id')::uuid,
      COALESCE(NULLIF(v_item->>'role',''), 'CONTRIBUTOR'),
      NULLIF(v_item->>'contribution_ref',''),
      COALESCE(v_item->'metadata', '{}'::jsonb)
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_license_refs, '[]'::jsonb)) LOOP
    IF jsonb_typeof(v_item) <> 'object' OR NULLIF(v_item->>'license_ref', '') IS NULL THEN
      RAISE EXCEPTION 'each license entry requires license_ref' USING ERRCODE = '22023';
    END IF;
    INSERT INTO objects.object_license_refs(
      world_id, object_id, version, license_ref, license_scope, metadata
    ) VALUES (
      p_world_id, p_object_id, v_version, v_item->>'license_ref',
      COALESCE(NULLIF(v_item->>'scope',''), 'USE'),
      COALESCE(v_item->'metadata', '{}'::jsonb)
    ) ON CONFLICT DO NOTHING;
  END LOOP;

  RETURN v_row;
END $$;
