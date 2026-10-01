-- P3 runtime hardening upgrade preflight.
-- This migration intentionally runs before 014 so legacy data is either proven safe
-- for the stricter runtime authority constraints or the upgrade stops for owner review.

CREATE OR REPLACE FUNCTION runtime.jsonb_contains_secret(node jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  k text;
  v jsonb;
  scalar text;
  normalized_key text;
  basic_token text;
  basic_decoded text;
BEGIN
  IF node IS NULL THEN RETURN false; END IF;
  CASE jsonb_typeof(node)
    WHEN 'object' THEN
      FOR k, v IN SELECT key, value FROM jsonb_each(node) LOOP
        normalized_key := lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'));
        IF normalized_key ~ '(^|[_-])(cookie|secret|password|credential)([_-]|$)'
           OR normalized_key ~ '(^|[_-])(proxy[-_]authorization|authorization[-_]header|http[-_]authorization|set[-_]cookie|x[-_]api[-_]key|api[-_]key|access[-_]token|bearer[-_]token)([_-]|$)'
           OR (normalized_key = 'authorization' AND jsonb_typeof(v) = 'string')
           OR runtime.jsonb_contains_secret(v) THEN
          RETURN true;
        END IF;
      END LOOP;
    WHEN 'array' THEN
      FOR v IN SELECT value FROM jsonb_array_elements(node) LOOP
        IF runtime.jsonb_contains_secret(v) THEN RETURN true; END IF;
      END LOOP;
    WHEN 'string' THEN
      scalar := node #>> '{}';
      IF scalar ~* '^\s*bearer\s+[A-Za-z0-9._~+/=-]{8,}\s*$' THEN
        RETURN true;
      END IF;
      IF scalar ~* '^\s*basic\s+[A-Za-z0-9+/]+={0,2}\s*$' THEN
        basic_token := regexp_replace(scalar, '^\s*[Bb][Aa][Ss][Ii][Cc]\s+', '');
        basic_token := regexp_replace(basic_token, '\s+$', '');
        BEGIN
          basic_decoded := convert_from(decode(basic_token, 'base64'), 'UTF8');
          IF position(':' IN basic_decoded) > 0 THEN RETURN true; END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      END IF;
    ELSE
      NULL;
  END CASE;
  RETURN false;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM runtime.model_manifests
     WHERE runtime.jsonb_contains_secret(sampling_settings)
  ) THEN
    RAISE EXCEPTION 'legacy runtime manifest contains secret-bearing sampling settings; owner review required before P3 hardening'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM runtime.model_routes
     WHERE route_policy IS NOT NULL
       AND jsonb_typeof(route_policy) <> 'object'
  ) THEN
    RAISE EXCEPTION 'legacy runtime route policy is not a JSON object; owner review required before P3 hardening'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM runtime.model_routes
     WHERE runtime.jsonb_contains_secret(route_policy)
  ) THEN
    RAISE EXCEPTION 'legacy runtime route policy contains secret-bearing material; owner review required before P3 hardening'
      USING ERRCODE='23514';
  END IF;
END $$;
