CREATE TABLE core.knowledge_ball_identity_bindings (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id text NOT NULL,
  entity_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'knowledge-ball' CHECK (provider = 'knowledge-ball'),
  principal_ref text NOT NULL CHECK (btrim(principal_ref) <> ''),
  binding_version integer NOT NULL CHECK (binding_version > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  verified_by_entity_id uuid NOT NULL,
  verification_ref text NOT NULL CHECK (btrim(verification_ref) <> ''),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_by_entity_id uuid NULL,
  revoked_at timestamptz NULL,
  revoke_reason text NULL CHECK (revoke_reason IS NULL OR btrim(revoke_reason) <> ''),
  UNIQUE (world_id, entity_id, provider, binding_version),
  FOREIGN KEY (world_id, entity_id) REFERENCES core.entities(world_id, entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, verified_by_entity_id) REFERENCES core.entities(world_id, entity_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id, revoked_by_entity_id) REFERENCES core.entities(world_id, entity_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'ACTIVE' AND revoked_by_entity_id IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR
    (status = 'REVOKED' AND revoked_by_entity_id IS NOT NULL AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX knowledge_ball_binding_active_entity_idx
  ON core.knowledge_ball_identity_bindings(world_id, entity_id, provider)
  WHERE status = 'ACTIVE';

-- A KB principal must not silently become two NewHumans identities. Principal refs are
-- canonical, opaque identifiers returned by the trusted KB identity provider.
CREATE UNIQUE INDEX knowledge_ball_binding_active_principal_idx
  ON core.knowledge_ball_identity_bindings(provider, principal_ref)
  WHERE status = 'ACTIVE';

CREATE INDEX knowledge_ball_binding_history_idx
  ON core.knowledge_ball_identity_bindings(world_id, entity_id, binding_version DESC);

CREATE OR REPLACE FUNCTION core.guard_knowledge_ball_binding_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.world_id IS DISTINCT FROM OLD.world_id
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.principal_ref IS DISTINCT FROM OLD.principal_ref
     OR NEW.binding_version IS DISTINCT FROM OLD.binding_version
     OR NEW.verified_by_entity_id IS DISTINCT FROM OLD.verified_by_entity_id
     OR NEW.verification_ref IS DISTINCT FROM OLD.verification_ref
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity binding evidence is immutable';
  END IF;

  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'identity binding may only transition ACTIVE to REVOKED';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER knowledge_ball_binding_update_guard
BEFORE UPDATE ON core.knowledge_ball_identity_bindings
FOR EACH ROW EXECUTE FUNCTION core.guard_knowledge_ball_binding_update();

COMMENT ON TABLE core.knowledge_ball_identity_bindings IS
  'Auditable, versioned mapping from a NewHumans Entity to an opaque Knowledge Ball principal. This table is identity metadata only; it is not an Economy, Memory, or Knowledge authority.';
COMMENT ON COLUMN core.knowledge_ball_identity_bindings.principal_ref IS
  'Opaque canonical principal reference returned by a trusted Knowledge Ball identity provider; never trust a client-supplied value.';
