-- P1.4 final contract closure: trusted world context, quotes, cancel/receipt APIs, retry semantics.

CREATE TABLE economy.resource_quotes (
  quote_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  payer_entity_id uuid NOT NULL,
  activity_subject_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('MODEL_INFERENCE')),
  resource_ref uuid NOT NULL,
  rate_version text NOT NULL,
  input_rate_micro_e_per_million bigint NOT NULL CHECK (input_rate_micro_e_per_million >= 0),
  output_rate_micro_e_per_million bigint NOT NULL CHECK (output_rate_micro_e_per_million >= 0),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
  max_cost_micro_e bigint NOT NULL CHECK (max_cost_micro_e >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESERVED','CONSUMED','CANCELLED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, quote_id),
  FOREIGN KEY (world_id, payer_entity_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, activity_subject_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, resource_ref) REFERENCES gateway.capability_descriptors(world_id, descriptor_id)
);
CREATE INDEX resource_quotes_payer_time_idx ON economy.resource_quotes(world_id, payer_entity_id, created_at DESC);

ALTER TABLE economy.reservations
  ADD COLUMN quote_id uuid NULL,
  ADD CONSTRAINT reservations_quote_world_fkey
    FOREIGN KEY (world_id, quote_id) REFERENCES economy.resource_quotes(world_id, quote_id);
CREATE UNIQUE INDEX reservations_one_per_quote_idx ON economy.reservations(world_id, quote_id) WHERE quote_id IS NOT NULL;

ALTER TABLE gateway.executions
  ADD COLUMN quote_id uuid NULL,
  ADD CONSTRAINT executions_quote_world_fkey
    FOREIGN KEY (world_id, quote_id) REFERENCES economy.resource_quotes(world_id, quote_id);

-- Keep max_attempts as a legacy compatibility column because P1.2/P1.3 code reads it,
-- while max_retries is the canonical V3 contract from P1.4 onward.
ALTER TABLE gateway.capability_descriptors ADD COLUMN max_retries integer;
UPDATE gateway.capability_descriptors SET max_retries = GREATEST(max_attempts - 1, 0);
ALTER TABLE gateway.capability_descriptors
  ALTER COLUMN max_retries SET NOT NULL,
  ALTER COLUMN max_retries SET DEFAULT 0,
  ADD CONSTRAINT capability_descriptors_max_retries_check CHECK (max_retries BETWEEN 0 AND 3),
  DROP CONSTRAINT IF EXISTS capability_descriptors_max_attempts_check,
  ADD CONSTRAINT capability_descriptors_max_attempts_check CHECK (max_attempts BETWEEN 1 AND 4);

CREATE OR REPLACE FUNCTION gateway.sync_retry_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Legacy writers set max_attempts; canonical P1.4 writers set both consistently.
  IF NEW.max_attempts IS NULL THEN NEW.max_attempts := NEW.max_retries + 1; END IF;
  IF NEW.max_retries IS NULL OR NEW.max_attempts <> NEW.max_retries + 1 THEN
    NEW.max_retries := NEW.max_attempts - 1;
  END IF;
  IF NEW.max_retries < 0 OR NEW.max_retries > 3 OR NEW.max_attempts <> NEW.max_retries + 1 THEN
    RAISE EXCEPTION 'invalid retry contract';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capability_descriptors_retry_sync ON gateway.capability_descriptors;
CREATE TRIGGER capability_descriptors_retry_sync
  BEFORE INSERT OR UPDATE OF max_attempts, max_retries ON gateway.capability_descriptors
  FOR EACH ROW EXECUTE FUNCTION gateway.sync_retry_contract();

ALTER TABLE gateway.execution_attempts
  DROP CONSTRAINT IF EXISTS execution_attempts_attempt_no_check,
  ADD CONSTRAINT execution_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 4);

CREATE OR REPLACE FUNCTION gateway.bind_execution_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_quote uuid;
BEGIN
  IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
  SELECT quote_id INTO v_quote FROM economy.reservations
   WHERE world_id=NEW.world_id AND reservation_id=NEW.reservation_id;
  IF NEW.quote_id IS NOT NULL AND v_quote IS DISTINCT FROM NEW.quote_id THEN
    RAISE EXCEPTION 'execution quote does not match reservation quote' USING ERRCODE='23514';
  END IF;
  NEW.quote_id := COALESCE(NEW.quote_id, v_quote);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS executions_bind_quote ON gateway.executions;
CREATE TRIGGER executions_bind_quote BEFORE INSERT ON gateway.executions
  FOR EACH ROW EXECUTE FUNCTION gateway.bind_execution_quote();

CREATE OR REPLACE FUNCTION economy.sync_quote_reservation_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quote_id IS NULL OR NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status='SETTLED' THEN
    UPDATE economy.resource_quotes SET status='CONSUMED' WHERE world_id=NEW.world_id AND quote_id=NEW.quote_id AND status='RESERVED';
  ELSIF NEW.status='RELEASED' THEN
    UPDATE economy.resource_quotes SET status='CANCELLED' WHERE world_id=NEW.world_id AND quote_id=NEW.quote_id AND status='RESERVED';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reservations_sync_quote_status ON economy.reservations;
CREATE TRIGGER reservations_sync_quote_status AFTER UPDATE OF status ON economy.reservations
  FOR EACH ROW EXECUTE FUNCTION economy.sync_quote_reservation_status();

-- Defense-in-depth: a quote-backed execution revalidates the quote/reservation link
-- and expiry on every provider request insertion, including retries.
CREATE OR REPLACE FUNCTION gateway.assert_quote_dispatchable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e gateway.executions%ROWTYPE; q economy.resource_quotes%ROWTYPE; r economy.reservations%ROWTYPE;
BEGIN
  SELECT * INTO e FROM gateway.executions WHERE world_id=NEW.world_id AND execution_id=NEW.execution_id;
  IF e.quote_id IS NULL THEN RETURN NEW; END IF; -- grandfathered P1.3 internal execution
  SELECT * INTO q FROM economy.resource_quotes WHERE world_id=e.world_id AND quote_id=e.quote_id;
  SELECT * INTO r FROM economy.reservations WHERE world_id=e.world_id AND reservation_id=e.reservation_id;
  IF q.quote_id IS NULL OR r.reservation_id IS NULL OR q.status <> 'RESERVED' OR r.status <> 'ACTIVE'
     OR r.quote_id IS DISTINCT FROM q.quote_id OR q.expires_at <= now()
     OR q.payer_entity_id <> e.payer_entity_id OR q.activity_subject_id <> e.activity_subject_id
     OR q.resource_ref <> e.descriptor_id THEN
    RAISE EXCEPTION 'quote is not dispatchable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS provider_requests_quote_guard ON gateway.provider_requests;
CREATE TRIGGER provider_requests_quote_guard BEFORE INSERT ON gateway.provider_requests
  FOR EACH ROW EXECUTE FUNCTION gateway.assert_quote_dispatchable();
