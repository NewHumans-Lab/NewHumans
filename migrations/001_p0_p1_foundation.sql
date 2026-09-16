CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS economy;

CREATE TABLE core.entities (
  entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('HUMAN','AGENT','COMPANY','ORGANIZATION','SYSTEM')),
  display_id text NOT NULL,
  name text NOT NULL,
  created_by uuid NULL REFERENCES core.entities(entity_id),
  origin text NOT NULL DEFAULT 'LOCAL',
  created_at timestamptz NOT NULL DEFAULT now(),
  identity_status text NOT NULL DEFAULT 'ACTIVE' CHECK (identity_status IN ('ACTIVE','SUSPENDED','RETIRED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (world_id, display_id),
  UNIQUE (world_id, entity_id)
);
CREATE TABLE core.capability_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), world_id text NOT NULL,
  grantor_entity_id uuid NOT NULL REFERENCES core.entities(entity_id), grantee_entity_id uuid NOT NULL REFERENCES core.entities(entity_id),
  actions text[] NOT NULL, object_scope jsonb NOT NULL DEFAULT '{}'::jsonb, max_amount_micro_e bigint NULL CHECK (max_amount_micro_e IS NULL OR max_amount_micro_e >= 0),
  valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz NULL, revoked_at timestamptz NULL, version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE INDEX capability_grants_grantee_idx ON core.capability_grants(world_id, grantee_entity_id) WHERE revoked_at IS NULL;
CREATE TABLE core.actions (
  action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), world_id text NOT NULL, actor_entity_id uuid NOT NULL REFERENCES core.entities(entity_id), action_type text NOT NULL,
  idempotency_key text NOT NULL, payload_hash text NOT NULL CHECK (length(payload_hash)=64), status text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  result_json jsonb NULL, error_code text NULL, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NULL,
  UNIQUE (world_id, actor_entity_id, idempotency_key)
);
CREATE TABLE core.life_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), world_id text NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL, aggregate_seq bigint NOT NULL CHECK (aggregate_seq > 0),
  event_type text NOT NULL, actor_entity_id uuid NULL REFERENCES core.entities(entity_id), action_id uuid NULL REFERENCES core.actions(action_id), payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (world_id, aggregate_type, aggregate_id, aggregate_seq)
);
CREATE INDEX life_events_world_time_idx ON core.life_events(world_id, created_at, event_id);
CREATE TABLE core.outbox (outbox_id bigserial PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES core.life_events(event_id), topic text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz NULL);
CREATE TABLE core.consumer_receipts (consumer_name text NOT NULL, event_id uuid NOT NULL REFERENCES core.life_events(event_id), processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer_name, event_id));

CREATE TABLE economy.wallets (
  world_id text NOT NULL, entity_id uuid NOT NULL REFERENCES core.entities(entity_id), posted_balance_micro_e bigint NOT NULL DEFAULT 0 CHECK (posted_balance_micro_e >= 0),
  frozen_micro_e bigint NOT NULL DEFAULT 0 CHECK (frozen_micro_e >= 0), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (world_id, entity_id)
);
CREATE TABLE economy.journals (
  journal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), world_id text NOT NULL, business_key text NOT NULL,
  journal_type text NOT NULL CHECK (journal_type IN ('MINT','TRANSFER','DAILY_ACTIVITY_FEE','REVERSAL')), reversal_of uuid NULL REFERENCES economy.journals(journal_id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (world_id, business_key)
);
CREATE TABLE economy.postings (
  posting_id bigserial PRIMARY KEY, journal_id uuid NOT NULL REFERENCES economy.journals(journal_id) ON DELETE RESTRICT, account_type text NOT NULL CHECK (account_type IN ('ENTITY_WALLET','SYSTEM')),
  entity_id uuid NULL REFERENCES core.entities(entity_id), system_account text NULL, amount_micro_e bigint NOT NULL CHECK (amount_micro_e <> 0), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((account_type='ENTITY_WALLET' AND entity_id IS NOT NULL AND system_account IS NULL) OR (account_type='SYSTEM' AND entity_id IS NULL AND system_account IS NOT NULL))
);
CREATE INDEX postings_journal_idx ON economy.postings(journal_id); CREATE INDEX postings_entity_idx ON economy.postings(entity_id) WHERE entity_id IS NOT NULL;
CREATE TABLE economy.reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), world_id text NOT NULL, entity_id uuid NOT NULL REFERENCES core.entities(entity_id), business_key text NOT NULL,
  amount_micro_e bigint NOT NULL CHECK (amount_micro_e > 0), status text NOT NULL CHECK (status IN ('ACTIVE','SETTLED','RELEASED')), created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz NULL,
  UNIQUE (world_id, entity_id, business_key)
);
CREATE INDEX reservations_active_wallet_idx ON economy.reservations(world_id, entity_id) WHERE status='ACTIVE';
CREATE TABLE economy.activity_subjects (world_id text NOT NULL, entity_id uuid NOT NULL REFERENCES core.entities(entity_id), first_activated_at timestamptz NULL, PRIMARY KEY (world_id, entity_id));
CREATE TABLE economy.activity_fees (
  world_id text NOT NULL, activity_subject_id uuid NOT NULL REFERENCES core.entities(entity_id), billing_date date NOT NULL, amount_micro_e bigint NOT NULL CHECK (amount_micro_e > 0),
  journal_id uuid NOT NULL UNIQUE REFERENCES economy.journals(journal_id), rule_version text NOT NULL, status text NOT NULL DEFAULT 'CHARGED' CHECK (status IN ('CHARGED','REVERSED')), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, activity_subject_id, billing_date)
);

CREATE OR REPLACE FUNCTION economy.apply_wallet_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_world_id text;
BEGIN
  IF NEW.account_type <> 'ENTITY_WALLET' THEN RETURN NEW; END IF;
  SELECT world_id INTO v_world_id FROM economy.journals WHERE journal_id = NEW.journal_id;
  UPDATE economy.wallets SET posted_balance_micro_e = posted_balance_micro_e + NEW.amount_micro_e, updated_at = now() WHERE world_id = v_world_id AND entity_id = NEW.entity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet missing for entity %', NEW.entity_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postings_apply_wallet AFTER INSERT ON economy.postings FOR EACH ROW EXECUTE FUNCTION economy.apply_wallet_posting();

CREATE OR REPLACE FUNCTION economy.assert_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_journal uuid := COALESCE(NEW.journal_id, OLD.journal_id); v_sum numeric;
BEGIN
  SELECT COALESCE(SUM(amount_micro_e),0) INTO v_sum FROM economy.postings WHERE journal_id=v_journal;
  IF v_sum <> 0 THEN RAISE EXCEPTION 'journal % is not balanced: %', v_journal, v_sum; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER postings_journal_balanced AFTER INSERT OR UPDATE OR DELETE ON economy.postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION economy.assert_balanced_journal();

CREATE OR REPLACE VIEW economy.wallet_balances AS
SELECT w.world_id,w.entity_id,w.posted_balance_micro_e,w.frozen_micro_e,COALESCE(r.reserved_micro_e,0)::bigint AS reserved_micro_e,
       (w.posted_balance_micro_e-w.frozen_micro_e-COALESCE(r.reserved_micro_e,0))::bigint AS available_micro_e
FROM economy.wallets w LEFT JOIN (
  SELECT world_id,entity_id,SUM(amount_micro_e)::bigint AS reserved_micro_e FROM economy.reservations WHERE status='ACTIVE' GROUP BY world_id,entity_id
) r USING (world_id,entity_id);
