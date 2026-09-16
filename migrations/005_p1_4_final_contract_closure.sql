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

CREATE UNIQUE INDEX reservations_one_per_quote_idx
  ON economy.reservations(world_id, quote_id)
  WHERE quote_id IS NOT NULL;

ALTER TABLE gateway.executions
  ADD COLUMN quote_id uuid NULL,
  ADD CONSTRAINT executions_quote_world_fkey
    FOREIGN KEY (world_id, quote_id) REFERENCES economy.resource_quotes(world_id, quote_id);

ALTER TABLE gateway.capability_descriptors
  ADD COLUMN max_retries integer;

UPDATE gateway.capability_descriptors
   SET max_retries = GREATEST(max_attempts - 1, 0);

ALTER TABLE gateway.capability_descriptors
  ALTER COLUMN max_retries SET NOT NULL,
  ALTER COLUMN max_retries SET DEFAULT 0,
  ADD CONSTRAINT capability_descriptors_max_retries_check CHECK (max_retries BETWEEN 0 AND 3),
  DROP COLUMN max_attempts;

ALTER TABLE gateway.execution_attempts
  DROP CONSTRAINT IF EXISTS execution_attempts_attempt_no_check,
  ADD CONSTRAINT execution_attempts_attempt_no_check CHECK (attempt_no BETWEEN 1 AND 4);
