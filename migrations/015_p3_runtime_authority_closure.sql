-- Final P3 runtime authority closure. This migration replaces the live definitions
-- installed by 014; it does not add parallel execution paths.

-- Composite runtime JSON keys such as client_secret, oauthPassword and
-- service-api-key are credential material too. Normalize camelCase to tokens and
-- reject sensitive tokens anywhere in the key hierarchy.
CREATE OR REPLACE FUNCTION runtime.jsonb_contains_secret(node jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
  v jsonb;
  scalar text;
  normalized_key text;
BEGIN
  IF node IS NULL THEN RETURN false; END IF;
  CASE jsonb_typeof(node)
    WHEN 'object' THEN
      FOR k, v IN SELECT key, value FROM jsonb_each(node) LOOP
        normalized_key := lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'));
        IF normalized_key ~ '(^|[_-])(authorization|cookie|secret|password|credential)([_-]|$)'
           OR normalized_key ~ '(^|[_-])(proxy_authorization|set_cookie|x_api_key|api_key|access_token|bearer_token)([_-]|$)'
           OR runtime.jsonb_contains_secret(v) THEN
          RETURN true;
        END IF;
      END LOOP;
    WHEN 'array' THEN
      FOR v IN SELECT value FROM jsonb_array_elements(node) LOOP
        IF runtime.jsonb_contains_secret(v) THEN RETURN true; END IF;
      END LOOP;
    WHEN 'string' THEN
      scalar := node #>> '{}';
      IF scalar ~* '^\s*(bearer|basic)\s+\S+' THEN RETURN true; END IF;
    ELSE
      NULL;
  END CASE;
  RETURN false;
END $$;

ALTER TABLE runtime.model_manifests
  DROP CONSTRAINT IF EXISTS model_manifests_sampling_no_secret_check,
  ADD CONSTRAINT model_manifests_sampling_no_secret_check
    CHECK (NOT runtime.jsonb_contains_secret(sampling_settings));
ALTER TABLE runtime.model_routes
  ADD CONSTRAINT model_routes_policy_no_secret_check
    CHECK (NOT runtime.jsonb_contains_secret(route_policy));

-- Route provenance may only claim SYSTEM_RUNTIME_CONTROL when the immutable creator
-- is in fact an ACTIVE SYSTEM in the same world. Manifest ownership remains the
-- existing composite FK's responsibility.
CREATE OR REPLACE FUNCTION runtime.normalize_route_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m runtime.model_manifests%ROWTYPE;
  authority record;
BEGIN
  IF runtime.jsonb_contains_secret(COALESCE(NEW.route_policy, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'route policy must not contain secret or credential material' USING ERRCODE='23514';
  END IF;
  SELECT entity_type,identity_status INTO authority
    FROM core.entities
   WHERE world_id=NEW.world_id AND entity_id=NEW.created_by;
  IF authority.entity_type IS DISTINCT FROM 'SYSTEM'
     OR authority.identity_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'runtime model route requires ACTIVE SYSTEM authorization' USING ERRCODE='23514';
  END IF;
  SELECT * INTO m FROM runtime.model_manifests
   WHERE world_id=NEW.world_id AND manifest_id=NEW.manifest_id;
  IF m.manifest_id IS NULL THEN
    RAISE EXCEPTION 'route manifest is not available for policy provenance' USING ERRCODE='23514';
  END IF;
  NEW.route_policy := COALESCE(NEW.route_policy, '{}'::jsonb) || jsonb_build_object(
    'authorization', jsonb_build_object(
      'kind', 'SYSTEM_RUNTIME_CONTROL',
      'policy_version', 'nh.v3.0:p3-runtime-route-policy',
      'authorized_by', NEW.created_by,
      'provenance_basis', 'AUTHORITATIVE_PUBLISH'
    ),
    'provider_scope', jsonb_build_object(
      'descriptor_id', m.gateway_descriptor_id,
      'connector_id', m.gateway_connector_id,
      'provider_protocol', m.provider_protocol,
      'billing_mode', m.billing_mode
    ),
    'data_scope', jsonb_build_object('m03_context', 'DEFERRED_BY_OWNER'),
    'required_capabilities', jsonb_build_array('MODEL_INFERENCE'),
    'fallback', jsonb_build_object('enabled', false)
  );
  RETURN NEW;
END $$;

-- Checkpoint goal references must carry a concrete positive version; JSON null is
-- not an authority value. Replace the 014 function in place.
CREATE OR REPLACE FUNCTION runtime.populate_checkpoint_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_route uuid;
  route_manifest uuid;
  ref jsonb;
  g record;
  version_text text;
  goal_text text;
BEGIN
  IF jsonb_typeof(COALESCE(NEW.pending_actions,'[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'checkpoint pending_actions must be an array' USING ERRCODE='23514';
  END IF;
  IF NEW.goal_refs IS NULL OR NEW.goal_refs = '[]'::jsonb THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('goal_id',goal_id,'version',version) ORDER BY created_at,goal_id),'[]'::jsonb)
      INTO NEW.goal_refs
      FROM runtime.goals
     WHERE world_id=NEW.world_id AND subject_id=NEW.activity_subject_id
       AND status NOT IN ('COMPLETED','ABANDONED','FAILED');
  ELSE
    IF jsonb_typeof(NEW.goal_refs) <> 'array' THEN
      RAISE EXCEPTION 'checkpoint goal_refs must be an array' USING ERRCODE='23514';
    END IF;
    FOR ref IN SELECT value FROM jsonb_array_elements(NEW.goal_refs) LOOP
      IF jsonb_typeof(ref) <> 'object'
         OR NOT (ref ? 'goal_id' AND ref ? 'version')
         OR ref->'goal_id' = 'null'::jsonb
         OR ref->'version' = 'null'::jsonb THEN
        RAISE EXCEPTION 'checkpoint goal reference requires non-null goal_id and version' USING ERRCODE='23514';
      END IF;
      goal_text := ref->>'goal_id';
      version_text := ref->>'version';
      IF goal_text IS NULL
         OR goal_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR version_text IS NULL
         OR version_text !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'checkpoint goal reference has invalid goal_id or version' USING ERRCODE='23514';
      END IF;
      SELECT goal_id,version INTO g
        FROM runtime.goals
       WHERE world_id=NEW.world_id AND subject_id=NEW.activity_subject_id
         AND goal_id=goal_text::uuid;
      IF g.goal_id IS NULL OR g.version <> version_text::bigint THEN
        RAISE EXCEPTION 'checkpoint goal reference is not the current authoritative version' USING ERRCODE='23514';
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(NEW.goal_refs)) <>
       (SELECT count(DISTINCT value->>'goal_id') FROM jsonb_array_elements(NEW.goal_refs)) THEN
      RAISE EXCEPTION 'checkpoint goal_refs must not contain duplicates' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT current_route_id INTO current_route
    FROM runtime.agent_profiles
   WHERE world_id=NEW.world_id AND agent_entity_id=NEW.activity_subject_id;
  IF current_route IS NULL THEN
    IF jsonb_array_length(NEW.pending_actions) <> 0 THEN
      RAISE EXCEPTION 'checkpoint with pending actions requires a current model route' USING ERRCODE='23514';
    END IF;
    NEW.route_id := NULL;
    NEW.manifest_id := NULL;
    NEW.recovery_authority_status := 'AUTHORITATIVE_PRE_ROUTE';
    RETURN NEW;
  END IF;

  SELECT manifest_id INTO route_manifest
    FROM runtime.model_routes
   WHERE world_id=NEW.world_id AND agent_entity_id=NEW.activity_subject_id AND route_id=current_route;
  IF route_manifest IS NULL THEN
    RAISE EXCEPTION 'checkpoint current route is not authoritative for subject' USING ERRCODE='23514';
  END IF;
  IF NEW.route_id IS NOT NULL AND NEW.route_id <> current_route THEN
    RAISE EXCEPTION 'checkpoint route reference is stale' USING ERRCODE='23514';
  END IF;
  IF NEW.manifest_id IS NOT NULL AND NEW.manifest_id <> route_manifest THEN
    RAISE EXCEPTION 'checkpoint manifest reference does not match route' USING ERRCODE='23514';
  END IF;
  NEW.route_id := current_route;
  NEW.manifest_id := route_manifest;
  NEW.recovery_authority_status := 'AUTHORITATIVE';
  RETURN NEW;
END $$;

-- One fail-closed model-loss transition is shared by connector and descriptor
-- invalidation. ACTIVE Agents become DORMANT; already-dormant reasons are preserved.
CREATE OR REPLACE FUNCTION runtime.force_model_unavailable(p_world_id text, p_subject_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  prior runtime.lifecycle_states%ROWTYPE;
  updated runtime.lifecycle_states%ROWTYPE;
  recorder uuid;
  next_flags text[];
BEGIN
  SELECT s.* INTO prior
    FROM runtime.lifecycle_states s
   WHERE s.world_id=p_world_id AND s.activity_subject_id=p_subject_id
   FOR UPDATE;
  IF prior.activity_subject_id IS NULL THEN RETURN; END IF;
  SELECT created_by INTO recorder
    FROM runtime.agent_profiles
   WHERE world_id=p_world_id AND agent_entity_id=p_subject_id;
  next_flags := CASE WHEN 'NO_MODEL_ROUTE'=ANY(prior.restriction_flags)
                     THEN prior.restriction_flags ELSE array_append(prior.restriction_flags,'NO_MODEL_ROUTE') END;
  UPDATE runtime.lifecycle_states
     SET model_status='TEMPORARILY_UNAVAILABLE',
         life_status=CASE WHEN prior.life_status='ACTIVE' THEN 'DORMANT' ELSE prior.life_status END,
         execution_status='BLOCKED',
         restriction_flags=next_flags,
         dormant_reason=CASE WHEN prior.life_status='ACTIVE' THEN 'MODEL_UNAVAILABLE' ELSE prior.dormant_reason END,
         state_version=state_version+1,
         last_transition_at=CASE WHEN prior.life_status='ACTIVE' THEN now() ELSE last_transition_at END,
         updated_at=now()
   WHERE world_id=p_world_id AND activity_subject_id=p_subject_id
   RETURNING * INTO updated;
  IF prior.life_status='ACTIVE' THEN
    INSERT INTO runtime.lifecycle_transition_events
      (world_id,activity_subject_id,from_life_status,to_life_status,reason,state_version,created_by)
    VALUES
      (p_world_id,p_subject_id,'ACTIVE','DORMANT',p_reason,updated.state_version,recorder);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION runtime.invalidate_connector_routes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rec record;
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    FOR rec IN
      SELECT DISTINCT p.world_id,p.agent_entity_id
        FROM runtime.agent_profiles p
        JOIN runtime.model_routes r ON r.world_id=p.world_id AND r.agent_entity_id=p.agent_entity_id AND r.route_id=p.current_route_id
        JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id
       WHERE m.gateway_connector_id=NEW.connector_id
    LOOP
      PERFORM runtime.force_model_unavailable(rec.world_id,rec.agent_entity_id,'current model connector became unavailable');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION runtime.invalidate_descriptor_routes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rec record;
BEGIN
  IF OLD.status='ACTIVE' AND NEW.status<>'ACTIVE' THEN
    FOR rec IN
      SELECT DISTINCT p.world_id,p.agent_entity_id
        FROM runtime.agent_profiles p
        JOIN runtime.model_routes r ON r.world_id=p.world_id AND r.agent_entity_id=p.agent_entity_id AND r.route_id=p.current_route_id
        JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id
       WHERE m.gateway_descriptor_id=NEW.descriptor_id
    LOOP
      PERFORM runtime.force_model_unavailable(rec.world_id,rec.agent_entity_id,'current model descriptor became unavailable');
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- A lease epoch is a fencing token, not a mutable label. Same-epoch updates cannot
-- change ownership/acquisition identity; takeover is exactly +1 and only after the
-- previous lease is released or expired according to the database clock.
CREATE OR REPLACE FUNCTION runtime.guard_runtime_lease_takeover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lease_epoch < OLD.lease_epoch THEN
    RAISE EXCEPTION 'runtime lease epoch cannot move backwards' USING ERRCODE='23514';
  END IF;
  IF NEW.lease_epoch = OLD.lease_epoch THEN
    IF NEW.worker_id IS DISTINCT FROM OLD.worker_id
       OR NEW.acquired_at IS DISTINCT FROM OLD.acquired_at THEN
      RAISE EXCEPTION 'same-epoch runtime lease ownership is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lease_epoch <> OLD.lease_epoch + 1 THEN
    RAISE EXCEPTION 'runtime lease takeover must advance exactly one epoch' USING ERRCODE='23514';
  END IF;
  IF OLD.released_at IS NULL AND OLD.expires_at > now() THEN
    RAISE EXCEPTION 'runtime lease is still active according to database clock' USING ERRCODE='23514';
  END IF;
  IF NEW.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'new runtime lease epoch must begin active' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- M01 identity invalidation is authoritative immediately. Do not leave an ACTIVE
-- runtime accruing fees after its Entity becomes SUSPENDED or RETIRED, and never
-- auto-reactivate if identity later returns ACTIVE.
CREATE OR REPLACE FUNCTION runtime.invalidate_runtime_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior runtime.lifecycle_states%ROWTYPE;
  updated runtime.lifecycle_states%ROWTYPE;
  recorder uuid;
BEGIN
  IF OLD.identity_status='ACTIVE' AND NEW.identity_status<>'ACTIVE' THEN
    SELECT s.* INTO prior
      FROM runtime.lifecycle_states s
     WHERE s.world_id=NEW.world_id AND s.activity_subject_id=NEW.entity_id
     FOR UPDATE;
    IF prior.activity_subject_id IS NOT NULL AND prior.life_status='ACTIVE' THEN
      SELECT created_by INTO recorder FROM runtime.agent_profiles
       WHERE world_id=NEW.world_id AND agent_entity_id=NEW.entity_id;
      UPDATE runtime.lifecycle_states
         SET life_status='DORMANT',execution_status='BLOCKED',dormant_reason='IDENTITY_INACTIVE',
             state_version=state_version+1,last_transition_at=now(),updated_at=now()
       WHERE world_id=NEW.world_id AND activity_subject_id=NEW.entity_id
       RETURNING * INTO updated;
      INSERT INTO runtime.lifecycle_transition_events
        (world_id,activity_subject_id,from_life_status,to_life_status,reason,state_version,created_by)
      VALUES
        (NEW.world_id,NEW.entity_id,'ACTIVE','DORMANT','M01 identity became '||NEW.identity_status,updated.state_version,recorder);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS entities_runtime_identity_invalidate ON core.entities;
CREATE TRIGGER entities_runtime_identity_invalidate
  AFTER UPDATE OF identity_status ON core.entities
  FOR EACH ROW EXECUTE FUNCTION runtime.invalidate_runtime_identity();

-- WAKE has one executable path. The scheduler records append-only execution evidence
-- after lifecycle/economic work and before consuming the schedule row.
CREATE TABLE runtime.scheduled_wake_executions (
  wake_execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  scheduled_action_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('COMPLETED','BLOCKED','MISSED')),
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 200),
  billing_date date NULL,
  lifecycle_state_version bigint NULL CHECK (lifecycle_state_version IS NULL OR lifecycle_state_version > 0),
  blocked_reason text NULL,
  action_id uuid NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, scheduled_action_id),
  UNIQUE (world_id, wake_execution_id),
  FOREIGN KEY (world_id, scheduled_action_id) REFERENCES runtime.scheduled_actions(world_id, scheduled_action_id),
  FOREIGN KEY (world_id, subject_id) REFERENCES runtime.agent_profiles(world_id, agent_entity_id),
  FOREIGN KEY (world_id, action_id) REFERENCES core.actions(world_id, action_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id),
  CHECK ((outcome='COMPLETED' AND billing_date IS NOT NULL AND lifecycle_state_version IS NOT NULL AND blocked_reason IS NULL)
      OR (outcome='BLOCKED' AND blocked_reason IS NOT NULL)
      OR (outcome='MISSED'))
);

CREATE OR REPLACE FUNCTION runtime.validate_wake_execution_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  schedule record;
  authority record;
  life record;
BEGIN
  SELECT action_kind,status,subject_id,due_at INTO schedule
    FROM runtime.scheduled_actions
   WHERE world_id=NEW.world_id AND scheduled_action_id=NEW.scheduled_action_id
   FOR UPDATE;
  IF schedule.action_kind IS DISTINCT FROM 'WAKE'
     OR schedule.status IS DISTINCT FROM 'SCHEDULED'
     OR schedule.subject_id IS DISTINCT FROM NEW.subject_id THEN
    RAISE EXCEPTION 'wake execution evidence requires the matching SCHEDULED WAKE action' USING ERRCODE='23514';
  END IF;
  SELECT entity_type,identity_status INTO authority
    FROM core.entities WHERE world_id=NEW.world_id AND entity_id=NEW.created_by;
  IF authority.entity_type IS DISTINCT FROM 'SYSTEM' OR authority.identity_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'wake execution evidence requires ACTIVE SYSTEM authority' USING ERRCODE='23514';
  END IF;
  IF NEW.outcome='COMPLETED' THEN
    SELECT life_status,state_version INTO life
      FROM runtime.lifecycle_states WHERE world_id=NEW.world_id AND activity_subject_id=NEW.subject_id;
    IF life.life_status IS DISTINCT FROM 'ACTIVE'
       OR life.state_version IS DISTINCT FROM NEW.lifecycle_state_version
       OR NOT EXISTS (
         SELECT 1 FROM economy.activity_fees
          WHERE world_id=NEW.world_id AND activity_subject_id=NEW.subject_id
            AND billing_date=NEW.billing_date AND status='CHARGED'
       ) THEN
      RAISE EXCEPTION 'completed wake evidence requires the activated lifecycle and charged fee evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_wake_execution_validate
  BEFORE INSERT ON runtime.scheduled_wake_executions
  FOR EACH ROW EXECUTE FUNCTION runtime.validate_wake_execution_evidence();

CREATE OR REPLACE FUNCTION runtime.reject_wake_execution_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'scheduled wake execution evidence is append-only' USING ERRCODE='55000';
END $$;
CREATE TRIGGER scheduled_wake_executions_append_only
  BEFORE UPDATE OR DELETE ON runtime.scheduled_wake_executions
  FOR EACH ROW EXECUTE FUNCTION runtime.reject_wake_execution_mutation();

CREATE OR REPLACE FUNCTION runtime.assert_current_claim_lease(
  p_world_id text,p_subject_id uuid,p_worker_id text,p_lease_epoch bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE l record;
BEGIN
  SELECT worker_id,lease_epoch,(released_at IS NULL AND expires_at > now()) active INTO l
    FROM runtime.runtime_leases
   WHERE world_id=p_world_id AND activity_subject_id=p_subject_id;
  IF l.active IS DISTINCT FROM true
     OR l.worker_id IS DISTINCT FROM p_worker_id
     OR l.lease_epoch IS DISTINCT FROM p_lease_epoch THEN
    RAISE EXCEPTION 'scheduled claim requires the current active runtime lease' USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION runtime.assert_current_autonomous_eligibility(
  p_world_id text,p_subject_id uuid,p_worker_id text,p_lease_epoch bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  ident text;
  life record;
  route_ok boolean;
  fee_ok boolean;
  available bigint;
BEGIN
  PERFORM runtime.assert_current_claim_lease(p_world_id,p_subject_id,p_worker_id,p_lease_epoch);
  SELECT identity_status INTO ident FROM core.entities
   WHERE world_id=p_world_id AND entity_id=p_subject_id;
  SELECT life_status,execution_status,model_status,restriction_flags INTO life
    FROM runtime.lifecycle_states WHERE world_id=p_world_id AND activity_subject_id=p_subject_id;
  SELECT EXISTS(
    SELECT 1 FROM runtime.agent_profiles p
    JOIN runtime.model_routes r ON r.world_id=p.world_id AND r.agent_entity_id=p.agent_entity_id AND r.route_id=p.current_route_id
    JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id
    JOIN gateway.capability_descriptors d ON d.world_id=m.world_id AND d.descriptor_id=m.gateway_descriptor_id AND d.status='ACTIVE'
    JOIN gateway.connector_configs c ON c.world_id=m.world_id AND c.connector_id=m.gateway_connector_id AND c.descriptor_id=m.gateway_descriptor_id AND c.enabled=true
    WHERE p.world_id=p_world_id AND p.agent_entity_id=p_subject_id
  ) INTO route_ok;
  SELECT EXISTS(SELECT 1 FROM economy.activity_fees
    WHERE world_id=p_world_id AND activity_subject_id=p_subject_id
      AND billing_date=(now() AT TIME ZONE 'UTC')::date AND status='CHARGED') INTO fee_ok;
  SELECT available_micro_e INTO available FROM economy.wallet_balances
    WHERE world_id=p_world_id AND entity_id=p_subject_id;
  IF ident IS DISTINCT FROM 'ACTIVE'
     OR life.life_status IS DISTINCT FROM 'ACTIVE'
     OR life.execution_status NOT IN ('IDLE','RUNNABLE')
     OR life.model_status IS DISTINCT FROM 'AVAILABLE'
     OR NOT route_ok OR NOT fee_ok OR COALESCE(available,0) <= 0
     OR 'M03_CONTEXT_UNAVAILABLE'=ANY(COALESCE(life.restriction_flags,'{}'::text[]))
     OR 'NO_MODEL_ROUTE'=ANY(COALESCE(life.restriction_flags,'{}'::text[]))
     OR 'OWNER_PAUSE'=ANY(COALESCE(life.restriction_flags,'{}'::text[]))
     OR 'NO_BUDGET'=ANY(COALESCE(life.restriction_flags,'{}'::text[]))
     OR 'QUARANTINE'=ANY(COALESCE(life.restriction_flags,'{}'::text[]))
     OR 'WORLD_SUSPENSION'=ANY(COALESCE(life.restriction_flags,'{}'::text[])) THEN
    RAISE EXCEPTION 'autonomous claim requires current authoritative runtime eligibility' USING ERRCODE='23514';
  END IF;
END $$;

-- Replace the 014 schedule guard. Every executable transition has one authority:
-- WAKE terminal states require scheduler evidence; autonomous claims require current
-- lease/eligibility; takeover and terminal completion are lease fenced.
CREATE OR REPLACE FUNCTION runtime.guard_scheduled_action_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wake_outcome text;
BEGIN
  IF OLD.scheduled_action_id IS DISTINCT FROM NEW.scheduled_action_id
     OR OLD.world_id IS DISTINCT FROM NEW.world_id
     OR OLD.subject_id IS DISTINCT FROM NEW.subject_id
     OR OLD.action_kind IS DISTINCT FROM NEW.action_kind
     OR OLD.due_at IS DISTINCT FROM NEW.due_at
     OR OLD.timezone IS DISTINCT FROM NEW.timezone
     OR OLD.filter_json IS DISTINCT FROM NEW.filter_json
     OR OLD.missed_policy IS DISTINCT FROM NEW.missed_policy
     OR OLD.latest_run_at IS DISTINCT FROM NEW.latest_run_at
     OR OLD.budget_micro_e IS DISTINCT FROM NEW.budget_micro_e
     OR OLD.priority IS DISTINCT FROM NEW.priority
     OR OLD.dedupe_key IS DISTINCT FROM NEW.dedupe_key
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'scheduled action terms are immutable; cancel and create a new schedule' USING ERRCODE='55000';
  END IF;

  IF OLD.status=NEW.status THEN
    IF OLD.status='CLAIMED' AND (
      NEW.claimed_by_worker IS DISTINCT FROM OLD.claimed_by_worker
      OR NEW.claimed_lease_epoch IS DISTINCT FROM OLD.claimed_lease_epoch
    ) THEN
      IF OLD.action_kind<>'AUTONOMOUS_TURN'
         OR NEW.claimed_lease_epoch IS NULL
         OR OLD.claimed_lease_epoch IS NULL
         OR NEW.claimed_lease_epoch <= OLD.claimed_lease_epoch THEN
        RAISE EXCEPTION 'claim takeover requires a strictly newer autonomous lease epoch' USING ERRCODE='23514';
      END IF;
      PERFORM runtime.assert_current_autonomous_eligibility(
        NEW.world_id,NEW.subject_id,NEW.claimed_by_worker,NEW.claimed_lease_epoch);
      RETURN NEW;
    END IF;
    IF NEW.claimed_by_worker IS DISTINCT FROM OLD.claimed_by_worker
       OR NEW.claimed_lease_epoch IS DISTINCT FROM OLD.claimed_lease_epoch
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
      RAISE EXCEPTION 'claim ownership may change only through fenced takeover' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status='SCHEDULED' AND NEW.status='CANCELLED' THEN RETURN NEW; END IF;

  IF OLD.status='SCHEDULED' AND NEW.status IN ('COMPLETED','BLOCKED','MISSED') AND OLD.action_kind='WAKE' THEN
    wake_outcome := NEW.status;
    IF NOT EXISTS (
      SELECT 1 FROM runtime.scheduled_wake_executions e
       WHERE e.world_id=NEW.world_id
         AND e.scheduled_action_id=NEW.scheduled_action_id
         AND e.subject_id=NEW.subject_id
         AND e.outcome=wake_outcome
         AND e.worker_id=NEW.claimed_by_worker
    ) THEN
      RAISE EXCEPTION 'WAKE terminal transition requires authoritative scheduler execution evidence' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status='SCHEDULED' AND NEW.status IN ('BLOCKED','MISSED') THEN
    -- Non-WAKE schedules may be blocked/missed before claim by their canonical scheduler path.
    RETURN NEW;
  END IF;

  IF OLD.status='SCHEDULED' AND NEW.status='COMPLETED' THEN
    RAISE EXCEPTION 'AUTONOMOUS_TURN must be claimed before completion' USING ERRCODE='23514';
  END IF;

  IF OLD.status='SCHEDULED' AND NEW.status='CLAIMED' THEN
    IF OLD.action_kind<>'AUTONOMOUS_TURN' THEN
      RAISE EXCEPTION 'WAKE must use the atomic wake path' USING ERRCODE='23514';
    END IF;
    PERFORM runtime.assert_current_autonomous_eligibility(
      NEW.world_id,NEW.subject_id,NEW.claimed_by_worker,NEW.claimed_lease_epoch);
    RETURN NEW;
  END IF;

  IF OLD.status='CLAIMED' AND NEW.status IN ('COMPLETED','BLOCKED') THEN
    IF OLD.action_kind<>'AUTONOMOUS_TURN'
       OR NEW.claimed_by_worker IS DISTINCT FROM OLD.claimed_by_worker
       OR NEW.claimed_lease_epoch IS DISTINCT FROM OLD.claimed_lease_epoch THEN
      RAISE EXCEPTION 'terminal claim transition cannot change claim ownership' USING ERRCODE='23514';
    END IF;
    PERFORM runtime.assert_current_claim_lease(
      NEW.world_id,NEW.subject_id,OLD.claimed_by_worker,OLD.claimed_lease_epoch);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid scheduled action status transition % -> %', OLD.status, NEW.status USING ERRCODE='23514';
END $$;