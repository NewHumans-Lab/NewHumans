-- P1.1 foundation hardening: database-enforced world isolation and append-only ledger.

ALTER TABLE core.entities
  DROP CONSTRAINT IF EXISTS entities_created_by_fkey,
  ADD CONSTRAINT entities_created_by_world_fkey
    FOREIGN KEY (world_id, created_by) REFERENCES core.entities(world_id, entity_id);

ALTER TABLE core.capability_grants
  DROP CONSTRAINT IF EXISTS capability_grants_grantor_entity_id_fkey,
  DROP CONSTRAINT IF EXISTS capability_grants_grantee_entity_id_fkey,
  ADD CONSTRAINT capability_grants_grantor_world_fkey
    FOREIGN KEY (world_id, grantor_entity_id) REFERENCES core.entities(world_id, entity_id),
  ADD CONSTRAINT capability_grants_grantee_world_fkey
    FOREIGN KEY (world_id, grantee_entity_id) REFERENCES core.entities(world_id, entity_id);

ALTER TABLE core.actions
  DROP CONSTRAINT IF EXISTS actions_actor_entity_id_fkey,
  ADD CONSTRAINT actions_world_action_key UNIQUE (world_id, action_id),
  ADD CONSTRAINT actions_actor_world_fkey
    FOREIGN KEY (world_id, actor_entity_id) REFERENCES core.entities(world_id, entity_id);

ALTER TABLE core.life_events
  DROP CONSTRAINT IF EXISTS life_events_actor_entity_id_fkey,
  DROP CONSTRAINT IF EXISTS life_events_action_id_fkey,
  ADD CONSTRAINT life_events_actor_world_fkey
    FOREIGN KEY (world_id, actor_entity_id) REFERENCES core.entities(world_id, entity_id),
  ADD CONSTRAINT life_events_action_world_fkey
    FOREIGN KEY (world_id, action_id) REFERENCES core.actions(world_id, action_id);

ALTER TABLE economy.wallets
  DROP CONSTRAINT IF EXISTS wallets_entity_id_fkey,
  ADD CONSTRAINT wallets_entity_world_fkey
    FOREIGN KEY (world_id, entity_id) REFERENCES core.entities(world_id, entity_id);

ALTER TABLE economy.journals
  DROP CONSTRAINT IF EXISTS journals_reversal_of_fkey,
  ADD CONSTRAINT journals_world_journal_key UNIQUE (world_id, journal_id),
  ADD CONSTRAINT journals_reversal_world_fkey
    FOREIGN KEY (world_id, reversal_of) REFERENCES economy.journals(world_id, journal_id);

ALTER TABLE economy.reservations
  DROP CONSTRAINT IF EXISTS reservations_entity_id_fkey,
  ADD CONSTRAINT reservations_entity_world_fkey
    FOREIGN KEY (world_id, entity_id) REFERENCES core.entities(world_id, entity_id);

ALTER TABLE economy.activity_subjects
  DROP CONSTRAINT IF EXISTS activity_subjects_entity_id_fkey,
  ADD CONSTRAINT activity_subjects_entity_world_fkey
    FOREIGN KEY (world_id, entity_id) REFERENCES core.entities(world_id, entity_id);

ALTER TABLE economy.activity_fees
  DROP CONSTRAINT IF EXISTS activity_fees_activity_subject_id_fkey,
  DROP CONSTRAINT IF EXISTS activity_fees_journal_id_fkey,
  ADD CONSTRAINT activity_fees_subject_world_fkey
    FOREIGN KEY (world_id, activity_subject_id) REFERENCES core.entities(world_id, entity_id),
  ADD CONSTRAINT activity_fees_journal_world_fkey
    FOREIGN KEY (world_id, journal_id) REFERENCES economy.journals(world_id, journal_id);

CREATE OR REPLACE FUNCTION economy.assert_posting_world() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_journal_world text;
  v_entity_world text;
BEGIN
  SELECT world_id INTO v_journal_world FROM economy.journals WHERE journal_id = NEW.journal_id;
  IF v_journal_world IS NULL THEN
    RAISE EXCEPTION 'journal % does not exist', NEW.journal_id USING ERRCODE = '23503';
  END IF;

  IF NEW.account_type = 'ENTITY_WALLET' THEN
    SELECT world_id INTO v_entity_world FROM core.entities WHERE entity_id = NEW.entity_id;
    IF v_entity_world IS DISTINCT FROM v_journal_world THEN
      RAISE EXCEPTION 'posting entity world % does not match journal world %', v_entity_world, v_journal_world USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS postings_world_guard ON economy.postings;
CREATE TRIGGER postings_world_guard
  BEFORE INSERT ON economy.postings
  FOR EACH ROW EXECUTE FUNCTION economy.assert_posting_world();

CREATE OR REPLACE FUNCTION economy.reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Energy ledger is append-only; create a REVERSAL journal instead' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS journals_append_only ON economy.journals;
CREATE TRIGGER journals_append_only
  BEFORE UPDATE OR DELETE ON economy.journals
  FOR EACH ROW EXECUTE FUNCTION economy.reject_ledger_mutation();

DROP TRIGGER IF EXISTS postings_append_only ON economy.postings;
CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON economy.postings
  FOR EACH ROW EXECUTE FUNCTION economy.reject_ledger_mutation();

CREATE OR REPLACE FUNCTION economy.assert_journal_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_count bigint;
  v_sum numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount_micro_e), 0)
    INTO v_count, v_sum
    FROM economy.postings
   WHERE journal_id = NEW.journal_id;

  IF v_count < 2 THEN
    RAISE EXCEPTION 'journal % must contain at least two postings', NEW.journal_id USING ERRCODE = '23514';
  END IF;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'journal % is not balanced: %', NEW.journal_id, v_sum USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journals_integrity_deferred ON economy.journals;
CREATE CONSTRAINT TRIGGER journals_integrity_deferred
  AFTER INSERT ON economy.journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION economy.assert_journal_integrity();
