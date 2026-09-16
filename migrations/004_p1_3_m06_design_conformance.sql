-- P1.3: encode the V3 PRIMARY/AUXILIARY inference purpose boundary in storage.
-- NOT VALID preserves compatibility with any pre-existing development rows while
-- enforcing the constraint for every new or updated execution after this migration.
ALTER TABLE gateway.executions
  ADD CONSTRAINT executions_action_purpose_check
  CHECK (action_purpose IN ('PRIMARY_INFERENCE','AUXILIARY_INFERENCE')) NOT VALID;
