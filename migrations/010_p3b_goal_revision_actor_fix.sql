-- P3-B follow-up within the same feature slice: capture the creating actor on INSERT
-- and require the service to set an explicit actor/reason for UPDATE revisions.
CREATE OR REPLACE FUNCTION runtime.capture_goal_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_reason text;
  v_actor uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'goal version must advance exactly once' USING ERRCODE='23514';
  END IF;

  IF TG_OP='INSERT' THEN
    v_reason := 'goal created';
    v_actor := NEW.created_by;
  ELSE
    v_reason := NULLIF(current_setting('newhumans.goal_change_reason',true),'');
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'goal update requires explicit change reason' USING ERRCODE='23514';
    END IF;
    BEGIN
      v_actor := NULLIF(current_setting('newhumans.goal_changed_by',true),'')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_actor := NULL;
    END;
    IF v_actor IS NULL THEN
      RAISE EXCEPTION 'goal update requires explicit actor' USING ERRCODE='23514';
    END IF;
  END IF;

  INSERT INTO runtime.goal_revisions
    (world_id,subject_id,goal_id,version,source,goal_text,priority,rationale,budget_micro_e,deadline,parent_goal_id,success_evidence,status,change_reason,created_by)
  VALUES
    (NEW.world_id,NEW.subject_id,NEW.goal_id,NEW.version,NEW.source,NEW.goal_text,NEW.priority,NEW.rationale,NEW.budget_micro_e,NEW.deadline,NEW.parent_goal_id,NEW.success_evidence,NEW.status,v_reason,v_actor);
  RETURN NEW;
END $$;
