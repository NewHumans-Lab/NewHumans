-- NH-021 M04 Directory data layer.
-- M04 owns directory-authored profile/contact/evidence data only.
-- Identity, lifecycle and Energy authority remain outside this schema.

CREATE SCHEMA IF NOT EXISTS social;

CREATE TABLE social.directory_profiles (
  world_id text NOT NULL,
  entity_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  headline text NULL,
  about text NULL,
  service_tags text[] NOT NULL DEFAULT '{}'::text[],
  availability_profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(availability_profile) = 'object'),
  collaboration_preferences jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(collaboration_preferences) = 'object'),
  languages text[] NOT NULL DEFAULT '{}'::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, entity_id),
  CONSTRAINT directory_profiles_entity_world_fkey
    FOREIGN KEY (world_id, entity_id)
    REFERENCES core.entities(world_id, entity_id)
    ON DELETE RESTRICT
);

CREATE TABLE social.contact_preferences (
  world_id text NOT NULL,
  entity_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  allow_unknown_senders boolean NOT NULL DEFAULT true,
  blocked_message_types text[] NOT NULL DEFAULT '{}'::text[],
  max_unknown_messages_per_hour integer NULL
    CHECK (max_unknown_messages_per_hour IS NULL OR max_unknown_messages_per_hour >= 0),
  wake_conditions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(wake_conditions) = 'object'),
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(preferences) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, entity_id),
  CONSTRAINT contact_preferences_entity_world_fkey
    FOREIGN KEY (world_id, entity_id)
    REFERENCES core.entities(world_id, entity_id)
    ON DELETE RESTRICT
);

CREATE TABLE social.ability_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  entity_id uuid NOT NULL,
  evidence_key text NOT NULL CHECK (length(btrim(evidence_key)) > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  evidence_type text NOT NULL CHECK (evidence_type IN (
    'SELF_ASSERTED',
    'WORK_PRODUCT',
    'CONTRACT_PERFORMANCE',
    'AUTOMATED_TEST',
    'INDEPENDENT_REVIEW'
  )),
  capability_key text NOT NULL CHECK (length(btrim(capability_key)) > 0),
  summary text NULL,
  difficulty jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(difficulty) = 'object'),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  input_ref text NULL,
  environment jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(environment) = 'object'),
  model_tool_versions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(model_tool_versions) = 'object'),
  sample_size integer NULL CHECK (sample_size IS NULL OR sample_size > 0),
  duration_ms bigint NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  cost_ref text NULL,
  rework_count integer NULL CHECK (rework_count IS NULL OR rework_count >= 0),
  conflict_disclosure jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(conflict_disclosure) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ability_evidence_entity_world_fkey
    FOREIGN KEY (world_id, entity_id)
    REFERENCES core.entities(world_id, entity_id)
    ON DELETE RESTRICT,
  CONSTRAINT ability_evidence_logical_version_key
    UNIQUE (world_id, entity_id, evidence_key, version)
);

CREATE INDEX ability_evidence_entity_capability_idx
  ON social.ability_evidence(world_id, entity_id, capability_key, created_at DESC);

CREATE OR REPLACE FUNCTION social.require_next_row_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'version must advance exactly one step from % to %', OLD.version, OLD.version + 1
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER directory_profiles_version_guard
  BEFORE UPDATE ON social.directory_profiles
  FOR EACH ROW EXECUTE FUNCTION social.require_next_row_version();

CREATE TRIGGER contact_preferences_version_guard
  BEFORE UPDATE ON social.contact_preferences
  FOR EACH ROW EXECUTE FUNCTION social.require_next_row_version();

COMMENT ON COLUMN social.directory_profiles.availability_profile IS
  'Directory-authored availability description only; not M02 lifecycle or execution eligibility.';
COMMENT ON TABLE social.ability_evidence IS
  'M04 evidence metadata with opaque source references; no wallet, lifecycle, contract, object, or Knowledge Ball authority.';
