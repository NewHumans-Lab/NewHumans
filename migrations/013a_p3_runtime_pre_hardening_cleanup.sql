-- P3 hardening preflight for databases upgraded from the pre-review runtime.
-- This migration exists before 014 lexically so legacy data is normalized or
-- explicitly rejected before stricter authority constraints are installed.

-- Ordinary Agents were temporarily allowed to point memory_subject_id at any
-- same-world Entity. M03/HPA sharing is still deliberately deferred, so the only
-- authoritative ordinary-Agent binding is self. Normalize the pointer in place;
-- no knowledge payload is deleted or fabricated.
UPDATE runtime.agent_profiles
   SET memory_subject_id = agent_entity_id,
       profile_version = profile_version + 1,
       updated_at = now()
 WHERE memory_subject_id IS DISTINCT FROM agent_entity_id;

-- Migration 014 backfills SYSTEM_RUNTIME_CONTROL provenance onto existing routes.
-- Never certify a route whose immutable creator is not currently an ACTIVE SYSTEM;
-- such a database requires explicit owner review instead of invented provenance.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM runtime.model_routes r
      LEFT JOIN core.entities e
        ON e.world_id = r.world_id AND e.entity_id = r.created_by
     WHERE e.entity_id IS NULL
        OR e.entity_type <> 'SYSTEM'
        OR e.identity_status <> 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'legacy runtime route provenance cannot be certified as ACTIVE SYSTEM authority; owner review required'
      USING ERRCODE='23514';
  END IF;
END $$;