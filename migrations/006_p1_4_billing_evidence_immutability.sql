-- P1.4 post-merge audit hardening: accepted quote terms and billing authority fields must not drift.

CREATE OR REPLACE FUNCTION gateway.reject_descriptor_contract_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.descriptor_key IS DISTINCT FROM NEW.descriptor_key
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.capability_type IS DISTINCT FROM NEW.capability_type
     OR OLD.provider_protocol IS DISTINCT FROM NEW.provider_protocol
     OR OLD.model_reference IS DISTINCT FROM NEW.model_reference
     OR OLD.max_input_tokens IS DISTINCT FROM NEW.max_input_tokens
     OR OLD.max_output_tokens IS DISTINCT FROM NEW.max_output_tokens
     OR OLD.timeout_ms IS DISTINCT FROM NEW.timeout_ms
     OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
     OR OLD.max_retries IS DISTINCT FROM NEW.max_retries
     OR OLD.supports_idempotency IS DISTINCT FROM NEW.supports_idempotency
     OR OLD.supports_reconciliation IS DISTINCT FROM NEW.supports_reconciliation
     OR OLD.input_rate_micro_e_per_million IS DISTINCT FROM NEW.input_rate_micro_e_per_million
     OR OLD.output_rate_micro_e_per_million IS DISTINCT FROM NEW.output_rate_micro_e_per_million
     OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'capability descriptor contract fields are immutable; create a new descriptor version'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS capability_descriptors_contract_immutable ON gateway.capability_descriptors;
CREATE TRIGGER capability_descriptors_contract_immutable
  BEFORE UPDATE ON gateway.capability_descriptors
  FOR EACH ROW EXECUTE FUNCTION gateway.reject_descriptor_contract_mutation();

CREATE OR REPLACE FUNCTION economy.enforce_resource_quote_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.world_id IS DISTINCT FROM NEW.world_id
     OR OLD.payer_entity_id IS DISTINCT FROM NEW.payer_entity_id
     OR OLD.activity_subject_id IS DISTINCT FROM NEW.activity_subject_id
     OR OLD.resource_kind IS DISTINCT FROM NEW.resource_kind
     OR OLD.resource_ref IS DISTINCT FROM NEW.resource_ref
     OR OLD.rate_version IS DISTINCT FROM NEW.rate_version
     OR OLD.input_rate_micro_e_per_million IS DISTINCT FROM NEW.input_rate_micro_e_per_million
     OR OLD.output_rate_micro_e_per_million IS DISTINCT FROM NEW.output_rate_micro_e_per_million
     OR OLD.max_input_tokens IS DISTINCT FROM NEW.max_input_tokens
     OR OLD.max_output_tokens IS DISTINCT FROM NEW.max_output_tokens
     OR OLD.max_cost_micro_e IS DISTINCT FROM NEW.max_cost_micro_e
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'accepted resource quote terms are immutable' USING ERRCODE='55000';
  END IF;

  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF OLD.status='ACTIVE' AND NEW.status IN ('RESERVED','CANCELLED','EXPIRED') THEN RETURN NEW; END IF;
  IF OLD.status='RESERVED' AND NEW.status IN ('CONSUMED','CANCELLED','EXPIRED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid resource quote status transition % -> %', OLD.status, NEW.status USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS resource_quotes_terms_immutable ON economy.resource_quotes;
CREATE TRIGGER resource_quotes_terms_immutable
  BEFORE UPDATE ON economy.resource_quotes
  FOR EACH ROW EXECUTE FUNCTION economy.enforce_resource_quote_immutability();

CREATE OR REPLACE FUNCTION economy.reject_reservation_quote_rebind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.quote_id IS NOT NULL AND NEW.quote_id IS DISTINCT FROM OLD.quote_id THEN
    RAISE EXCEPTION 'reservation quote binding is immutable once assigned' USING ERRCODE='55000';
  END IF;
  IF OLD.quote_id IS NULL AND NEW.quote_id IS NOT NULL AND OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'only an active legacy reservation may receive its first quote binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reservations_quote_binding_immutable ON economy.reservations;
CREATE TRIGGER reservations_quote_binding_immutable
  BEFORE UPDATE OF quote_id ON economy.reservations
  FOR EACH ROW EXECUTE FUNCTION economy.reject_reservation_quote_rebind();

CREATE OR REPLACE FUNCTION gateway.reject_execution_authority_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.world_id IS DISTINCT FROM NEW.world_id
     OR OLD.action_id IS DISTINCT FROM NEW.action_id
     OR OLD.activity_subject_id IS DISTINCT FROM NEW.activity_subject_id
     OR OLD.payer_entity_id IS DISTINCT FROM NEW.payer_entity_id
     OR OLD.descriptor_id IS DISTINCT FROM NEW.descriptor_id
     OR OLD.connector_id IS DISTINCT FROM NEW.connector_id
     OR OLD.reservation_id IS DISTINCT FROM NEW.reservation_id
     OR OLD.quote_id IS DISTINCT FROM NEW.quote_id
     OR OLD.billing_date IS DISTINCT FROM NEW.billing_date
     OR OLD.action_purpose IS DISTINCT FROM NEW.action_purpose
     OR OLD.input_digest IS DISTINCT FROM NEW.input_digest
     OR OLD.max_charge_micro_e IS DISTINCT FROM NEW.max_charge_micro_e
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'execution authority/billing scope is immutable after creation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS executions_authority_immutable ON gateway.executions;
CREATE TRIGGER executions_authority_immutable
  BEFORE UPDATE ON gateway.executions
  FOR EACH ROW EXECUTE FUNCTION gateway.reject_execution_authority_mutation();

CREATE OR REPLACE FUNCTION gateway.reject_usage_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage receipts are append-only evidence' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS usage_receipts_append_only ON gateway.usage_receipts;
CREATE TRIGGER usage_receipts_append_only
  BEFORE UPDATE OR DELETE ON gateway.usage_receipts
  FOR EACH ROW EXECUTE FUNCTION gateway.reject_usage_receipt_mutation();
