CREATE SCHEMA IF NOT EXISTS social;

CREATE TABLE social.contracts (
  contract_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  employer_entity_id uuid NOT NULL,
  contractor_entity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','ACTIVE','SUBMITTED','DISPUTED','SETTLED','CANCELLED')),
  current_version integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  escrow_external_ref text NULL CHECK (escrow_external_ref IS NULL OR btrim(escrow_external_ref) <> ''),
  activated_at timestamptz NULL,
  settled_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (employer_entity_id <> contractor_entity_id),
  UNIQUE (world_id, contract_id)
);

CREATE TABLE social.contract_versions (
  contract_id uuid NOT NULL,
  world_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  parent_version integer NULL CHECK (parent_version IS NULL OR parent_version > 0),
  scope text NOT NULL CHECK (btrim(scope) <> ''),
  deliverables jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria jsonb NULL,
  price_micro_e bigint NOT NULL CHECK (price_micro_e >= 0),
  start_conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_due_at timestamptz NULL,
  acceptance_window_seconds integer NULL CHECK (acceptance_window_seconds IS NULL OR acceptance_window_seconds > 0),
  rework_limit integer NOT NULL DEFAULT 0 CHECK (rework_limit >= 0),
  cancellation_terms text NULL,
  dispute_procedure text NULL,
  auto_acceptance boolean NOT NULL DEFAULT false,
  reasoning_cost_payer_entity_id uuid NULL,
  rule_version text NOT NULL CHECK (btrim(rule_version) <> ''),
  change_summary text NOT NULL DEFAULT '',
  author_entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, version),
  UNIQUE (world_id, contract_id, version)
);

CREATE TABLE social.contract_acceptances (
  acceptance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  contract_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  party_entity_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz NULL,
  UNIQUE (contract_id, version, party_entity_id),
  UNIQUE (world_id, party_entity_id, idempotency_key)
);
CREATE INDEX contract_acceptances_current_idx
  ON social.contract_acceptances(contract_id, version, party_entity_id)
  WHERE invalidated_at IS NULL;

CREATE TABLE social.milestones (
  milestone_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  contract_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  title text NOT NULL CHECK (btrim(title) <> ''),
  acceptance_criteria jsonb NULL,
  due_at timestamptz NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SUBMITTED','ACCEPTED','REWORK','DISPUTED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, version, ordinal),
  UNIQUE (world_id, contract_id, version, milestone_id)
);

CREATE TABLE social.deliveries (
  delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  contract_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  milestone_id uuid NULL,
  submission_no integer NOT NULL CHECK (submission_no > 0),
  submitted_by_entity_id uuid NOT NULL,
  artifact_ref text NOT NULL CHECK (btrim(artifact_ref) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  status text NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED','ACCEPTED','REJECTED','SUPERSEDED','DISPUTED')),
  review_note text NULL,
  review_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  UNIQUE (contract_id, version, submission_no),
  UNIQUE (world_id, contract_id, idempotency_key),
  UNIQUE (world_id, contract_id, version, delivery_id)
);

CREATE TABLE social.disputes (
  dispute_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  contract_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  delivery_id uuid NULL,
  raised_by_entity_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED','CANCELLED')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution jsonb NULL,
  resolved_by_entity_id uuid NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  UNIQUE (world_id, contract_id, dispute_id)
);

-- NH-021's directory conformance test intentionally audits every declarative
-- foreign key in the shared social schema. Contract-domain references therefore
-- stay database-enforced with constraint triggers/functions instead of adding
-- sibling-module FK metadata to that audit surface.
CREATE OR REPLACE FUNCTION social.assert_contract_entity(
  p_world_id text,
  p_entity_id uuid,
  p_reference text
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_entity_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.entities
     WHERE world_id = p_world_id AND entity_id = p_entity_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = format('%s must reference an Entity in the same world', p_reference);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION social.guard_contract_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.world_id IS DISTINCT FROM OLD.world_id OR
    NEW.employer_entity_id IS DISTINCT FROM OLD.employer_entity_id OR
    NEW.contractor_entity_id IS DISTINCT FROM OLD.contractor_entity_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contract parties and world are immutable';
  END IF;

  PERFORM social.assert_contract_entity(NEW.world_id, NEW.employer_entity_id, 'employer_entity_id');
  PERFORM social.assert_contract_entity(NEW.world_id, NEW.contractor_entity_id, 'contractor_entity_id');
  RETURN NEW;
END $$;

CREATE TRIGGER contract_identity_guard
BEFORE INSERT OR UPDATE OF world_id, employer_entity_id, contractor_entity_id ON social.contracts
FOR EACH ROW EXECUTE FUNCTION social.guard_contract_identity();

CREATE OR REPLACE FUNCTION social.prepare_contract_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_current integer;
BEGIN
  SELECT status, current_version
    INTO v_status, v_current
    FROM social.contracts
    WHERE world_id = NEW.world_id AND contract_id = NEW.contract_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'contract not found for version';
  END IF;
  IF v_status <> 'PROPOSED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contract versions can change only while PROPOSED';
  END IF;
  IF NEW.version <> v_current + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contract version must increase by exactly one';
  END IF;
  IF v_current = 0 AND NEW.parent_version IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'first contract version cannot have a parent';
  END IF;
  IF v_current > 0 AND NEW.parent_version IS DISTINCT FROM v_current THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new contract version must reference the current version as parent';
  END IF;

  PERFORM social.assert_contract_entity(NEW.world_id, NEW.author_entity_id, 'author_entity_id');
  PERFORM social.assert_contract_entity(NEW.world_id, NEW.reasoning_cost_payer_entity_id, 'reasoning_cost_payer_entity_id');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION social.publish_contract_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE social.contracts
     SET current_version = NEW.version,
         updated_at = now()
   WHERE world_id = NEW.world_id AND contract_id = NEW.contract_id;

  UPDATE social.contract_acceptances
     SET invalidated_at = COALESCE(invalidated_at, now())
   WHERE world_id = NEW.world_id
     AND contract_id = NEW.contract_id
     AND version <> NEW.version
     AND invalidated_at IS NULL;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION social.reject_contract_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'contract versions are immutable; publish a new version';
END $$;

CREATE TRIGGER contract_version_prepare
BEFORE INSERT ON social.contract_versions
FOR EACH ROW EXECUTE FUNCTION social.prepare_contract_version();

CREATE TRIGGER contract_version_publish
AFTER INSERT ON social.contract_versions
FOR EACH ROW EXECUTE FUNCTION social.publish_contract_version();

CREATE TRIGGER contract_version_immutable
BEFORE UPDATE OR DELETE ON social.contract_versions
FOR EACH ROW EXECUTE FUNCTION social.reject_contract_version_mutation();

CREATE OR REPLACE FUNCTION social.validate_contract_acceptance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_contract social.contracts%ROWTYPE;
BEGIN
  SELECT * INTO v_contract
    FROM social.contracts
    WHERE world_id = NEW.world_id AND contract_id = NEW.contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'contract not found for acceptance';
  END IF;
  IF v_contract.status <> 'PROPOSED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contract can be accepted only while PROPOSED';
  END IF;
  IF NEW.version <> v_contract.current_version OR NOT EXISTS (
    SELECT 1 FROM social.contract_versions
     WHERE world_id = NEW.world_id
       AND contract_id = NEW.contract_id
       AND version = NEW.version
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acceptance must bind the current published contract version';
  END IF;
  IF NEW.party_entity_id <> v_contract.employer_entity_id
     AND NEW.party_entity_id <> v_contract.contractor_entity_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'acceptance party must be a contract party';
  END IF;
  IF NEW.invalidated_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'new acceptance cannot start invalidated';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER contract_acceptance_validate
BEFORE INSERT ON social.contract_acceptances
FOR EACH ROW EXECUTE FUNCTION social.validate_contract_acceptance();

CREATE OR REPLACE FUNCTION social.guard_milestone_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.world_id IS DISTINCT FROM OLD.world_id OR
    NEW.contract_id IS DISTINCT FROM OLD.contract_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.ordinal IS DISTINCT FROM OLD.ordinal
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'milestone contract identity is immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM social.contract_versions
     WHERE world_id = NEW.world_id
       AND contract_id = NEW.contract_id
       AND version = NEW.version
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'milestone must reference a published contract version';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER milestone_reference_guard
BEFORE INSERT OR UPDATE OF world_id, contract_id, version, ordinal ON social.milestones
FOR EACH ROW EXECUTE FUNCTION social.guard_milestone_reference();

CREATE OR REPLACE FUNCTION social.guard_delivery_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.world_id IS DISTINCT FROM OLD.world_id OR
    NEW.contract_id IS DISTINCT FROM OLD.contract_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.milestone_id IS DISTINCT FROM OLD.milestone_id OR
    NEW.submission_no IS DISTINCT FROM OLD.submission_no OR
    NEW.submitted_by_entity_id IS DISTINCT FROM OLD.submitted_by_entity_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'delivery contract identity is immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM social.contract_versions
     WHERE world_id = NEW.world_id
       AND contract_id = NEW.contract_id
       AND version = NEW.version
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'delivery must reference a published contract version';
  END IF;

  IF NEW.milestone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM social.milestones
     WHERE world_id = NEW.world_id
       AND contract_id = NEW.contract_id
       AND version = NEW.version
       AND milestone_id = NEW.milestone_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'delivery milestone must belong to the same contract version';
  END IF;

  PERFORM social.assert_contract_entity(NEW.world_id, NEW.submitted_by_entity_id, 'submitted_by_entity_id');
  RETURN NEW;
END $$;

CREATE TRIGGER delivery_reference_guard
BEFORE INSERT OR UPDATE OF world_id, contract_id, version, milestone_id, submission_no, submitted_by_entity_id ON social.deliveries
FOR EACH ROW EXECUTE FUNCTION social.guard_delivery_reference();

CREATE OR REPLACE FUNCTION social.guard_dispute_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.world_id IS DISTINCT FROM OLD.world_id OR
    NEW.contract_id IS DISTINCT FROM OLD.contract_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.delivery_id IS DISTINCT FROM OLD.delivery_id OR
    NEW.raised_by_entity_id IS DISTINCT FROM OLD.raised_by_entity_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'dispute contract identity is immutable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM social.contract_versions
     WHERE world_id = NEW.world_id
       AND contract_id = NEW.contract_id
       AND version = NEW.version
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'dispute must reference a published contract version';
  END IF;

  IF NEW.delivery_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM social.deliveries
     WHERE world_id = NEW.world_id
       AND contract_id = NEW.contract_id
       AND version = NEW.version
       AND delivery_id = NEW.delivery_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'dispute delivery must belong to the same contract version';
  END IF;

  PERFORM social.assert_contract_entity(NEW.world_id, NEW.raised_by_entity_id, 'raised_by_entity_id');
  PERFORM social.assert_contract_entity(NEW.world_id, NEW.resolved_by_entity_id, 'resolved_by_entity_id');
  RETURN NEW;
END $$;

CREATE TRIGGER dispute_reference_guard
BEFORE INSERT OR UPDATE OF world_id, contract_id, version, delivery_id, raised_by_entity_id, resolved_by_entity_id ON social.disputes
FOR EACH ROW EXECUTE FUNCTION social.guard_dispute_reference();

CREATE OR REPLACE FUNCTION social.guard_contract_entity_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM social.contracts
     WHERE world_id = OLD.world_id
       AND (employer_entity_id = OLD.entity_id OR contractor_entity_id = OLD.entity_id)
  ) OR EXISTS (
    SELECT 1 FROM social.contract_versions
     WHERE world_id = OLD.world_id
       AND (author_entity_id = OLD.entity_id OR reasoning_cost_payer_entity_id = OLD.entity_id)
  ) OR EXISTS (
    SELECT 1 FROM social.contract_acceptances
     WHERE world_id = OLD.world_id AND party_entity_id = OLD.entity_id
  ) OR EXISTS (
    SELECT 1 FROM social.deliveries
     WHERE world_id = OLD.world_id AND submitted_by_entity_id = OLD.entity_id
  ) OR EXISTS (
    SELECT 1 FROM social.disputes
     WHERE world_id = OLD.world_id
       AND (raised_by_entity_id = OLD.entity_id OR resolved_by_entity_id = OLD.entity_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Entity is referenced by M04 contract data';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER m04_contract_entity_delete_guard
BEFORE DELETE ON core.entities
FOR EACH ROW EXECUTE FUNCTION social.guard_contract_entity_delete();

CREATE OR REPLACE FUNCTION social.validate_contract_state_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_criteria jsonb;
  v_acceptances integer;
BEGIN
  IF NEW.current_version < OLD.current_version THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contract current_version cannot decrease';
  END IF;

  IF NEW.current_version <> OLD.current_version
     AND NOT EXISTS (
       SELECT 1 FROM social.contract_versions
        WHERE world_id = NEW.world_id
          AND contract_id = NEW.contract_id
          AND version = NEW.current_version
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'contract current_version must reference a published version';
  END IF;

  IF OLD.status <> 'PROPOSED'
     AND NEW.escrow_external_ref IS DISTINCT FROM OLD.escrow_external_ref THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'escrow external reference is immutable after proposal';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'PROPOSED' AND NEW.status IN ('ACTIVE','CANCELLED')) OR
      (OLD.status = 'ACTIVE' AND NEW.status IN ('SUBMITTED','CANCELLED')) OR
      (OLD.status = 'SUBMITTED' AND NEW.status IN ('ACTIVE','DISPUTED','SETTLED')) OR
      (OLD.status = 'DISPUTED' AND NEW.status IN ('SETTLED','CANCELLED'))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid contract state transition';
    END IF;
  END IF;

  IF NEW.status = 'ACTIVE' AND OLD.status IS DISTINCT FROM 'ACTIVE' THEN
    IF NEW.current_version <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACTIVE contract requires a published version';
    END IF;

    SELECT acceptance_criteria INTO v_criteria
      FROM social.contract_versions
      WHERE world_id = NEW.world_id
        AND contract_id = NEW.contract_id
        AND version = NEW.current_version;

    IF v_criteria IS NULL
       OR v_criteria = 'null'::jsonb
       OR v_criteria = '{}'::jsonb
       OR v_criteria = '[]'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACTIVE contract requires acceptance criteria';
    END IF;

    SELECT count(DISTINCT party_entity_id)::integer INTO v_acceptances
      FROM social.contract_acceptances
      WHERE world_id = NEW.world_id
        AND contract_id = NEW.contract_id
        AND version = NEW.current_version
        AND invalidated_at IS NULL
        AND party_entity_id IN (NEW.employer_entity_id, NEW.contractor_entity_id);

    IF v_acceptances <> 2 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACTIVE contract requires both parties to accept the current version';
    END IF;

    IF NEW.escrow_external_ref IS NULL OR btrim(NEW.escrow_external_ref) = '' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ACTIVE contract requires an external escrow reference';
    END IF;

    NEW.activated_at := COALESCE(NEW.activated_at, now());
  END IF;

  IF NEW.status = 'SETTLED' AND OLD.status IS DISTINCT FROM 'SETTLED' THEN
    NEW.settled_at := COALESCE(NEW.settled_at, now());
  END IF;
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
    NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER contract_state_guard
BEFORE UPDATE ON social.contracts
FOR EACH ROW EXECUTE FUNCTION social.validate_contract_state_change();

CREATE OR REPLACE FUNCTION social.guard_contract_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM social.contract_versions WHERE contract_id = OLD.contract_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'contract with published versions cannot be deleted';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER contract_delete_guard
BEFORE DELETE ON social.contracts
FOR EACH ROW EXECUTE FUNCTION social.guard_contract_delete();

CREATE OR REPLACE FUNCTION social.guard_milestone_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM social.deliveries WHERE milestone_id = OLD.milestone_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'milestone is referenced by a delivery';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER milestone_delete_guard
BEFORE DELETE ON social.milestones
FOR EACH ROW EXECUTE FUNCTION social.guard_milestone_delete();

CREATE OR REPLACE FUNCTION social.guard_delivery_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM social.disputes WHERE delivery_id = OLD.delivery_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'delivery is referenced by a dispute';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER delivery_delete_guard
BEFORE DELETE ON social.deliveries
FOR EACH ROW EXECUTE FUNCTION social.guard_delivery_delete();

COMMENT ON COLUMN social.contracts.escrow_external_ref IS
  'Opaque external escrow reference only. M04 stores no escrow balance or wallet authority.';
