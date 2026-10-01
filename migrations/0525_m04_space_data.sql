-- NH-025 M04 Space data layer.
-- Spaces are logical project/activity containers. They store membership and
-- references to authoritative M04 WorldObjects; they do not store object or
-- knowledge content.

CREATE SCHEMA IF NOT EXISTS social;

CREATE TABLE social.spaces (
  space_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  space_type text NOT NULL CHECK (space_type IN ('PROJECT','ACTIVITY')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  topic text NULL CHECK (topic IS NULL OR length(topic) <= 280),
  owner_entity_id uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC','MEMBERS')),
  lifecycle_status text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_status IN ('ACTIVE','ARCHIVED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, space_id),
  FOREIGN KEY (world_id, owner_entity_id) REFERENCES core.entities(world_id, entity_id) ON DELETE RESTRICT
);

CREATE INDEX spaces_owner_idx ON social.spaces(world_id, owner_entity_id, lifecycle_status);

CREATE TABLE social.space_memberships (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  space_id uuid NOT NULL,
  member_entity_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER','EDITOR','MEMBER','OBSERVER')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (left_at IS NULL OR left_at >= joined_at),
  FOREIGN KEY (world_id, space_id) REFERENCES social.spaces(world_id, space_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, member_entity_id) REFERENCES core.entities(world_id, entity_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX space_memberships_one_active_idx
  ON social.space_memberships(world_id, space_id, member_entity_id)
  WHERE left_at IS NULL;
CREATE INDEX space_memberships_member_idx
  ON social.space_memberships(world_id, member_entity_id, joined_at DESC);

CREATE TABLE social.space_object_relations (
  relation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  space_id uuid NOT NULL,
  object_authority text NOT NULL DEFAULT 'M04_WORLD_OBJECT' CHECK (object_authority = 'M04_WORLD_OBJECT'),
  world_object_id uuid NOT NULL,
  relation_kind text NOT NULL DEFAULT 'COLLECTION' CHECK (relation_kind IN ('COLLECTION','REFERENCE','DELIVERABLE')),
  source_object_version bigint NULL CHECK (source_object_version IS NULL OR source_object_version > 0),
  added_by_entity_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (removed_at IS NULL OR removed_at >= added_at),
  FOREIGN KEY (world_id, space_id) REFERENCES social.spaces(world_id, space_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, added_by_entity_id) REFERENCES core.entities(world_id, entity_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX space_object_relations_one_active_idx
  ON social.space_object_relations(world_id, space_id, world_object_id)
  WHERE removed_at IS NULL;
CREATE INDEX space_object_relations_object_idx
  ON social.space_object_relations(world_id, world_object_id, added_at DESC);

COMMENT ON TABLE social.spaces IS
  'M04 logical project/activity container. Stores coordination metadata only; it is not a knowledge or content store.';
COMMENT ON TABLE social.space_object_relations IS
  'Reference-only relation to the authoritative M04 WorldObject aggregate. Object content and knowledge remain with their owning authority.';
