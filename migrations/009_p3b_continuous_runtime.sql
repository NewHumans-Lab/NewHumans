-- P3-B: continuous M02 runtime control plane while M03 remains deliberately deferred.

ALTER TABLE runtime.lifecycle_states
  ADD COLUMN dormant_reason text NULL,
  ADD COLUMN last_transition_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE runtime.lifecycle_transition_events (
  transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  activity_subject_id uuid NOT NULL,
  from_life_status text NOT NULL CHECK (from_life_status IN ('REGISTERED','ACTIVE','DORMANT','TERMINATED')),
  to_life_status text NOT NULL CHECK (to_life_status IN ('REGISTERED','ACTIVE','DORMANT','TERMINATED')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  billing_date date NULL,
  state_version bigint NOT NULL CHECK (state_version > 0),
  action_id uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, transition_id),
  FOREIGN KEY (world_id, activity_subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, action_id) REFERENCES core.actions(world_id, action_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id),
  CHECK (from_life_status <> to_life_status)
);
CREATE INDEX lifecycle_transition_subject_idx
  ON runtime.lifecycle_transition_events(world_id, activity_subject_id, created_at DESC);

CREATE TABLE runtime.goal_revisions (
  revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  subject_id uuid NOT NULL,
  goal_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  source text NOT NULL,
  goal_text text NOT NULL,
  priority integer NOT NULL,
  rationale text NULL,
  budget_micro_e bigint NULL,
  deadline timestamptz NULL,
  parent_goal_id uuid NULL,
  success_evidence jsonb NOT NULL,
  status text NOT NULL,
  change_reason text NOT NULL CHECK (length(change_reason) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, goal_id, version),
  FOREIGN KEY (world_id, subject_id, goal_id) REFERENCES runtime.goals(world_id, subject_id, goal_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);
CREATE INDEX goal_revisions_goal_idx ON runtime.goal_revisions(world_id, goal_id, version DESC);

INSERT INTO runtime.goal_revisions
  (world_id,subject_id,goal_id,version,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,status,change_reason,created_by,created_at)
SELECT world_id,subject_id,goal_id,version,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,status,
       'P3-B baseline revision',created_by,created_at
  FROM runtime.goals;

CREATE OR REPLACE FUNCTION runtime.capture_goal_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'goal version must advance exactly once' USING ERRCODE='23514';
  END IF;
  INSERT INTO runtime.goal_revisions
    (world_id,subject_id,goal_id,version,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,status,change_reason,created_by)
  VALUES
    (NEW.world_id,NEW.subject_id,NEW.goal_id,NEW.version,NEW.source,NEW.goal_text,NEW.priority,NEW.rationale,NEW.budget_micro_e,NEW.deadline,NEW.parent_goal_id,NEW.success_evidence,NEW.status,
     COALESCE(current_setting('newhumans.goal_change_reason',true),'goal mutation'),
     COALESCE(NULLIF(current_setting('newhumans.goal_changed_by',true),''),'00000000-0000-0000-0000-000000000000')::uuid);
  RETURN NEW;
END $$;

-- Existing goals were backfilled above; new inserts and every update are captured from here on.
CREATE TRIGGER goals_revision_on_insert AFTER INSERT ON runtime.goals
  FOR EACH ROW EXECUTE FUNCTION runtime.capture_goal_revision();
CREATE TRIGGER goals_revision_on_update AFTER UPDATE ON runtime.goals
  FOR EACH ROW EXECUTE FUNCTION runtime.capture_goal_revision();

CREATE OR REPLACE FUNCTION runtime.reject_goal_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'goal revisions are append-only evidence' USING ERRCODE='55000';
END $$;
CREATE TRIGGER goal_revisions_append_only BEFORE UPDATE OR DELETE ON runtime.goal_revisions
  FOR EACH ROW EXECUTE FUNCTION runtime.reject_goal_revision_mutation();

CREATE TABLE runtime.trait_states (
  world_id text NOT NULL,
  subject_id uuid NOT NULL,
  trait_key text NOT NULL CHECK (trait_key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  trait_class text NOT NULL CHECK (trait_class IN ('BIRTH','LEARNED','SHORT_TERM')),
  value_ppm integer NOT NULL CHECK (value_ppm BETWEEN 0 AND 1000000),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, subject_id, trait_key),
  FOREIGN KEY (world_id, subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, updated_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE runtime.trait_updates (
  trait_update_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  subject_id uuid NOT NULL,
  trait_key text NOT NULL,
  trait_class text NOT NULL,
  from_value_ppm integer NULL CHECK (from_value_ppm IS NULL OR from_value_ppm BETWEEN 0 AND 1000000),
  to_value_ppm integer NOT NULL CHECK (to_value_ppm BETWEEN 0 AND 1000000),
  version bigint NOT NULL CHECK (version > 0),
  source text NOT NULL CHECK (source IN ('BIRTH_CONFIGURATION','SELF_REFLECTION','OBSERVED_OUTCOME','SYSTEM_POLICY')),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 4000),
  action_id uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, subject_id, trait_key, version),
  FOREIGN KEY (world_id, subject_id, trait_key) REFERENCES runtime.trait_states(world_id, subject_id, trait_key),
  FOREIGN KEY (world_id, action_id) REFERENCES core.actions(world_id, action_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE OR REPLACE FUNCTION runtime.reject_trait_update_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'trait updates are append-only evidence' USING ERRCODE='55000';
END $$;
CREATE TRIGGER trait_updates_append_only BEFORE UPDATE OR DELETE ON runtime.trait_updates
  FOR EACH ROW EXECUTE FUNCTION runtime.reject_trait_update_mutation();

CREATE TABLE runtime.scheduled_actions (
  scheduled_action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  subject_id uuid NOT NULL,
  action_kind text NOT NULL CHECK (action_kind IN ('WAKE','AUTONOMOUS_TURN')),
  due_at timestamptz NOT NULL,
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
  filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  missed_policy text NOT NULL CHECK (missed_policy IN ('RUN_ONCE','SKIP')),
  latest_run_at timestamptz NULL,
  budget_micro_e bigint NULL CHECK (budget_micro_e IS NULL OR budget_micro_e >= 0),
  priority integer NOT NULL DEFAULT 0,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','CLAIMED','COMPLETED','CANCELLED','MISSED','BLOCKED')),
  claimed_by_worker text NULL,
  claimed_lease_epoch bigint NULL,
  claimed_at timestamptz NULL,
  completed_at timestamptz NULL,
  blocked_reason text NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, subject_id, dedupe_key),
  UNIQUE (world_id, scheduled_action_id),
  FOREIGN KEY (world_id, subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id),
  CHECK (latest_run_at IS NULL OR latest_run_at >= due_at),
  CHECK ((status='CLAIMED' AND claimed_by_worker IS NOT NULL AND claimed_lease_epoch IS NOT NULL AND claimed_at IS NOT NULL)
      OR status<>'CLAIMED')
);
CREATE INDEX scheduled_actions_due_idx
  ON runtime.scheduled_actions(world_id, status, due_at, priority DESC)
  WHERE status='SCHEDULED';

CREATE OR REPLACE FUNCTION runtime.reject_lifecycle_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lifecycle transition history is append-only evidence' USING ERRCODE='55000';
END $$;
CREATE TRIGGER lifecycle_transition_events_append_only BEFORE UPDATE OR DELETE ON runtime.lifecycle_transition_events
  FOR EACH ROW EXECUTE FUNCTION runtime.reject_lifecycle_history_mutation();
