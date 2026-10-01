-- P3 runtime JSON/provenance/checkpoint authority closure.
-- This replaces the corresponding live definitions installed by 014; it does not
-- add a parallel execution path.

-- Composite runtime JSON keys such as client_secret, oauthPassword and
-- service-api-key are credential material. Structured authorization provenance is
-- metadata, not a credential: only scalar Authorization-style values or explicit
-- credential/token/header keys are rejected.
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
        IF normalized_key ~ '(^|[_-])(cookie|secret|password|credential)([_-]|$)'
           OR normalized_key ~ '(^|[_-])(proxy_authorization|authorization_header|http_authorization|set_cookie|x_api_key|api_key|access_token|bearer_token)([_-]|$)'
           OR (normalized_key = 'authorization' AND jsonb_typeof(v) = 'string')
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
  DROP CONSTRAINT IF EXISTS model_routes_policy_no_secret_check,
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