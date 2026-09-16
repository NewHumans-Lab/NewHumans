-- P3-A: M02 runtime kernel. M03/Knowledge Ball remains intentionally deferred.
CREATE SCHEMA IF NOT EXISTS runtime;

CREATE TABLE runtime.agent_profiles (
  world_id text NOT NULL,
  agent_entity_id uuid NOT NULL,
  memory_subject_id uuid NOT NULL,
  current_route_id uuid NULL,
  profile_version bigint NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, agent_entity_id),
  FOREIGN KEY (world_id, agent_entity_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, memory_subject_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE runtime.lifecycle_states (
  world_id text NOT NULL,
  activity_subject_id uuid NOT NULL,
  life_status text NOT NULL DEFAULT 'REGISTERED' CHECK (life_status IN ('REGISTERED','ACTIVE','DORMANT','TERMINATED')),
  execution_status text NOT NULL DEFAULT 'BLOCKED' CHECK (execution_status IN ('IDLE','RUNNABLE','RUNNING','WAITING','BLOCKED')),
  model_status text NOT NULL DEFAULT 'TEMPORARILY_UNAVAILABLE' CHECK (model_status IN ('AVAILABLE','TEMPORARILY_UNAVAILABLE','RETIRED','CONTINUITY_UNCERTAIN')),
  restriction_flags text[] NOT NULL DEFAULT ARRAY['M03_CONTEXT_UNAVAILABLE','NO_MODEL_ROUTE']::text[],
  archive_status text NOT NULL DEFAULT 'HOT' CHECK (archive_status IN ('HOT','COLD')),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, activity_subject_id),
  FOREIGN KEY (world_id, activity_subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id)
);

CREATE TABLE runtime.model_manifests (
  manifest_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  agent_entity_id uuid NOT NULL,
  gateway_descriptor_id uuid NOT NULL,
  gateway_connector_id uuid NOT NULL,
  descriptor_version integer NOT NULL CHECK (descriptor_version > 0),
  provider_protocol text NOT NULL,
  model_reference text NOT NULL,
  assurance_level text NOT NULL,
  verification_status text NOT NULL,
  connector_kind text NOT NULL,
  billing_mode text NOT NULL,
  prompt_version text NOT NULL,
  sampling_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_digest text NULL CHECK (artifact_digest IS NULL OR length(artifact_digest)=64),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, manifest_id),
  FOREIGN KEY (world_id, agent_entity_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, gateway_descriptor_id) REFERENCES gateway.capability_descriptors(world_id, descriptor_id),
  FOREIGN KEY (world_id, gateway_connector_id) REFERENCES gateway.connector_configs(world_id, connector_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE runtime.model_routes (
  route_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  agent_entity_id uuid NOT NULL,
  route_version bigint NOT NULL CHECK (route_version > 0),
  manifest_id uuid NOT NULL,
  route_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_turn_budget_micro_e bigint NULL CHECK (max_turn_budget_micro_e IS NULL OR max_turn_budget_micro_e >= 0),
  reason text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, route_id),
  UNIQUE (world_id, agent_entity_id, route_id),
  UNIQUE (world_id, agent_entity_id, route_version),
  FOREIGN KEY (world_id, agent_entity_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, manifest_id) REFERENCES runtime.model_manifests(world_id, manifest_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

ALTER TABLE runtime.agent_profiles
  ADD CONSTRAINT agent_profiles_current_route_fkey
  FOREIGN KEY (world_id, agent_entity_id, current_route_id)
  REFERENCES runtime.model_routes(world_id, agent_entity_id, route_id);

CREATE TABLE runtime.model_change_events (
  model_change_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  agent_entity_id uuid NOT NULL,
  from_route_id uuid NULL,
  to_route_id uuid NOT NULL,
  reason text NOT NULL,
  action_id uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, model_change_id),
  FOREIGN KEY (world_id, agent_entity_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, from_route_id) REFERENCES runtime.model_routes(world_id, route_id),
  FOREIGN KEY (world_id, to_route_id) REFERENCES runtime.model_routes(world_id, route_id),
  FOREIGN KEY (world_id, action_id) REFERENCES core.actions(world_id, action_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE runtime.runtime_leases (
  world_id text NOT NULL,
  activity_subject_id uuid NOT NULL,
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 200),
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz NULL,
  PRIMARY KEY (world_id, activity_subject_id),
  FOREIGN KEY (world_id, activity_subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  CHECK (expires_at > heartbeat_at)
);

CREATE TABLE runtime.runtime_checkpoints (
  checkpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  activity_subject_id uuid NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  state_version bigint NOT NULL CHECK (state_version > 0),
  event_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  state_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, checkpoint_id),
  UNIQUE (world_id, activity_subject_id, state_version),
  FOREIGN KEY (world_id, activity_subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id)
);
CREATE INDEX runtime_checkpoints_subject_time_idx ON runtime.runtime_checkpoints(world_id, activity_subject_id, created_at DESC);

CREATE TABLE runtime.goals (
  goal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  subject_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('SELF','OWNER_DIRECTIVE','CONTRACT_OBLIGATION','SYSTEM_OBLIGATION')),
  goal_text text NOT NULL CHECK (length(goal_text) BETWEEN 1 AND 10000),
  priority integer NOT NULL DEFAULT 0,
  rationale text NULL,
  budget_micro_e bigint NULL CHECK (budget_micro_e IS NULL OR budget_micro_e >= 0),
  deadline timestamptz NULL,
  parent_goal_id uuid NULL,
  success_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACTIVE','PAUSED','BLOCKED','COMPLETED','ABANDONED','FAILED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, goal_id),
  UNIQUE (world_id, subject_id, goal_id),
  FOREIGN KEY (world_id, subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, subject_id, parent_goal_id) REFERENCES runtime.goals(world_id, subject_id, goal_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);
CREATE INDEX goals_subject_status_idx ON runtime.goals(world_id, subject_id, status, created_at);

CREATE TABLE runtime.goal_dependencies (
  world_id text NOT NULL,
  subject_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  depends_on_goal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, goal_id, depends_on_goal_id),
  CHECK (goal_id <> depends_on_goal_id),
  FOREIGN KEY (world_id, subject_id, goal_id) REFERENCES runtime.goals(world_id, subject_id, goal_id),
  FOREIGN KEY (world_id, subject_id, depends_on_goal_id) REFERENCES runtime.goals(world_id, subject_id, goal_id)
);

CREATE OR REPLACE FUNCTION runtime.assert_agent_profile_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text; s text;
BEGIN
  SELECT entity_type, identity_status INTO t, s FROM core.entities WHERE world_id=NEW.world_id AND entity_id=NEW.agent_entity_id;
  IF t IS DISTINCT FROM 'AGENT' OR s IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'runtime profile requires an active AGENT entity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_profiles_entity_guard BEFORE INSERT ON runtime.agent_profiles
  FOR EACH ROW EXECUTE FUNCTION runtime.assert_agent_profile_entity();

CREATE OR REPLACE FUNCTION runtime.assert_manifest_gateway_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; d record;
BEGIN
  SELECT connector_id, descriptor_id, connector_kind, billing_mode, enabled INTO c
    FROM gateway.connector_configs WHERE world_id=NEW.world_id AND connector_id=NEW.gateway_connector_id;
  SELECT descriptor_id, version, provider_protocol, model_reference, assurance_level, verification_status, status INTO d
    FROM gateway.capability_descriptors WHERE world_id=NEW.world_id AND descriptor_id=NEW.gateway_descriptor_id;
  IF c.connector_id IS NULL OR d.descriptor_id IS NULL OR c.descriptor_id <> d.descriptor_id OR NOT c.enabled OR d.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'manifest gateway route is not active or descriptor/connector mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.descriptor_version <> d.version OR NEW.provider_protocol <> d.provider_protocol OR NEW.model_reference <> d.model_reference
     OR NEW.assurance_level <> d.assurance_level OR NEW.verification_status <> d.verification_status
     OR NEW.connector_kind <> c.connector_kind OR NEW.billing_mode <> c.billing_mode THEN
    RAISE EXCEPTION 'manifest snapshot does not match gateway descriptor/connector' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_manifests_gateway_guard BEFORE INSERT ON runtime.model_manifests
  FOR EACH ROW EXECUTE FUNCTION runtime.assert_manifest_gateway_binding();

CREATE OR REPLACE FUNCTION runtime.reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'runtime history is append-only; create a new version/event instead' USING ERRCODE='55000';
END $$;
CREATE TRIGGER model_manifests_append_only BEFORE UPDATE OR DELETE ON runtime.model_manifests FOR EACH ROW EXECUTE FUNCTION runtime.reject_append_only_mutation();
CREATE TRIGGER model_routes_append_only BEFORE UPDATE OR DELETE ON runtime.model_routes FOR EACH ROW EXECUTE FUNCTION runtime.reject_append_only_mutation();
CREATE TRIGGER model_change_events_append_only BEFORE UPDATE OR DELETE ON runtime.model_change_events FOR EACH ROW EXECUTE FUNCTION runtime.reject_append_only_mutation();
CREATE TRIGGER runtime_checkpoints_append_only BEFORE UPDATE OR DELETE ON runtime.runtime_checkpoints FOR EACH ROW EXECUTE FUNCTION runtime.reject_append_only_mutation();
CREATE TRIGGER goal_dependencies_append_only BEFORE UPDATE OR DELETE ON runtime.goal_dependencies FOR EACH ROW EXECUTE FUNCTION runtime.reject_append_only_mutation();
