
-- [P0]

SET lock_timeout = '5s';

-- >>> memory_check_helpers
CREATE OR REPLACE FUNCTION memory_check_literals(p_def text, p_column text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    shape text;
BEGIN
    shape := regexp_replace(p_def, '''(?:[^'']|'''')*''', 'L', 'g');
    shape := regexp_replace(shape, '\s+', '', 'g');
    shape := regexp_replace(shape, '::[a-z]+(\[\])?', '', 'g');
    shape := regexp_replace(shape, '[()"]', '', 'g');
    shape := regexp_replace(shape, 'NOTVALID$', '');
    IF shape !~ ('^CHECK' || p_column || '=(ANYARRAY\[L(,L)*\]|L)$') THEN
        RAISE EXCEPTION 'memory_check_extend: the constraint is not of the form “% IN (…)”: %', p_column, p_def;
    END IF;
    RETURN ARRAY(SELECT replace(m[1], '''''', '''') FROM regexp_matches(p_def, '''((?:[^'']|'''')*)''', 'g') AS m);
END $$;

CREATE OR REPLACE FUNCTION memory_check_extend(p_table text, p_name text, p_column text, p_values text[]) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    rel  regclass := p_table::regclass;
    cur  text;
    pend text;
    have text[] := '{}';
    pv   text[] := '{}';
    want text[];
BEGIN
    SELECT pg_get_constraintdef(oid) INTO cur FROM pg_constraint WHERE conrelid = rel AND conname = p_name;
    SELECT pg_get_constraintdef(oid) INTO pend FROM pg_constraint WHERE conrelid = rel AND conname = p_name || '_new';
    IF cur IS NOT NULL THEN have := memory_check_literals(cur, p_column); END IF;
    IF pend IS NOT NULL THEN pv := memory_check_literals(pend, p_column); END IF;
    want := have || ARRAY(SELECT v FROM unnest(pv || p_values) WITH ORDINALITY AS u(v, n)
                          WHERE v <> ALL (have) GROUP BY v ORDER BY min(n));
    IF cur IS NOT NULL AND pend IS NULL AND want <@ have THEN RETURN false; END IF;
    IF pend IS NOT NULL AND want <@ pv THEN RETURN true; END IF;
    IF pend IS NOT NULL THEN EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rel, p_name || '_new'); END IF;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I IN (%s)) NOT VALID', rel, p_name || '_new', p_column,
                   (SELECT string_agg(quote_literal(v), ',') FROM unnest(want) v));
    RETURN true;
END $$;

CREATE OR REPLACE FUNCTION memory_check_finish(p_table text, p_name text) RETURNS boolean
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    rel regclass := p_table::regclass;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = rel AND conname = p_name || '_new') THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = rel AND conname = p_name || '_new' AND NOT convalidated) THEN
        EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', rel, p_name || '_new');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = rel AND conname = p_name) THEN
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rel, p_name);
    END IF;
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', rel, p_name || '_new', p_name);
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION memory_check_literals(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_check_extend(text, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION memory_check_finish(text, text) FROM PUBLIC;
-- <<< memory_check_helpers

-- [1a]

-- [1b]

SELECT memory_check_extend('audit_events', 'audit_events_event_type_check', 'event_type', ARRAY['edge_event', 'edge_alarm']);
SELECT memory_check_finish('audit_events', 'audit_events_event_type_check');
GRANT INSERT ON audit_events TO memory_intake, memory_reconciler;

-- [1c]

-- [1d]

SELECT memory_check_extend('audit_events', 'audit_events_event_type_check', 'event_type', ARRAY['ops']);
SELECT memory_check_finish('audit_events', 'audit_events_event_type_check');

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE audit_events ALTER COLUMN received_at SET DEFAULT clock_timestamp();

CREATE INDEX IF NOT EXISTS audit_events_feed_idx ON audit_events (received_at, id) WHERE details ? 'code';
CREATE INDEX IF NOT EXISTS audit_events_feed_kind_idx ON audit_events ((event_type = 'edge_event'), received_at, id) WHERE details ? 'code';

CREATE OR REPLACE FUNCTION audit_alert_feed(p_after_at timestamptz, p_after_id uuid, p_codes text[], p_lim int, p_edge boolean)
RETURNS TABLE(id uuid, at timestamptz, received_at timestamptz, event_type text, code text, detail jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT s.id, s.at, s.received_at, s.event_type, left(s.details->>'code', 64),
           COALESCE((SELECT jsonb_object_agg(k.key, CASE WHEN jsonb_typeof(k.value) = 'string' THEN to_jsonb(left(k.value #>> '{}', 128))
                                                        ELSE k.value END)
                       FROM jsonb_each(s.details) k
                      WHERE k.key IN ('ip_prefix', 'asn', 'country', 'count', 'ms', 'kid', 'client_id', 'connection_id',
                                      'person_id', 'step', 'reason', 'path_class', 'check', 'days_left', 'service',
                                      'from', 'to', 'kind', 'accounts', 'action', 'age_ms', 'bad_pwd_count', 'batches',
                                      'bound', 'by', 'bytes', 'call', 'class', 'cn', 'configured', 'descendants',
                                      'detail', 'directory', 'disabled_code', 'edge_id', 'error_code', 'event_type',
                                      'field', 'file', 'first_confirm', 'have', 'hits', 'holds', 'items', 'key',
                                      'lifted', 'limit', 'method', 'mfa_level', 'minutes', 'mode', 'moved',
                                      'oldest_hours', 'outcome', 'pending', 'per_min', 'port', 'problem', 'process',
                                      'purpose', 'queue', 'reasons', 'record_id', 'rows', 'scope', 'seconds', 'seen',
                                      'serial', 'setting', 'skew_ms', 'skid', 'source', 'spool_id', 'stage', 'status',
                                      'theta_sec', 'threshold', 'tombstones', 'tool', 'until', 'valid', 'verdict',
                                      'want', 'why',
                                      'first', 'killed_at', 'killed_reason', 'request_id', 'requested_at', 'revoked', 'since')
                        AND jsonb_typeof(k.value) IN ('string', 'number', 'boolean')), '{}'::jsonb)
      FROM ((SELECT e.id, e.at, e.received_at, e.event_type, e.details
               FROM audit_events e
              WHERE p_edge IS NULL AND e.details ? 'code'
                AND (e.received_at, e.id) > (COALESCE(p_after_at, '-infinity'::timestamptz), COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
                AND e.received_at < now() - interval '30 seconds'
                AND (p_codes IS NULL OR e.details->>'code' = ANY (p_codes))
              ORDER BY e.received_at, e.id
              LIMIT least(greatest(COALESCE(p_lim, 500), 1), 1000))
            UNION ALL
            (SELECT e.id, e.at, e.received_at, e.event_type, e.details
               FROM audit_events e
              WHERE p_edge IS NOT NULL AND e.details ? 'code' AND (e.event_type = 'edge_event') = p_edge
                AND (e.received_at, e.id) > (COALESCE(p_after_at, '-infinity'::timestamptz), COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
                AND e.received_at < now() - interval '30 seconds'
                AND (p_codes IS NULL OR e.details->>'code' = ANY (p_codes))
              ORDER BY (e.event_type = 'edge_event'), e.received_at, e.id
              LIMIT least(greatest(COALESCE(p_lim, 500), 1), 1000))) s
     ORDER BY s.received_at, s.id
$$;
REVOKE ALL ON FUNCTION audit_alert_feed(timestamptz, uuid, text[], int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_alert_feed(timestamptz, uuid, text[], int, boolean) TO memory_worker;
CREATE OR REPLACE FUNCTION audit_alert_feed(p_after_at timestamptz, p_after_id uuid, p_codes text[], p_lim int)
RETURNS TABLE(id uuid, at timestamptz, received_at timestamptz, event_type text, code text, detail jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT * FROM audit_alert_feed(p_after_at, p_after_id, p_codes, p_lim, NULL)
$$;
REVOKE ALL ON FUNCTION audit_alert_feed(timestamptz, uuid, text[], int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_alert_feed(timestamptz, uuid, text[], int) TO memory_worker;

-- [1e]

SELECT memory_check_extend('audit_events', 'audit_events_event_type_check', 'event_type', ARRAY['external', 'edge_alert']);
SELECT memory_check_finish('audit_events', 'audit_events_event_type_check');
GRANT INSERT ON audit_events TO memory_intake;

-- [1f]

SELECT memory_check_extend('audit_events', 'audit_events_event_type_check', 'event_type', ARRAY['factor']);
SELECT memory_check_finish('audit_events', 'audit_events_event_type_check');

-- [S2-3]

-- [4]

-- [E2]

-- [5]
