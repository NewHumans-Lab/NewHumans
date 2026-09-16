-- P3-A design-conformance hardening discovered before PR acceptance.
-- Keep one authoritative runtime path: route history is same-Agent, connector execution
-- identity cannot drift in place, and checkpoint writes are fenced at PostgreSQL too.

-- An immutable M02 manifest must continue to resolve to the same M06 execution identity.
-- Operational enable/disable remains mutable; changing any other connector identity field
-- requires creation of a new connector row and then a new manifest/route version.
CREATE OR REPLACE FUNCTION gateway.reject_connector_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.connector_id IS DISTINCT FROM NEW.connector_id
     OR OLD.world_id IS DISTINCT FROM NEW.world_id
     OR OLD.descriptor_id IS DISTINCT FROM NEW.descriptor_id
     OR OLD.connector_kind IS DISTINCT FROM NEW.connector_kind
     OR OLD.billing_mode IS DISTINCT FROM NEW.billing_mode
     OR OLD.base_url IS DISTINCT FROM NEW.base_url
     OR OLD.credential_ref_id IS DISTINCT FROM NEW.credential_ref_id
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'connector execution identity is immutable; create a new connector for a changed endpoint/credential/billing contract'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS connector_configs_identity_immutable ON gateway.connector_configs;
CREATE TRIGGER connector_configs_identity_immutable
  BEFORE UPDATE ON gateway.connector_configs
  FOR EACH ROW EXECUTE FUNCTION gateway.reject_connector_identity_mutation();

-- Route history must never cross Agent ownership even through direct SQL or future code paths.
ALTER TABLE runtime.model_manifests
  ADD CONSTRAINT model_manifests_world_agent_manifest_key
  UNIQUE (world_id, agent_entity_id, manifest_id);

ALTER TABLE runtime.model_routes
  DROP CONSTRAINT IF EXISTS model_routes_world_id_manifest_id_fkey,
  ADD CONSTRAINT model_routes_manifest_same_agent_fkey
  FOREIGN KEY (world_id, agent_entity_id, manifest_id)
  REFERENCES runtime.model_manifests(world_id, agent_entity_id, manifest_id);

ALTER TABLE runtime.model_change_events
  DROP CONSTRAINT IF EXISTS model_change_events_world_id_from_route_id_fkey,
  DROP CONSTRAINT IF EXISTS model_change_events_world_id_to_route_id_fkey,
  ADD CONSTRAINT model_change_events_from_route_same_agent_fkey
    FOREIGN KEY (world_id, agent_entity_id, from_route_id)
    REFERENCES runtime.model_routes(world_id, agent_entity_id, route_id),
  ADD CONSTRAINT model_change_events_to_route_same_agent_fkey
    FOREIGN KEY (world_id, agent_entity_id, to_route_id)
    REFERENCES runtime.model_routes(world_id, agent_entity_id, route_id);

-- Defense in depth for stale workers. The application also verifies worker_id, lease_epoch,
-- expiry, and expected state under row locks. PostgreSQL independently serializes and rejects
-- any checkpoint whose epoch is no longer current or whose state version does not advance
-- exactly once. A valid checkpoint advances the authoritative lifecycle version in the same
-- transaction, so there is no second direct-SQL path that can leave checkpoint/state drift.
CREATE OR REPLACE FUNCTION runtime.assert_checkpoint_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  l runtime.runtime_leases%ROWTYPE;
  s runtime.lifecycle_states%ROWTYPE;
BEGIN
  SELECT * INTO l
    FROM runtime.runtime_leases
   WHERE world_id=NEW.world_id AND activity_subject_id=NEW.activity_subject_id
   FOR UPDATE;
  IF l.activity_subject_id IS NULL
     OR l.released_at IS NOT NULL
     OR l.expires_at <= now()
     OR l.lease_epoch <> NEW.lease_epoch THEN
    RAISE EXCEPTION 'checkpoint rejected by current runtime lease fence' USING ERRCODE='23514';
  END IF;

  SELECT * INTO s
    FROM runtime.lifecycle_states
   WHERE world_id=NEW.world_id AND activity_subject_id=NEW.activity_subject_id
   FOR UPDATE;
  IF s.activity_subject_id IS NULL OR NEW.state_version <> s.state_version + 1 THEN
    RAISE EXCEPTION 'checkpoint rejected by runtime state-version fence' USING ERRCODE='23514';
  END IF;

  UPDATE runtime.lifecycle_states
     SET state_version=NEW.state_version, updated_at=now()
   WHERE world_id=NEW.world_id AND activity_subject_id=NEW.activity_subject_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_checkpoints_fence ON runtime.runtime_checkpoints;
CREATE TRIGGER runtime_checkpoints_fence
  BEFORE INSERT ON runtime.runtime_checkpoints
  FOR EACH ROW EXECUTE FUNCTION runtime.assert_checkpoint_fence();
