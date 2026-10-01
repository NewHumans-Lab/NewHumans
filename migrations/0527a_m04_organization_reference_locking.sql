-- NH-027 follow-up within the same migration slot.
-- Hold a key-share lock while validating M01 Entity references so concurrent
-- Entity deletion/key changes cannot race an Organization insert into an orphan.

CREATE OR REPLACE FUNCTION social.assert_organization_entity_ref(
  p_world_id text,
  p_entity_id uuid,
  p_label text,
  p_allowed_types text[] DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  entity_kind text;
BEGIN
  SELECT entity_type INTO entity_kind
    FROM core.entities
   WHERE world_id = p_world_id AND entity_id = p_entity_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% must reference an existing M01 Entity in the same world', p_label
      USING ERRCODE='23503';
  END IF;
  IF p_allowed_types IS NOT NULL AND NOT (entity_kind = ANY(p_allowed_types)) THEN
    RAISE EXCEPTION '% must reference an M01 COMPANY or ORGANIZATION Entity', p_label
      USING ERRCODE='23514';
  END IF;
END $$;
