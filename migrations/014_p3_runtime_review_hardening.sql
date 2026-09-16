-- P3 review hardening: close every still-valid P3-A/P3-B review gap at the
-- PostgreSQL authority layer. Service code mirrors these rules, but direct SQL
-- must not be able to recreate the superseded paths.

-- Ordinary Agents own their own memory subject. HPA sharing will be introduced
-- only by its separate authoritative binding model; it must not be emulated here.
ALTER TABLE runtime.agent_profiles
  ADD CONSTRAINT agent_profiles_ordinary_memory_self_check
  CHECK (memory_subject_id = agent_entity_id);

-- Credential rotation is versioned replacement, not in-place identity mutation.
-- Keep old immutable connector rows as evidence, disable them, then create one new
-- enabled row for the same descriptor/kind/endpoint with the new credential ref.
ALTER TABLE gateway.connector_configs
  DROP CONSTRAINT IF EXISTS connector_configs_world_id_descriptor_id_connector_kind_base_url_key;
CREATE UNIQUE INDEX connector_configs_one_enabled_endpoint_idx
  ON gateway.connector_configs(world_id, descriptor_id, connector_kind, base_url)
  WHERE enabled;

-- Runtime JSON must never become a credential store. This recursive predicate is
-- also used by route-policy normalization so direct database writers cannot bypass it.
CREATE OR REPLACE FUNCTION runtime.jsonb_contains_secret(node jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
  v jsonb;
  scalar text;
BEGIN
  IF node IS NULL THEN RETURN false; END IF;
  CASE jsonb_typeof(node)
    WHEN 'object' THEN
      FOR k, v IN SELECT key, value FROM jsonb_each(node) LOOP
        IF k ~* '^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|secret|password|credential|access[-_]?token|bearer[-_]?token)$'
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
  ADD CONSTRAINT model_manifests_sampling_no_secret_check
  CHECK (NOT runtime.jsonb_contains_secret(sampling_settings));

-- Every route must carry machine-verifiable authorization/provider/data/fallback
-- provenance. Existing rows are deterministically enriched from immutable route,
-- manifest and creator evidence; this is metadata backfill, not a second route path.
ALTER TABLE runtime.model_routes DISABLE TRIGGER model_routes_append_only;
UPDATE runtime.model_routes r
   SET route_policy = COALESCE(r.route_policy, '{}'::jsonb) || jsonb_build_object(
     'authorization', jsonb_build_object(
       'kind', 'SYSTEM_RUNTIME_CONTROL',
       'policy_version', 'nh.v3.0:p3-runtime-route-policy',
       'authorized_by', r.created_by,
       'provenance_basis', 'DERIVED_FROM_IMMUTABLE_ROUTE_EVIDENCE'
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
   )
  FROM runtime.model_manifests m
 WHERE m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id;
ALTER TABLE runtime.model_routes ENABLE TRIGGER model_routes_append_only;

CREATE OR REPLACE FUNCTION runtime.normalize_route_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m runtime.model_manifests%ROWTYPE;
BEGIN
  IF runtime.jsonb_contains_secret(COALESCE(NEW.route_policy, '{}'::jsonb)) THEN
    RAISE EXCEPTION 'route policy must not contain secret or credential material' USING ERRCODE='23514';
  END IF;
  SELECT * INTO m FROM runtime.model_manifests
   WHERE world_id=NEW.world_id AND agent_entity_id=NEW.agent_entity_id AND manifest_id=NEW.manifest_id;
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
DROP TRIGGER IF EXISTS model_routes_policy_guard ON runtime.model_routes;
CREATE TRIGGER model_routes_policy_guard
  BEFORE INSERT ON runtime.model_routes
  FOR EACH ROW EXECUTE FUNCTION runtime.normalize_route_policy();

-- Checkpoints must identify the immutable model route/manifest and exact goal
-- versions that produced recoverable work. Existing historical rows are explicitly
-- LEGACY_UNSCOPED. A pre-route checkpoint may exist only with no pending external
-- actions and is marked AUTHORITATIVE_PRE_ROUTE; once a route exists the immutable
-- route/manifest/goal snapshot is mandatory and marked AUTHORITATIVE.
ALTER TABLE runtime.runtime_checkpoints
  ADD COLUMN route_id uuid NULL,
  ADD COLUMN manifest_id uuid NULL,
  ADD COLUMN goal_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN recovery_authority_status text NOT NULL DEFAULT 'LEGACY_UNSCOPED'
    CHECK (recovery_authority_status IN ('LEGACY_UNSCOPED','AUTHORITATIVE_PRE_ROUTE','AUTHORITATIVE')),
  ADD CONSTRAINT runtime_checkpoints_route_same_agent_fkey
    FOREIGN KEY (world_id, activity_subject_id, route_id)
    REFERENCES runtime.model_routes(world_id, agent_entity_id, route_id),
  ADD CONSTRAINT runtime_checkpoints_manifest_same_agent_fkey
    FOREIGN KEY (world_id, activity_subject_id, manifest_id)
    REFERENCES runtime.model_manifests(world_id, agent_entity_id, manifest_id);

CREATE OR REPLACE FUNCTION runtime.populate_checkpoint_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_route uuid;
  route_manifest uuid;
  ref jsonb;
  g record;
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
      IF NOT (ref ? 'goal_id' AND ref ? 'version') THEN
        RAISE EXCEPTION 'checkpoint goal reference requires goal_id and version' USING ERRCODE='23514';
      END IF;
      SELECT goal_id,version INTO g
        FROM runtime.goals
       WHERE world_id=NEW.world_id AND subject_id=NEW.activity_subject_id
         AND goal_id=(ref->>'goal_id')::uuid;
      IF g.goal_id IS NULL OR g.version <> (ref->>'version')::bigint THEN
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
DROP TRIGGER IF EXISTS runtime_checkpoints_authority_refs ON runtime.runtime_checkpoints;
CREATE TRIGGER runtime_checkpoints_authority_refs
  BEFORE INSERT ON runtime.runtime_checkpoints
  FOR EACH ROW EXECUTE FUNCTION runtime.populate_checkpoint_authority();

-- A connector/descriptor becoming unavailable must fail closed in M02 immediately.
-- Re-enable never auto-clears the runtime restriction; explicit route/model recovery is required.
CREATE OR REPLACE FUNCTION runtime.invalidate_connector_routes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    UPDATE runtime.lifecycle_states s
       SET model_status='TEMPORARILY_UNAVAILABLE',
           execution_status='BLOCKED',
           restriction_flags=CASE WHEN 'NO_MODEL_ROUTE'=ANY(s.restriction_flags) THEN s.restriction_flags ELSE array_append(s.restriction_flags,'NO_MODEL_ROUTE') END,
           state_version=s.state_version+1,
           updated_at=now()
      FROM runtime.agent_profiles p
      JOIN runtime.model_routes r ON r.world_id=p.world_id AND r.agent_entity_id=p.agent_entity_id AND r.route_id=p.current_route_id
      JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id
     WHERE s.world_id=p.world_id AND s.activity_subject_id=p.agent_entity_id
       AND m.gateway_connector_id=NEW.connector_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS connector_configs_runtime_invalidate ON gateway.connector_configs;
CREATE TRIGGER connector_configs_runtime_invalidate
  AFTER UPDATE OF enabled ON gateway.connector_configs
  FOR EACH ROW EXECUTE FUNCTION runtime.invalidate_connector_routes();

CREATE OR REPLACE FUNCTION runtime.invalidate_descriptor_routes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='ACTIVE' AND NEW.status<>'ACTIVE' THEN
    UPDATE runtime.lifecycle_states s
       SET model_status='TEMPORARILY_UNAVAILABLE',
           execution_status='BLOCKED',
           restriction_flags=CASE WHEN 'NO_MODEL_ROUTE'=ANY(s.restriction_flags) THEN s.restriction_flags ELSE array_append(s.restriction_flags,'NO_MODEL_ROUTE') END,
           state_version=s.state_version+1,
           updated_at=now()
      FROM runtime.agent_profiles p
      JOIN runtime.model_routes r ON r.world_id=p.world_id AND r.agent_entity_id=p.agent_entity_id AND r.route_id=p.current_route_id
      JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id
     WHERE s.world_id=p.world_id AND s.activity_subject_id=p.agent_entity_id
       AND m.gateway_descriptor_id=NEW.descriptor_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capability_descriptors_runtime_invalidate ON gateway.capability_descriptors;
CREATE TRIGGER capability_descriptors_runtime_invalidate
  AFTER UPDATE OF status ON gateway.capability_descriptors
  FOR EACH ROW EXECUTE FUNCTION runtime.invalidate_descriptor_routes();

-- The database clock is the lease authority. A host whose clock is ahead cannot
-- steal a still-live lease through the existing UPSERT path.
CREATE OR REPLACE FUNCTION runtime.guard_runtime_lease_takeover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lease_epoch > OLD.lease_epoch
     AND OLD.released_at IS NULL
     AND OLD.expires_at > now() THEN
    RAISE EXCEPTION 'runtime lease is still active according to database clock' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_leases_takeover_guard ON runtime.runtime_leases;
CREATE TRIGGER runtime_leases_takeover_guard
  BEFORE UPDATE ON runtime.runtime_leases
  FOR EACH ROW EXECUTE FUNCTION runtime.guard_runtime_lease_takeover();

-- ACTIVE runtime identity is impossible for a suspended/retired M01 Entity even
-- through direct SQL. Service activation mirrors this before any fee mutation.
CREATE OR REPLACE FUNCTION runtime.guard_active_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  IF NEW.life_status <> 'ACTIVE' THEN RETURN NEW; END IF;
  SELECT identity_status INTO s FROM core.entities
   WHERE world_id=NEW.world_id AND entity_id=NEW.activity_subject_id;
  IF s IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTIVE runtime requires ACTIVE M01 identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lifecycle_active_identity_guard ON runtime.lifecycle_states;
CREATE TRIGGER lifecycle_active_identity_guard
  BEFORE INSERT OR UPDATE ON runtime.lifecycle_states
  FOR EACH ROW EXECUTE FUNCTION runtime.guard_active_identity();

-- Preserve an existing non-model dormancy reason when model metadata changes while
-- the runtime is already dormant. MODEL_UNAVAILABLE is only authoritative when the
-- outage itself caused ACTIVE -> DORMANT.
CREATE OR REPLACE FUNCTION runtime.preserve_dormancy_reason_on_model_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.life_status='DORMANT' AND NEW.life_status='DORMANT'
     AND OLD.model_status IS DISTINCT FROM NEW.model_status THEN
    NEW.dormant_reason := OLD.dormant_reason;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lifecycle_preserve_dormancy_reason ON runtime.lifecycle_states;
CREATE TRIGGER lifecycle_preserve_dormancy_reason
  BEFORE UPDATE OF model_status ON runtime.lifecycle_states
  FOR EACH ROW EXECUTE FUNCTION runtime.preserve_dormancy_reason_on_model_change();

-- Replace the permissive schedule transition guard. WAKE alone may complete
-- atomically from SCHEDULED. AUTONOMOUS_TURN must first be a valid current-lease claim.
CREATE OR REPLACE FUNCTION runtime.guard_scheduled_action_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active_lease record;
  ident text;
  life record;
  route_ok boolean;
  fee_ok boolean;
  available bigint;
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

  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF OLD.status='SCHEDULED' AND NEW.status IN ('CANCELLED','MISSED','BLOCKED') THEN RETURN NEW; END IF;
  IF OLD.status='SCHEDULED' AND NEW.status='COMPLETED' THEN
    IF OLD.action_kind <> 'WAKE' THEN
      RAISE EXCEPTION 'AUTONOMOUS_TURN must be claimed before completion' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='SCHEDULED' AND NEW.status='CLAIMED' THEN
    IF OLD.action_kind <> 'AUTONOMOUS_TURN' THEN
      RAISE EXCEPTION 'WAKE must use the atomic wake path' USING ERRCODE='23514';
    END IF;
    SELECT worker_id,lease_epoch,(released_at IS NULL AND expires_at > now()) active
      INTO active_lease FROM runtime.runtime_leases
     WHERE world_id=NEW.world_id AND activity_subject_id=NEW.subject_id;
    IF active_lease.active IS DISTINCT FROM true
       OR active_lease.worker_id IS DISTINCT FROM NEW.claimed_by_worker
       OR active_lease.lease_epoch IS DISTINCT FROM NEW.claimed_lease_epoch THEN
      RAISE EXCEPTION 'autonomous claim requires the current active runtime lease' USING ERRCODE='23514';
    END IF;
    SELECT identity_status INTO ident FROM core.entities
     WHERE world_id=NEW.world_id AND entity_id=NEW.subject_id;
    SELECT life_status,execution_status,model_status,restriction_flags INTO life
      FROM runtime.lifecycle_states WHERE world_id=NEW.world_id AND activity_subject_id=NEW.subject_id;
    SELECT EXISTS(
      SELECT 1 FROM runtime.agent_profiles p
      JOIN runtime.model_routes r ON r.world_id=p.world_id AND r.agent_entity_id=p.agent_entity_id AND r.route_id=p.current_route_id
      JOIN runtime.model_manifests m ON m.world_id=r.world_id AND m.agent_entity_id=r.agent_entity_id AND m.manifest_id=r.manifest_id
      JOIN gateway.capability_descriptors d ON d.world_id=m.world_id AND d.descriptor_id=m.gateway_descriptor_id AND d.status='ACTIVE'
      JOIN gateway.connector_configs c ON c.world_id=m.world_id AND c.connector_id=m.gateway_connector_id AND c.descriptor_id=m.gateway_descriptor_id AND c.enabled=true
      WHERE p.world_id=NEW.world_id AND p.agent_entity_id=NEW.subject_id
    ) INTO route_ok;
    SELECT EXISTS(SELECT 1 FROM economy.activity_fees
      WHERE world_id=NEW.world_id AND activity_subject_id=NEW.subject_id
        AND billing_date=(now() AT TIME ZONE 'UTC')::date AND status='CHARGED') INTO fee_ok;
    SELECT available_micro_e INTO available FROM economy.wallet_balances
      WHERE world_id=NEW.world_id AND entity_id=NEW.subject_id;
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
    RETURN NEW;
  END IF;
  IF OLD.status='CLAIMED' AND NEW.status IN ('COMPLETED','BLOCKED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid scheduled action status transition % -> %', OLD.status, NEW.status USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS scheduled_actions_update_guard ON runtime.scheduled_actions;
CREATE TRIGGER scheduled_actions_update_guard
  BEFORE UPDATE ON runtime.scheduled_actions
  FOR EACH ROW EXECUTE FUNCTION runtime.guard_scheduled_action_update();
