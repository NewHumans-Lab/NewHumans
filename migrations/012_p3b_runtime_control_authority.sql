-- P3-B authority hardening: mutable current state must retain immutable evidence,
-- and scheduled work terms/status cannot silently drift through alternate SQL paths.

CREATE OR REPLACE FUNCTION runtime.assert_trait_state_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.world_id IS DISTINCT FROM OLD.world_id
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.trait_key IS DISTINCT FROM OLD.trait_key
       OR NEW.trait_class IS DISTINCT FROM OLD.trait_class THEN
      RAISE EXCEPTION 'trait identity/class is immutable; create a different trait key instead' USING ERRCODE='55000';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'trait version must advance exactly once' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trait_states_version_guard
  BEFORE UPDATE ON runtime.trait_states
  FOR EACH ROW EXECUTE FUNCTION runtime.assert_trait_state_version();

CREATE OR REPLACE FUNCTION runtime.assert_trait_update_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*)::integer INTO n
    FROM runtime.trait_updates
   WHERE world_id=NEW.world_id
     AND subject_id=NEW.subject_id
     AND trait_key=NEW.trait_key
     AND version=NEW.version
     AND to_value_ppm=NEW.value_ppm
     AND trait_class=NEW.trait_class;
  IF n <> 1 THEN
    RAISE EXCEPTION 'trait state version requires exactly one matching append-only trait update' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trait_states_evidence_guard
  AFTER INSERT OR UPDATE ON runtime.trait_states
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION runtime.assert_trait_update_evidence();

CREATE OR REPLACE FUNCTION runtime.guard_scheduled_action_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.status='SCHEDULED' AND NEW.status IN ('CLAIMED','COMPLETED','CANCELLED','MISSED','BLOCKED') THEN RETURN NEW; END IF;
  IF OLD.status='CLAIMED' AND NEW.status IN ('COMPLETED','BLOCKED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid scheduled action status transition % -> %', OLD.status, NEW.status USING ERRCODE='23514';
END $$;
CREATE TRIGGER scheduled_actions_update_guard
  BEFORE UPDATE ON runtime.scheduled_actions
  FOR EACH ROW EXECUTE FUNCTION runtime.guard_scheduled_action_update();
