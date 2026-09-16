-- Defense in depth: an ACTIVE runtime may not retain restrictions that categorically
-- prohibit execution. Economic recovery flags are cleared by a successful resume, while
-- owner/policy/M03 restrictions require their own explicit authority path.
CREATE OR REPLACE FUNCTION runtime.guard_active_lifecycle_restrictions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE flag text;
BEGIN
  IF NEW.life_status <> 'ACTIVE' THEN RETURN NEW; END IF;
  FOREACH flag IN ARRAY ARRAY['OWNER_PAUSE','NO_BUDGET','QUARANTINE','WORLD_SUSPENSION','M03_CONTEXT_UNAVAILABLE']::text[] LOOP
    IF flag = ANY(NEW.restriction_flags) THEN
      RAISE EXCEPTION 'ACTIVE runtime cannot retain blocking restriction %', flag USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER lifecycle_active_restriction_guard
  BEFORE INSERT OR UPDATE ON runtime.lifecycle_states
  FOR EACH ROW EXECUTE FUNCTION runtime.guard_active_lifecycle_restrictions();
