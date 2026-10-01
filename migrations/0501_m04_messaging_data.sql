CREATE SCHEMA IF NOT EXISTS social;

-- NH-022 M04 Messaging data layer.
-- Identity remains authoritative in M01. Contact preferences are owned by the
-- preceding M04 Directory migration (0500). This migration intentionally has
-- no wallet, reservation, escrow, settlement, or other funding authority.

CREATE TABLE social.threads (
  world_id text NOT NULL,
  thread_id uuid NOT NULL DEFAULT gen_random_uuid(),
  schema_version text NOT NULL DEFAULT 'nh.v3.0'
    CHECK (schema_version = 'nh.v3.0'),
  thread_kind text NOT NULL DEFAULT 'DIRECT'
    CHECK (thread_kind IN ('DIRECT','GROUP','SYSTEM')),
  thread_state text NOT NULL DEFAULT 'OPEN'
    CHECK (thread_state IN ('OPEN','CLOSED','ARCHIVED')),
  created_by uuid NOT NULL,
  causation_id text NULL
    CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
  correlation_id text NOT NULL
    CHECK (length(correlation_id) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NULL,
  closed_at timestamptz NULL,
  PRIMARY KEY (world_id, thread_id),
  FOREIGN KEY (world_id, created_by)
    REFERENCES core.entities(world_id, entity_id),
  CHECK (
    (thread_state='OPEN' AND closed_at IS NULL)
    OR (thread_state IN ('CLOSED','ARCHIVED') AND closed_at IS NOT NULL)
  )
);

CREATE TRIGGER threads_version_guard
  BEFORE UPDATE ON social.threads
  FOR EACH ROW EXECUTE FUNCTION social.require_next_row_version();

CREATE TABLE social.thread_participants (
  world_id text NOT NULL,
  thread_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  participant_state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (participant_state IN ('ACTIVE','LEFT','REMOVED')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz NULL,
  PRIMARY KEY (world_id, thread_id, entity_id),
  FOREIGN KEY (world_id, thread_id)
    REFERENCES social.threads(world_id, thread_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, entity_id)
    REFERENCES core.entities(world_id, entity_id),
  CHECK (
    (participant_state='ACTIVE' AND left_at IS NULL)
    OR (participant_state IN ('LEFT','REMOVED') AND left_at IS NOT NULL)
  )
);

CREATE TABLE social.messages (
  world_id text NOT NULL,
  message_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  schema_version text NOT NULL DEFAULT 'nh.v3.0'
    CHECK (schema_version = 'nh.v3.0'),
  sender_entity_id uuid NOT NULL,
  message_type text NOT NULL
    CHECK (length(btrim(message_type)) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reply_to_message_id uuid NULL,
  causation_id text NULL
    CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
  correlation_id text NOT NULL
    CHECK (length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  content_ref text NOT NULL
    CHECK (length(content_ref) BETWEEN 1 AND 2000),
  related_goal_id uuid NULL,
  related_contract_id uuid NULL,
  idempotency_key text NOT NULL
    CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  PRIMARY KEY (world_id, message_id),
  UNIQUE (world_id, thread_id, message_id),
  UNIQUE (world_id, thread_id, message_id, sender_entity_id),
  UNIQUE (world_id, sender_entity_id, idempotency_key),
  FOREIGN KEY (world_id, thread_id)
    REFERENCES social.threads(world_id, thread_id),
  FOREIGN KEY (world_id, sender_entity_id)
    REFERENCES core.entities(world_id, entity_id),
  FOREIGN KEY (world_id, thread_id, reply_to_message_id)
    REFERENCES social.messages(world_id, thread_id, message_id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX messages_thread_time_idx
  ON social.messages(world_id, thread_id, created_at, message_id);
CREATE INDEX messages_sender_time_idx
  ON social.messages(world_id, sender_entity_id, created_at, message_id);

CREATE TABLE social.message_recipients (
  world_id text NOT NULL,
  thread_id uuid NOT NULL,
  message_id uuid NOT NULL,
  recipient_entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, thread_id, message_id, recipient_entity_id),
  FOREIGN KEY (world_id, thread_id, message_id)
    REFERENCES social.messages(world_id, thread_id, message_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id, thread_id, recipient_entity_id)
    REFERENCES social.thread_participants(world_id, thread_id, entity_id)
);

CREATE INDEX message_recipients_recipient_idx
  ON social.message_recipients(world_id, recipient_entity_id, created_at, message_id);

CREATE TABLE social.message_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  thread_id uuid NOT NULL,
  message_id uuid NOT NULL,
  schema_version text NOT NULL DEFAULT 'nh.v3.0'
    CHECK (schema_version = 'nh.v3.0'),
  sender_entity_id uuid NOT NULL,
  recipient_entity_id uuid NOT NULL,
  receipt_status text NOT NULL
    CHECK (receipt_status IN ('SENT','DELIVERED','OBSERVED','REJECTED','EXPIRED','ACCEPTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  causation_id text NULL
    CHECK (causation_id IS NULL OR length(causation_id) BETWEEN 1 AND 200),
  correlation_id text NOT NULL
    CHECK (length(correlation_id) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  accepted_target_kind text NULL,
  accepted_target_id uuid NULL,
  accepted_target_version integer NULL,
  FOREIGN KEY (world_id, thread_id, message_id, sender_entity_id)
    REFERENCES social.messages(world_id, thread_id, message_id, sender_entity_id)
    ON DELETE CASCADE,
  FOREIGN KEY (world_id, thread_id, message_id, recipient_entity_id)
    REFERENCES social.message_recipients(world_id, thread_id, message_id, recipient_entity_id)
    ON DELETE CASCADE,
  CHECK (
    (
      receipt_status='ACCEPTED'
      AND accepted_target_kind IN ('OFFER','INVITATION','CONTRACT')
      AND accepted_target_id IS NOT NULL
      AND accepted_target_version IS NOT NULL
      AND accepted_target_version > 0
    )
    OR
    (
      receipt_status<>'ACCEPTED'
      AND accepted_target_kind IS NULL
      AND accepted_target_id IS NULL
      AND accepted_target_version IS NULL
    )
  )
);

-- Delivery callbacks are idempotent by semantic state, even if an external
-- transport retries with a fresh receipt_id. Explicit ACCEPTED events are
-- idempotent by their versioned target instead of by transport state alone.
CREATE UNIQUE INDEX message_receipts_delivery_event_key
  ON social.message_receipts(world_id, message_id, recipient_entity_id, receipt_status)
  WHERE receipt_status <> 'ACCEPTED';
CREATE UNIQUE INDEX message_receipts_acceptance_event_key
  ON social.message_receipts(
    world_id,
    message_id,
    recipient_entity_id,
    receipt_status,
    accepted_target_kind,
    accepted_target_id,
    accepted_target_version
  )
  WHERE receipt_status = 'ACCEPTED';
CREATE INDEX message_receipts_recipient_time_idx
  ON social.message_receipts(world_id, recipient_entity_id, recorded_at, message_id);

-- Message delivery remains a transport/attention state. ACCEPTED is deliberately
-- ignored here: it is a separate versioned domain acceptance event and can never
-- be inferred from DELIVERED or OBSERVED.
CREATE VIEW social.message_delivery_states AS
SELECT mr.world_id,
       mr.thread_id,
       mr.message_id,
       mr.recipient_entity_id,
       CASE
         WHEN bool_or(r.receipt_status='OBSERVED') THEN 'OBSERVED'
         WHEN bool_or(r.receipt_status='REJECTED') THEN 'REJECTED'
         WHEN bool_or(r.receipt_status='EXPIRED') THEN 'EXPIRED'
         WHEN bool_or(r.receipt_status='DELIVERED') THEN 'DELIVERED'
         ELSE 'SENT'
       END AS delivery_status
  FROM social.message_recipients mr
  LEFT JOIN social.message_receipts r
    ON r.world_id=mr.world_id
   AND r.thread_id=mr.thread_id
   AND r.message_id=mr.message_id
   AND r.recipient_entity_id=mr.recipient_entity_id
 GROUP BY mr.world_id, mr.thread_id, mr.message_id, mr.recipient_entity_id;

-- Stable client-generated message_id is the primary idempotency boundary.
-- Exact replays return the original row even if the thread later closes;
-- conflicting reuse of message_id or idempotency_key is rejected.
CREATE OR REPLACE FUNCTION social.put_message(
  p_world_id text,
  p_message_id uuid,
  p_thread_id uuid,
  p_sender_entity_id uuid,
  p_recipient_entity_ids uuid[],
  p_message_type text,
  p_message_version integer,
  p_content_ref text,
  p_idempotency_key text,
  p_correlation_id text,
  p_schema_version text DEFAULT 'nh.v3.0',
  p_reply_to_message_id uuid DEFAULT NULL,
  p_causation_id text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_related_goal_id uuid DEFAULT NULL,
  p_related_contract_id uuid DEFAULT NULL,
  p_created_at timestamptz DEFAULT NULL
) RETURNS social.messages
LANGUAGE plpgsql
AS $$
DECLARE
  v_message social.messages%ROWTYPE;
  v_existing_recipients uuid[];
  v_requested_recipients uuid[];
  v_active_recipients integer;
BEGIN
  IF p_recipient_entity_ids IS NULL OR COALESCE(cardinality(p_recipient_entity_ids),0)=0 THEN
    RAISE EXCEPTION 'message requires at least one recipient' USING ERRCODE='23514';
  END IF;

  SELECT array_agg(x ORDER BY x), count(DISTINCT x)::integer
    INTO v_requested_recipients, v_active_recipients
    FROM unnest(p_recipient_entity_ids) AS x;
  IF v_active_recipients <> cardinality(p_recipient_entity_ids) THEN
    RAISE EXCEPTION 'message recipients must be unique and non-null' USING ERRCODE='23514';
  END IF;

  -- Check an existing message first so an exact replay remains valid after
  -- mutable thread/participant state changes.
  SELECT * INTO v_message
    FROM social.messages
   WHERE world_id=p_world_id AND message_id=p_message_id;
  IF FOUND THEN
    SELECT array_agg(recipient_entity_id ORDER BY recipient_entity_id)
      INTO v_existing_recipients
      FROM social.message_recipients
     WHERE world_id=p_world_id AND message_id=p_message_id;

    IF v_message.thread_id IS DISTINCT FROM p_thread_id
       OR v_message.schema_version IS DISTINCT FROM p_schema_version
       OR v_message.sender_entity_id IS DISTINCT FROM p_sender_entity_id
       OR v_message.message_type IS DISTINCT FROM p_message_type
       OR v_message.version IS DISTINCT FROM p_message_version
       OR v_message.reply_to_message_id IS DISTINCT FROM p_reply_to_message_id
       OR v_message.causation_id IS DISTINCT FROM p_causation_id
       OR v_message.correlation_id IS DISTINCT FROM p_correlation_id
       OR v_message.expires_at IS DISTINCT FROM p_expires_at
       OR v_message.content_ref IS DISTINCT FROM p_content_ref
       OR v_message.related_goal_id IS DISTINCT FROM p_related_goal_id
       OR v_message.related_contract_id IS DISTINCT FROM p_related_contract_id
       OR v_message.idempotency_key IS DISTINCT FROM p_idempotency_key
       OR (p_created_at IS NOT NULL AND v_message.created_at IS DISTINCT FROM p_created_at)
       OR v_existing_recipients IS DISTINCT FROM v_requested_recipients THEN
      RAISE EXCEPTION 'message_id reused with different immutable message content' USING ERRCODE='23505';
    END IF;
    RETURN v_message;
  END IF;

  IF EXISTS (
    SELECT 1 FROM social.messages
     WHERE world_id=p_world_id
       AND sender_entity_id=p_sender_entity_id
       AND idempotency_key=p_idempotency_key
       AND message_id<>p_message_id
  ) THEN
    RAISE EXCEPTION 'idempotency_key reused for a different message_id' USING ERRCODE='23505';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.entities
     WHERE world_id=p_world_id AND entity_id=p_sender_entity_id
  ) THEN
    RAISE EXCEPTION 'message sender does not exist in world' USING ERRCODE='23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM social.threads
     WHERE world_id=p_world_id AND thread_id=p_thread_id AND thread_state='OPEN'
  ) THEN
    RAISE EXCEPTION 'message thread is not open' USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM social.thread_participants
     WHERE world_id=p_world_id AND thread_id=p_thread_id
       AND entity_id=p_sender_entity_id AND participant_state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'message sender is not an active thread participant' USING ERRCODE='23514';
  END IF;

  SELECT count(*)::integer INTO v_active_recipients
    FROM social.thread_participants
   WHERE world_id=p_world_id AND thread_id=p_thread_id
     AND entity_id = ANY(p_recipient_entity_ids)
     AND participant_state='ACTIVE';
  IF v_active_recipients <> cardinality(p_recipient_entity_ids) THEN
    RAISE EXCEPTION 'every message recipient must be an active thread participant' USING ERRCODE='23514';
  END IF;

  INSERT INTO social.messages(
    world_id,message_id,thread_id,schema_version,sender_entity_id,message_type,version,
    reply_to_message_id,causation_id,correlation_id,created_at,expires_at,content_ref,
    related_goal_id,related_contract_id,idempotency_key
  ) VALUES (
    p_world_id,p_message_id,p_thread_id,p_schema_version,p_sender_entity_id,p_message_type,p_message_version,
    p_reply_to_message_id,p_causation_id,p_correlation_id,COALESCE(p_created_at,now()),p_expires_at,p_content_ref,
    p_related_goal_id,p_related_contract_id,p_idempotency_key
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_message;

  IF FOUND THEN
    INSERT INTO social.message_recipients(world_id,thread_id,message_id,recipient_entity_id)
    SELECT p_world_id,p_thread_id,p_message_id,x
      FROM unnest(p_recipient_entity_ids) AS x;
    RETURN v_message;
  END IF;

  -- A concurrent insert may have won either unique boundary. Resolve exact
  -- message replay; otherwise surface an idempotency conflict.
  SELECT * INTO v_message
    FROM social.messages
   WHERE world_id=p_world_id AND message_id=p_message_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'idempotency_key reused for a different message_id' USING ERRCODE='23505';
  END IF;

  SELECT array_agg(recipient_entity_id ORDER BY recipient_entity_id)
    INTO v_existing_recipients
    FROM social.message_recipients
   WHERE world_id=p_world_id AND message_id=p_message_id;

  IF v_message.thread_id IS DISTINCT FROM p_thread_id
     OR v_message.schema_version IS DISTINCT FROM p_schema_version
     OR v_message.sender_entity_id IS DISTINCT FROM p_sender_entity_id
     OR v_message.message_type IS DISTINCT FROM p_message_type
     OR v_message.version IS DISTINCT FROM p_message_version
     OR v_message.reply_to_message_id IS DISTINCT FROM p_reply_to_message_id
     OR v_message.causation_id IS DISTINCT FROM p_causation_id
     OR v_message.correlation_id IS DISTINCT FROM p_correlation_id
     OR v_message.expires_at IS DISTINCT FROM p_expires_at
     OR v_message.content_ref IS DISTINCT FROM p_content_ref
     OR v_message.related_goal_id IS DISTINCT FROM p_related_goal_id
     OR v_message.related_contract_id IS DISTINCT FROM p_related_contract_id
     OR v_message.idempotency_key IS DISTINCT FROM p_idempotency_key
     OR (p_created_at IS NOT NULL AND v_message.created_at IS DISTINCT FROM p_created_at)
     OR v_existing_recipients IS DISTINCT FROM v_requested_recipients THEN
    RAISE EXCEPTION 'message_id reused with different immutable message content' USING ERRCODE='23505';
  END IF;

  RETURN v_message;
END $$;

-- Receipt recording is append-only and retry-safe. Ordinary delivery states are
-- semantically idempotent. ACCEPTED is allowed only for an explicit versioned
-- OFFER / INVITATION / CONTRACT target; it has no funding side effect here.
CREATE OR REPLACE FUNCTION social.record_message_receipt(
  p_world_id text,
  p_receipt_id uuid,
  p_message_id uuid,
  p_recipient_entity_id uuid,
  p_receipt_status text,
  p_receipt_version integer,
  p_correlation_id text,
  p_causation_id text DEFAULT NULL,
  p_recorded_at timestamptz DEFAULT NULL,
  p_accepted_target_kind text DEFAULT NULL,
  p_accepted_target_id uuid DEFAULT NULL,
  p_accepted_target_version integer DEFAULT NULL,
  p_schema_version text DEFAULT 'nh.v3.0'
) RETURNS social.message_receipts
LANGUAGE plpgsql
AS $$
DECLARE
  v_thread_id uuid;
  v_sender_entity_id uuid;
  v_receipt social.message_receipts%ROWTYPE;
BEGIN
  IF p_receipt_status NOT IN ('SENT','DELIVERED','OBSERVED','REJECTED','EXPIRED','ACCEPTED') THEN
    RAISE EXCEPTION 'invalid message receipt status: %', p_receipt_status USING ERRCODE='23514';
  END IF;

  IF p_receipt_status='ACCEPTED' THEN
    IF p_accepted_target_kind NOT IN ('OFFER','INVITATION','CONTRACT')
       OR p_accepted_target_id IS NULL
       OR p_accepted_target_version IS NULL
       OR p_accepted_target_version <= 0 THEN
      RAISE EXCEPTION 'ACCEPTED requires a versioned OFFER, INVITATION, or CONTRACT target' USING ERRCODE='23514';
    END IF;
  ELSIF p_accepted_target_kind IS NOT NULL
        OR p_accepted_target_id IS NOT NULL
        OR p_accepted_target_version IS NOT NULL THEN
    RAISE EXCEPTION 'delivery/read receipts cannot carry an accepted target' USING ERRCODE='23514';
  END IF;

  SELECT * INTO v_receipt
    FROM social.message_receipts
   WHERE receipt_id=p_receipt_id;
  IF FOUND THEN
    IF v_receipt.world_id IS DISTINCT FROM p_world_id
       OR v_receipt.message_id IS DISTINCT FROM p_message_id
       OR v_receipt.recipient_entity_id IS DISTINCT FROM p_recipient_entity_id
       OR v_receipt.receipt_status IS DISTINCT FROM p_receipt_status
       OR v_receipt.version IS DISTINCT FROM p_receipt_version
       OR v_receipt.causation_id IS DISTINCT FROM p_causation_id
       OR v_receipt.correlation_id IS DISTINCT FROM p_correlation_id
       OR v_receipt.accepted_target_kind IS DISTINCT FROM p_accepted_target_kind
       OR v_receipt.accepted_target_id IS DISTINCT FROM p_accepted_target_id
       OR v_receipt.accepted_target_version IS DISTINCT FROM p_accepted_target_version
       OR v_receipt.schema_version IS DISTINCT FROM p_schema_version
       OR (p_recorded_at IS NOT NULL AND v_receipt.recorded_at IS DISTINCT FROM p_recorded_at) THEN
      RAISE EXCEPTION 'receipt_id reused with different immutable receipt content' USING ERRCODE='23505';
    END IF;
    RETURN v_receipt;
  END IF;

  SELECT m.thread_id, m.sender_entity_id
    INTO v_thread_id, v_sender_entity_id
    FROM social.message_recipients mr
    JOIN social.messages m
      ON m.world_id=mr.world_id
     AND m.thread_id=mr.thread_id
     AND m.message_id=mr.message_id
   WHERE mr.world_id=p_world_id
     AND mr.message_id=p_message_id
     AND mr.recipient_entity_id=p_recipient_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message recipient does not exist' USING ERRCODE='23503';
  END IF;

  IF p_receipt_status='ACCEPTED' THEN
    SELECT * INTO v_receipt
      FROM social.message_receipts
     WHERE world_id=p_world_id
       AND message_id=p_message_id
       AND recipient_entity_id=p_recipient_entity_id
       AND receipt_status='ACCEPTED'
       AND accepted_target_kind=p_accepted_target_kind
       AND accepted_target_id=p_accepted_target_id
       AND accepted_target_version=p_accepted_target_version;
  ELSE
    SELECT * INTO v_receipt
      FROM social.message_receipts
     WHERE world_id=p_world_id
       AND message_id=p_message_id
       AND recipient_entity_id=p_recipient_entity_id
       AND receipt_status=p_receipt_status;
  END IF;
  IF FOUND THEN
    RETURN v_receipt;
  END IF;

  INSERT INTO social.message_receipts(
    receipt_id,world_id,thread_id,message_id,schema_version,sender_entity_id,
    recipient_entity_id,receipt_status,version,causation_id,correlation_id,recorded_at,
    accepted_target_kind,accepted_target_id,accepted_target_version
  ) VALUES (
    p_receipt_id,p_world_id,v_thread_id,p_message_id,p_schema_version,v_sender_entity_id,
    p_recipient_entity_id,p_receipt_status,p_receipt_version,p_causation_id,p_correlation_id,
    COALESCE(p_recorded_at,now()),p_accepted_target_kind,p_accepted_target_id,p_accepted_target_version
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_receipt;

  IF FOUND THEN
    RETURN v_receipt;
  END IF;

  -- Resolve a concurrent semantic duplicate first.
  IF p_receipt_status='ACCEPTED' THEN
    SELECT * INTO v_receipt
      FROM social.message_receipts
     WHERE world_id=p_world_id
       AND message_id=p_message_id
       AND recipient_entity_id=p_recipient_entity_id
       AND receipt_status='ACCEPTED'
       AND accepted_target_kind=p_accepted_target_kind
       AND accepted_target_id=p_accepted_target_id
       AND accepted_target_version=p_accepted_target_version;
  ELSE
    SELECT * INTO v_receipt
      FROM social.message_receipts
     WHERE world_id=p_world_id
       AND message_id=p_message_id
       AND recipient_entity_id=p_recipient_entity_id
       AND receipt_status=p_receipt_status;
  END IF;
  IF FOUND THEN
    RETURN v_receipt;
  END IF;

  RAISE EXCEPTION 'receipt_id reused with different immutable receipt content' USING ERRCODE='23505';
END $$;
