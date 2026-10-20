CREATE TABLE social.cross_product_sagas (
  saga_id text PRIMARY KEY CHECK (btrim(saga_id) <> ''),
  world_id text NOT NULL CHECK (btrim(world_id) <> ''),
  contract_id uuid NOT NULL,
  contract_version integer NOT NULL CHECK (contract_version > 0),
  kind text NOT NULL CHECK (kind IN ('CONTRACT_ACTIVATION','CONTRACT_SETTLEMENT')),
  business_attempt_id text NOT NULL CHECK (btrim(business_attempt_id) <> ''),
  state text NOT NULL CHECK (state IN (
    'PENDING_REMOTE','REMOTE_SUCCEEDED','FAILED','COMPLETED',
    'COMPENSATION_PENDING','COMPENSATED','RECONCILIATION_REQUIRED'
  )),
  primary_operation_key text NOT NULL CHECK (btrim(primary_operation_key) <> ''),
  primary_payload_digest text NOT NULL CHECK (btrim(primary_payload_digest) <> ''),
  compensation_operation_key text NULL CHECK (compensation_operation_key IS NULL OR btrim(compensation_operation_key) <> ''),
  saga_snapshot jsonb NOT NULL CHECK (jsonb_typeof(saga_snapshot) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  last_error_code text NULL,
  last_error_at timestamptz NULL,
  next_reconcile_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, kind, business_attempt_id),
  UNIQUE (world_id, primary_operation_key),
  UNIQUE (world_id, compensation_operation_key)
);

CREATE UNIQUE INDEX cross_product_sagas_one_active_transition_idx
  ON social.cross_product_sagas (world_id, contract_id, contract_version, kind)
  WHERE state IN ('PENDING_REMOTE','REMOTE_SUCCEEDED','COMPENSATION_PENDING','RECONCILIATION_REQUIRED');

CREATE INDEX cross_product_sagas_recovery_idx
  ON social.cross_product_sagas (next_reconcile_at, updated_at)
  WHERE state IN ('PENDING_REMOTE','REMOTE_SUCCEEDED','COMPENSATION_PENDING','RECONCILIATION_REQUIRED');

CREATE TABLE social.cross_product_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL CHECK (btrim(world_id) <> ''),
  saga_id text NOT NULL CHECK (btrim(saga_id) <> ''),
  business_attempt_id text NOT NULL CHECK (btrim(business_attempt_id) <> ''),
  operation_key text NOT NULL CHECK (btrim(operation_key) <> ''),
  payload_digest text NOT NULL CHECK (btrim(payload_digest) <> ''),
  command_snapshot jsonb NOT NULL CHECK (jsonb_typeof(command_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','LEASED','DELIVERED','RETRY_WAIT','RECONCILIATION_REQUIRED','DEAD_LETTER')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text NULL,
  lease_until timestamptz NULL,
  last_error_code text NULL,
  delivered_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, operation_key),
  CHECK ((status = 'LEASED') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX cross_product_outbox_claim_idx
  ON social.cross_product_outbox (next_attempt_at, created_at)
  WHERE status IN ('PENDING','RETRY_WAIT');

CREATE INDEX cross_product_outbox_expired_lease_idx
  ON social.cross_product_outbox (lease_until)
  WHERE status = 'LEASED';

CREATE TABLE social.cross_product_inbox (
  inbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL CHECK (btrim(world_id) <> ''),
  operation_key text NOT NULL CHECK (btrim(operation_key) <> ''),
  payload_digest text NOT NULL CHECK (btrim(payload_digest) <> ''),
  result_snapshot jsonb NOT NULL CHECK (jsonb_typeof(result_snapshot) = 'object'),
  source_event_id text NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, operation_key)
);

CREATE OR REPLACE FUNCTION social.guard_cross_product_saga_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  saga_world text;
  saga_attempt text;
  saga_primary_key text;
  saga_compensation_key text;
BEGIN
  SELECT world_id, business_attempt_id, primary_operation_key, compensation_operation_key
    INTO saga_world, saga_attempt, saga_primary_key, saga_compensation_key
    FROM social.cross_product_sagas
   WHERE saga_id = NEW.saga_id
   FOR UPDATE;

  IF NOT FOUND OR saga_world <> NEW.world_id OR saga_attempt <> NEW.business_attempt_id THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'outbox must reference a Saga in the same world and business attempt';
  END IF;
  IF NEW.operation_key NOT IN (saga_primary_key, saga_compensation_key) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'outbox operation key must belong to its Saga';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cross_product_outbox_saga_guard
BEFORE INSERT OR UPDATE OF world_id, saga_id, business_attempt_id, operation_key
ON social.cross_product_outbox
FOR EACH ROW EXECUTE FUNCTION social.guard_cross_product_saga_outbox();

CREATE OR REPLACE FUNCTION social.reject_cross_product_saga_identity_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.saga_id IS DISTINCT FROM OLD.saga_id
     OR NEW.world_id IS DISTINCT FROM OLD.world_id
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.business_attempt_id IS DISTINCT FROM OLD.business_attempt_id
     OR NEW.primary_operation_key IS DISTINCT FROM OLD.primary_operation_key
     OR NEW.primary_payload_digest IS DISTINCT FROM OLD.primary_payload_digest THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'cross-product Saga identity and primary intent are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cross_product_saga_identity_guard
BEFORE UPDATE ON social.cross_product_sagas
FOR EACH ROW EXECUTE FUNCTION social.reject_cross_product_saga_identity_mutation();
