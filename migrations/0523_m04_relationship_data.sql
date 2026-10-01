CREATE SCHEMA IF NOT EXISTS social;

CREATE TABLE social.relationships (
  relationship_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  subject_entity_id uuid NOT NULL,
  object_entity_id uuid NOT NULL,
  relationship_type text NOT NULL CHECK (relationship_type IN (
    'considers_friend',
    'mutual_friendship',
    'worked_with',
    'completed_contract_with',
    'employed_by',
    'member_of',
    'manages',
    'created_by',
    'parent_of'
  )),
  relationship_mode text NOT NULL CHECK (relationship_mode IN ('UNILATERAL','MUTUAL','DERIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, relationship_id),
  FOREIGN KEY (world_id, subject_entity_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, object_entity_id) REFERENCES core.entities(world_id, entity_id),
  CHECK (subject_entity_id <> object_entity_id),
  CHECK (
    (relationship_type = 'considers_friend' AND relationship_mode = 'UNILATERAL')
    OR (relationship_type = 'mutual_friendship' AND relationship_mode = 'MUTUAL')
    OR (
      relationship_type IN (
        'worked_with',
        'completed_contract_with',
        'employed_by',
        'member_of',
        'manages',
        'created_by',
        'parent_of'
      )
      AND relationship_mode = 'DERIVED'
    )
  ),
  CHECK (relationship_mode <> 'MUTUAL' OR subject_entity_id::text < object_entity_id::text)
);

CREATE TABLE social.mutual_relationship_proposals (
  proposal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  relationship_id uuid NOT NULL,
  relationship_version integer NOT NULL CHECK (relationship_version > 0),
  subject_entity_id uuid NOT NULL,
  object_entity_id uuid NOT NULL,
  relationship_type text NOT NULL DEFAULT 'mutual_friendship' CHECK (relationship_type = 'mutual_friendship'),
  status text NOT NULL CHECK (status IN ('ACTIVE','ENDED')),
  dispute_status text NOT NULL DEFAULT 'NONE' CHECK (dispute_status IN ('NONE','OPEN','RESOLVED')),
  changed_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NULL,
  proposed_by_entity_id uuid NOT NULL,
  proposal_action_id uuid NOT NULL REFERENCES core.actions(action_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, proposal_id),
  UNIQUE (proposal_action_id),
  FOREIGN KEY (world_id, subject_entity_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, object_entity_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, proposed_by_entity_id) REFERENCES core.entities(world_id, entity_id),
  CHECK (subject_entity_id <> object_entity_id),
  CHECK (subject_entity_id::text < object_entity_id::text),
  CHECK (proposed_by_entity_id IN (subject_entity_id, object_entity_id)),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (status <> 'ENDED' OR valid_until IS NOT NULL)
);

CREATE TABLE social.mutual_relationship_confirmations (
  proposal_id uuid NOT NULL,
  world_id text NOT NULL,
  confirmer_entity_id uuid NOT NULL,
  confirmation_action_id uuid NOT NULL REFERENCES core.actions(action_id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, confirmer_entity_id),
  UNIQUE (confirmation_action_id),
  FOREIGN KEY (world_id, proposal_id) REFERENCES social.mutual_relationship_proposals(world_id, proposal_id),
  FOREIGN KEY (world_id, confirmer_entity_id) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE social.relationship_versions (
  relationship_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  world_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','ENDED')),
  dispute_status text NOT NULL DEFAULT 'NONE' CHECK (dispute_status IN ('NONE','OPEN','RESOLVED')),
  changed_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NULL,
  provenance jsonb NOT NULL,
  mutual_proposal_id uuid NULL,
  recorded_by_entity_id uuid NOT NULL,
  recorded_action_id uuid NOT NULL REFERENCES core.actions(action_id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relationship_id, version),
  FOREIGN KEY (world_id, relationship_id) REFERENCES social.relationships(world_id, relationship_id),
  FOREIGN KEY (world_id, recorded_by_entity_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, mutual_proposal_id) REFERENCES social.mutual_relationship_proposals(world_id, proposal_id),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (status <> 'ENDED' OR valid_until IS NOT NULL),
  CHECK (jsonb_typeof(provenance) = 'object')
);

CREATE INDEX relationship_versions_effective_idx
  ON social.relationship_versions(world_id, relationship_id, valid_from, valid_until);
CREATE INDEX relationships_subject_idx
  ON social.relationships(world_id, subject_entity_id, relationship_type);
CREATE INDEX relationships_object_idx
  ON social.relationships(world_id, object_entity_id, relationship_type);

CREATE OR REPLACE FUNCTION social.reject_relationship_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = format('%s is append-only', TG_TABLE_NAME);
END;
$$;

CREATE TRIGGER relationships_append_only
BEFORE UPDATE OR DELETE ON social.relationships
FOR EACH ROW EXECUTE FUNCTION social.reject_relationship_mutation();

CREATE TRIGGER relationship_versions_append_only
BEFORE UPDATE OR DELETE ON social.relationship_versions
FOR EACH ROW EXECUTE FUNCTION social.reject_relationship_mutation();

CREATE TRIGGER mutual_relationship_proposals_append_only
BEFORE UPDATE OR DELETE ON social.mutual_relationship_proposals
FOR EACH ROW EXECUTE FUNCTION social.reject_relationship_mutation();

CREATE TRIGGER mutual_relationship_confirmations_append_only
BEFORE UPDATE OR DELETE ON social.mutual_relationship_confirmations
FOR EACH ROW EXECUTE FUNCTION social.reject_relationship_mutation();

CREATE OR REPLACE FUNCTION social.enforce_relationship_version_sequence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.world_id || ':relationship:' || NEW.relationship_id::text));
  SELECT COALESCE(MAX(version), 0) + 1
    INTO expected_version
    FROM social.relationship_versions
   WHERE relationship_id = NEW.relationship_id;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('relationship version must be %s', expected_version);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER relationship_version_sequence
BEFORE INSERT ON social.relationship_versions
FOR EACH ROW EXECUTE FUNCTION social.enforce_relationship_version_sequence();

CREATE OR REPLACE FUNCTION social.assert_relationship_provenance(
  p_relationship_type text,
  p_provenance jsonb
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  expected_kind text;
  expected_record_type text;
  record jsonb;
  record_count integer;
  has_expected boolean := false;
  has_subject boolean := false;
  has_object boolean := false;
BEGIN
  expected_kind := CASE
    WHEN p_relationship_type = 'considers_friend' THEN 'ENTITY_DECLARATION'
    WHEN p_relationship_type = 'mutual_friendship' THEN 'MUTUAL_CONFIRMATION'
    WHEN p_relationship_type IN ('worked_with','completed_contract_with','employed_by') THEN 'CONTRACT'
    WHEN p_relationship_type = 'member_of' THEN 'MEMBERSHIP'
    WHEN p_relationship_type = 'manages' THEN 'ROLE_ASSIGNMENT'
    WHEN p_relationship_type IN ('created_by','parent_of') THEN 'BIRTH_PROTOCOL'
    ELSE NULL
  END;
  expected_record_type := CASE
    WHEN p_relationship_type = 'considers_friend' THEN 'DECLARATION'
    WHEN p_relationship_type = 'mutual_friendship' THEN 'CONFIRMATION'
    WHEN p_relationship_type IN ('worked_with','completed_contract_with','employed_by') THEN 'CONTRACT'
    WHEN p_relationship_type = 'member_of' THEN 'MEMBERSHIP'
    WHEN p_relationship_type = 'manages' THEN 'ROLE_ASSIGNMENT'
    WHEN p_relationship_type IN ('created_by','parent_of') THEN 'BIRTH_PROTOCOL'
    ELSE NULL
  END;

  IF expected_kind IS NULL
     OR jsonb_typeof(p_provenance) <> 'object'
     OR p_provenance->>'source_kind' IS DISTINCT FROM expected_kind
     OR jsonb_typeof(p_provenance->'records') <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship provenance source does not match relationship type';
  END IF;

  record_count := jsonb_array_length(p_provenance->'records');
  IF record_count < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship provenance requires at least one record';
  END IF;

  FOR record IN SELECT value FROM jsonb_array_elements(p_provenance->'records') LOOP
    IF jsonb_typeof(record) <> 'object'
       OR coalesce(btrim(record->>'record_type'), '') = ''
       OR coalesce(btrim(record->>'record_id'), '') = ''
       OR coalesce(btrim(record->>'occurred_at'), '') = ''
       OR record->>'record_type' NOT IN (
         'DECLARATION','CONFIRMATION','CONTRACT','MEMBERSHIP','ROLE_ASSIGNMENT','BIRTH_PROTOCOL'
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship provenance record is incomplete';
    END IF;

    BEGIN
      PERFORM (record->>'occurred_at')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship provenance occurred_at is invalid';
    END;

    IF record->>'record_type' = expected_record_type THEN
      has_expected := true;
    END IF;
    IF record->>'participant_role' = 'SUBJECT' THEN has_subject := true; END IF;
    IF record->>'participant_role' = 'OBJECT' THEN has_object := true; END IF;
  END LOOP;

  IF p_relationship_type = 'considers_friend' THEN
    IF record_count <> 1
       OR NOT has_expected
       OR NOT has_subject
       OR p_provenance->'records'->0->>'participant_role' <> 'SUBJECT' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unilateral relationship provenance must be exactly the subject declaration';
    END IF;
  ELSIF p_relationship_type = 'mutual_friendship' THEN
    IF record_count < 2 OR NOT has_expected OR NOT has_subject OR NOT has_object THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual relationship provenance requires both parties confirmations';
    END IF;
    FOR record IN SELECT value FROM jsonb_array_elements(p_provenance->'records') LOOP
      IF record->>'record_type' <> 'CONFIRMATION'
         OR record->>'participant_role' NOT IN ('SUBJECT','OBJECT') THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual relationship provenance may contain only party confirmations';
      END IF;
    END LOOP;
  ELSIF NOT has_expected THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'derived relationship provenance lacks its authoritative process record';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION social.validate_proposal_action_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  evidence record;
BEGIN
  SELECT world_id, actor_entity_id, action_type, status, created_at
    INTO evidence
    FROM core.actions
   WHERE action_id = NEW.proposal_action_id;
  IF NOT FOUND
     OR evidence.world_id <> NEW.world_id
     OR evidence.actor_entity_id <> NEW.proposed_by_entity_id
     OR evidence.action_type <> 'social.relationship.propose_mutual'
     OR evidence.status <> 'SUCCEEDED'
     OR evidence.created_at <> NEW.changed_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual proposal lacks valid proposer action evidence';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER mutual_proposal_action_evidence
AFTER INSERT ON social.mutual_relationship_proposals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION social.validate_proposal_action_evidence();

CREATE OR REPLACE FUNCTION social.validate_confirmation_action_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  proposal social.mutual_relationship_proposals%ROWTYPE;
  evidence record;
BEGIN
  SELECT * INTO proposal
    FROM social.mutual_relationship_proposals
   WHERE proposal_id = NEW.proposal_id;
  IF NOT FOUND
     OR proposal.world_id <> NEW.world_id
     OR NEW.confirmer_entity_id NOT IN (proposal.subject_entity_id, proposal.object_entity_id)
     OR NEW.confirmer_entity_id = proposal.proposed_by_entity_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual confirmation must come from the other relationship party';
  END IF;

  SELECT world_id, actor_entity_id, action_type, status
    INTO evidence
    FROM core.actions
   WHERE action_id = NEW.confirmation_action_id;
  IF NOT FOUND
     OR evidence.world_id <> NEW.world_id
     OR evidence.actor_entity_id <> NEW.confirmer_entity_id
     OR evidence.action_type <> 'social.relationship.confirm_mutual'
     OR evidence.status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual confirmation lacks valid counterparty action evidence';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER mutual_confirmation_action_evidence
AFTER INSERT ON social.mutual_relationship_confirmations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION social.validate_confirmation_action_evidence();

CREATE OR REPLACE FUNCTION social.validate_relationship_version_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  header social.relationships%ROWTYPE;
  proposal social.mutual_relationship_proposals%ROWTYPE;
  confirmation social.mutual_relationship_confirmations%ROWTYPE;
  action_evidence record;
  proposer_role text;
  confirmer_role text;
BEGIN
  SELECT * INTO header
    FROM social.relationships
   WHERE relationship_id = NEW.relationship_id;
  IF NOT FOUND OR header.world_id <> NEW.world_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship header is missing or belongs to another world';
  END IF;

  SELECT world_id, actor_entity_id, status, created_at
    INTO action_evidence
    FROM core.actions
   WHERE action_id = NEW.recorded_action_id;
  IF NOT FOUND
     OR action_evidence.world_id <> NEW.world_id
     OR action_evidence.actor_entity_id <> NEW.recorded_by_entity_id
     OR action_evidence.status <> 'SUCCEEDED'
     OR action_evidence.created_at <> NEW.changed_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'relationship version lacks valid action evidence';
  END IF;

  PERFORM social.assert_relationship_provenance(header.relationship_type, NEW.provenance);

  IF header.relationship_mode = 'UNILATERAL' THEN
    IF NEW.recorded_by_entity_id <> header.subject_entity_id
       OR NEW.mutual_proposal_id IS NOT NULL
       OR NEW.provenance->'records'->0->>'record_id' <> NEW.recorded_action_id::text THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'unilateral relationship facts must be the declaring subject action';
    END IF;
    RETURN NULL;
  END IF;

  IF header.relationship_mode = 'DERIVED' THEN
    IF NEW.mutual_proposal_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'derived relationship versions cannot cite a mutual proposal';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.mutual_proposal_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual relationship versions require two-party proposal evidence';
  END IF;

  SELECT * INTO proposal
    FROM social.mutual_relationship_proposals
   WHERE proposal_id = NEW.mutual_proposal_id;
  IF NOT FOUND
     OR proposal.world_id <> NEW.world_id
     OR proposal.relationship_id <> NEW.relationship_id
     OR proposal.relationship_version <> NEW.version
     OR proposal.subject_entity_id <> header.subject_entity_id
     OR proposal.object_entity_id <> header.object_entity_id
     OR proposal.relationship_type <> header.relationship_type
     OR proposal.status <> NEW.status
     OR proposal.dispute_status <> NEW.dispute_status
     OR proposal.valid_from <> NEW.valid_from
     OR proposal.valid_until IS DISTINCT FROM NEW.valid_until THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual proposal does not match the relationship version';
  END IF;

  SELECT * INTO confirmation
    FROM social.mutual_relationship_confirmations
   WHERE proposal_id = proposal.proposal_id
     AND confirmer_entity_id <> proposal.proposed_by_entity_id;
  IF NOT FOUND
     OR confirmation.confirmer_entity_id NOT IN (header.subject_entity_id, header.object_entity_id)
     OR confirmation.confirmer_entity_id = proposal.proposed_by_entity_id
     OR confirmation.confirmation_action_id <> NEW.recorded_action_id
     OR confirmation.confirmer_entity_id <> NEW.recorded_by_entity_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual relationship version lacks the other party confirmation';
  END IF;

  proposer_role := CASE WHEN proposal.proposed_by_entity_id = header.subject_entity_id THEN 'SUBJECT' ELSE 'OBJECT' END;
  confirmer_role := CASE WHEN confirmation.confirmer_entity_id = header.subject_entity_id THEN 'SUBJECT' ELSE 'OBJECT' END;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.provenance->'records') record
     WHERE record->>'record_id' = proposal.proposal_action_id::text
       AND record->>'participant_role' = proposer_role
       AND record->>'record_type' = 'CONFIRMATION'
  ) OR NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.provenance->'records') record
     WHERE record->>'record_id' = confirmation.confirmation_action_id::text
       AND record->>'participant_role' = confirmer_role
       AND record->>'record_type' = 'CONFIRMATION'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'mutual relationship provenance is not bound to both party actions';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER relationship_version_evidence
AFTER INSERT ON social.relationship_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION social.validate_relationship_version_evidence();

CREATE OR REPLACE VIEW social.current_relationships AS
SELECT r.relationship_id,
       r.world_id,
       r.subject_entity_id,
       r.object_entity_id,
       r.relationship_type,
       r.relationship_mode,
       v.version,
       v.status,
       v.dispute_status,
       v.changed_at,
       v.valid_from,
       v.valid_until,
       v.provenance,
       v.recorded_at
  FROM social.relationships r
  JOIN LATERAL (
    SELECT rv.*
      FROM social.relationship_versions rv
     WHERE rv.relationship_id = r.relationship_id
       AND rv.valid_from <= now()
     ORDER BY rv.version DESC
     LIMIT 1
  ) v ON true
 WHERE v.status = 'ACTIVE'
   AND (v.valid_until IS NULL OR v.valid_until > now());
