-- P1.2: minimum M06 model gateway and usage/settlement chain.
CREATE SCHEMA IF NOT EXISTS gateway;

ALTER TABLE core.actions
  DROP CONSTRAINT IF EXISTS actions_status_check,
  ADD CONSTRAINT actions_status_check CHECK (status IN ('PENDING','DISPATCHED','SUCCEEDED','FAILED','OUTCOME_UNKNOWN','CANCELLED'));

ALTER TABLE economy.journals
  DROP CONSTRAINT IF EXISTS journals_journal_type_check,
  ADD CONSTRAINT journals_journal_type_check CHECK (journal_type IN ('MINT','TRANSFER','DAILY_ACTIVITY_FEE','RESOURCE_CHARGE','REVERSAL'));

ALTER TABLE economy.reservations
  ADD COLUMN IF NOT EXISTS settled_amount_micro_e bigint NULL CHECK (settled_amount_micro_e IS NULL OR settled_amount_micro_e >= 0),
  ADD COLUMN IF NOT EXISTS settlement_journal_id uuid NULL,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz NULL,
  ADD CONSTRAINT reservations_world_reservation_key UNIQUE (world_id, reservation_id),
  ADD CONSTRAINT reservations_settlement_journal_world_fkey
    FOREIGN KEY (world_id, settlement_journal_id) REFERENCES economy.journals(world_id, journal_id);

CREATE TABLE gateway.capability_descriptors (
  descriptor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  descriptor_key text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  capability_type text NOT NULL CHECK (capability_type IN ('MODEL_INFERENCE')),
  provider_protocol text NOT NULL CHECK (provider_protocol IN ('OPENAI_COMPATIBLE')),
  model_reference text NOT NULL,
  assurance_level text NOT NULL DEFAULT 'UNVERIFIED' CHECK (assurance_level IN ('ARTIFACT_VERIFIED','PROVIDER_ATTESTED','UNVERIFIED')),
  verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','PROTOCOL_TESTED','REAL_PROVIDER_VERIFIED')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 100 AND 300000),
  max_attempts integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 3),
  supports_idempotency boolean NOT NULL DEFAULT false,
  supports_reconciliation boolean NOT NULL DEFAULT false,
  input_rate_micro_e_per_million bigint NOT NULL DEFAULT 0 CHECK (input_rate_micro_e_per_million >= 0),
  output_rate_micro_e_per_million bigint NOT NULL DEFAULT 0 CHECK (output_rate_micro_e_per_million >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, descriptor_key, version),
  UNIQUE (world_id, descriptor_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE gateway.credential_refs (
  credential_ref_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  env_key text NOT NULL CHECK (env_key ~ '^[A-Z][A-Z0-9_]{1,127}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, env_key),
  UNIQUE (world_id, credential_ref_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE gateway.connector_configs (
  connector_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  descriptor_id uuid NOT NULL,
  connector_kind text NOT NULL CHECK (connector_kind IN ('CLOUD','LOCAL_SELF_HOSTED')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('PLATFORM_PREPAID','BYOK')),
  base_url text NOT NULL,
  credential_ref_id uuid NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, connector_id),
  UNIQUE (world_id, descriptor_id, connector_kind, base_url),
  FOREIGN KEY (world_id, descriptor_id) REFERENCES gateway.capability_descriptors(world_id, descriptor_id),
  FOREIGN KEY (world_id, credential_ref_id) REFERENCES gateway.credential_refs(world_id, credential_ref_id),
  FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id)
);

CREATE TABLE gateway.executions (
  execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  action_id uuid NOT NULL,
  activity_subject_id uuid NOT NULL,
  payer_entity_id uuid NOT NULL,
  descriptor_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  reservation_id uuid NULL,
  billing_date date NOT NULL,
  action_purpose text NOT NULL,
  input_digest text NOT NULL CHECK (length(input_digest) = 64),
  max_charge_micro_e bigint NOT NULL CHECK (max_charge_micro_e >= 0),
  final_charge_micro_e bigint NULL CHECK (final_charge_micro_e IS NULL OR final_charge_micro_e >= 0),
  status text NOT NULL CHECK (status IN ('PROPOSED','DISPATCHED','SUCCEEDED','FAILED','OUTCOME_UNKNOWN','CANCELLED')),
  provider_request_id text NULL,
  result_json jsonb NULL,
  error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (world_id, execution_id),
  UNIQUE (world_id, action_id),
  FOREIGN KEY (world_id, action_id) REFERENCES core.actions(world_id, action_id),
  FOREIGN KEY (world_id, activity_subject_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, payer_entity_id) REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, descriptor_id) REFERENCES gateway.capability_descriptors(world_id, descriptor_id),
  FOREIGN KEY (world_id, connector_id) REFERENCES gateway.connector_configs(world_id, connector_id),
  FOREIGN KEY (world_id, reservation_id) REFERENCES economy.reservations(world_id, reservation_id),
  FOREIGN KEY (world_id, activity_subject_id, billing_date)
    REFERENCES economy.activity_fees(world_id, activity_subject_id, billing_date)
);
CREATE INDEX executions_subject_time_idx ON gateway.executions(world_id, activity_subject_id, created_at DESC);

CREATE TABLE gateway.execution_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  execution_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED','OUTCOME_UNKNOWN')),
  http_status integer NULL,
  error_class text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (world_id, attempt_id),
  UNIQUE (world_id, execution_id, attempt_no),
  FOREIGN KEY (world_id, execution_id) REFERENCES gateway.executions(world_id, execution_id)
);

CREATE TABLE gateway.provider_requests (
  provider_request_row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  execution_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  provider_idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('DISPATCHED','SUCCEEDED','FAILED','OUTCOME_UNKNOWN')),
  provider_request_id text NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (world_id, provider_request_row_id),
  UNIQUE (world_id, attempt_id),
  FOREIGN KEY (world_id, execution_id) REFERENCES gateway.executions(world_id, execution_id),
  FOREIGN KEY (world_id, attempt_id) REFERENCES gateway.execution_attempts(world_id, attempt_id)
);

CREATE TABLE gateway.usage_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  execution_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  provider_request_id text NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
  charge_micro_e bigint NOT NULL CHECK (charge_micro_e >= 0),
  external_billing boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('FINAL','ESTIMATED')),
  raw_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id, receipt_id),
  UNIQUE (world_id, execution_id, status),
  FOREIGN KEY (world_id, execution_id) REFERENCES gateway.executions(world_id, execution_id),
  FOREIGN KEY (world_id, attempt_id) REFERENCES gateway.execution_attempts(world_id, attempt_id)
);

CREATE TABLE gateway.reconciliation_jobs (
  reconciliation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  execution_id uuid NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED','BLOCKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  UNIQUE (world_id, execution_id),
  FOREIGN KEY (world_id, execution_id) REFERENCES gateway.executions(world_id, execution_id)
);
