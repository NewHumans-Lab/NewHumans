-- Final scheduler/lifecycle invariants discovered during PR #17 closure review.
-- This replaces authority functions in place; it does not create another execution path.

-- An ACTIVE runtime with an available model and no execution-blocking restriction must
-- remain executable. In particular, publishing a replacement route must not strand an
-- already ACTIVE, quiescent runtime in BLOCKED merely because route metadata changed.
CREATE OR REPLACE FUNCTION runtime.normalize_active_available_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.life_status='ACTIVE'
     AND NEW.model_status='AVAILABLE'
     AND NEW.execution_status='BLOCKED'
     AND NOT (COALESCE(NEW.restriction_flags,'{}'::text[]) && ARRAY[
       'M03_CONTEXT_UNAVAILABLE','NO_MODEL_ROUTE','OWNER_PAUSE','NO_BUDGET',
       'QUARANTINE','WORLD_SUSPENSION','NO_ACTIVITY_ENERGY','DAILY_FEE_UNFUNDED'
     ]::text[]) THEN
    NEW.execution_status := 'IDLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lifecycle_active_available_execution_guard ON runtime.lifecycle_states;
CREATE TRIGGER lifecycle_active_available_execution_guard
  BEFORE UPDATE OF life_status,execution_status,model_status,restriction_flags ON runtime.lifecycle_states
  FOR EACH ROW EXECUTE FUNCTION runtime.normalize_active_available_execution();

-- Replace the 015b schedule guard. SCHEDULED autonomous work has only three legal
-- non-cancel continuations: a current-lease claim, a current-lease M03 block, or a
-- current-lease SKIP miss whose database-authoritative latest-run bound has elapsed.
CREATE OR REPLACE FUNCTION runtime.guard_scheduled_action_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wake_outcome text;
  active_lease record;
  life record;
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

  IF OLD.status='SCHEDULED' AND OLD.action_kind='AUTONOMOUS_TURN'
     AND NEW.status IN ('BLOCKED','MISSED') THEN
    SELECT worker_id,lease_epoch,(released_at IS NULL AND expires_at > now()) active
      INTO active_lease
      FROM runtime.runtime_leases
     WHERE world_id=NEW.world_id AND activity_subject_id=NEW.subject_id;
    IF active_lease.active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'autonomous pre-claim terminal transition requires a current active runtime lease' USING ERRCODE='23514';
    END IF;
    IF OLD.due_at > now() THEN
      RAISE EXCEPTION 'autonomous pre-claim terminal transition cannot precede due time' USING ERRCODE='23514';
    END IF;
    NEW.claimed_by_worker := active_lease.worker_id;
    NEW.claimed_lease_epoch := active_lease.lease_epoch;
    NEW.claimed_at := COALESCE(NEW.claimed_at,now());
    IF NEW.status='MISSED' THEN
      IF OLD.missed_policy IS DISTINCT FROM 'SKIP'
         OR OLD.latest_run_at IS NULL
         OR OLD.latest_run_at >= now() THEN
        RAISE EXCEPTION 'autonomous MISSED requires an elapsed SKIP latest-run window' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.blocked_reason IS DISTINCT FROM 'M03_CONTEXT_UNAVAILABLE' THEN
      RAISE EXCEPTION 'autonomous pre-claim BLOCKED requires canonical M03 dependency evidence' USING ERRCODE='23514';
    END IF;
    SELECT restriction_flags INTO life
      FROM runtime.lifecycle_states
     WHERE world_id=NEW.world_id AND activity_subject_id=NEW.subject_id;
    IF NOT ('M03_CONTEXT_UNAVAILABLE'=ANY(COALESCE(life.restriction_flags,'{}'::text[]))) THEN
      RAISE EXCEPTION 'autonomous pre-claim block does not match runtime M03 restriction state' USING ERRCODE='23514';
    END IF;
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
