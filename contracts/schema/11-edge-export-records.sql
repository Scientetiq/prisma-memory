DO $$ BEGIN IF current_setting('memory.class', true) IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'edge export: file 11 applies only to memory_open'; END IF; END $$;

-- [P0]

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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'memory_edge_views') THEN
        RAISE EXCEPTION 'edge export: role memory_edge_views is missing — first apply 09-external-access.sql on memory_control';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS edge_outbox (
    seq          bigserial PRIMARY KEY,
    lane         text NOT NULL,
    kind         text NOT NULL,
    id           uuid NOT NULL,
    reason       text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
    created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    batch_id     uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS edge_outbox_pending ON edge_outbox (lane, kind, id) WHERE processed_at IS NULL AND batch_id IS NULL;
CREATE INDEX IF NOT EXISTS edge_outbox_lane ON edge_outbox (lane, seq) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_outbox_done ON edge_outbox (processed_at) WHERE processed_at IS NOT NULL;
SELECT memory_check_extend('edge_outbox', 'edge_outbox_lane_check', 'lane', ARRAY['revoke', 'publish']);
SELECT memory_check_finish('edge_outbox', 'edge_outbox_lane_check');
SELECT memory_check_extend('edge_outbox', 'edge_outbox_kind_check', 'kind', ARRAY['record', 'link_detail', 'original']);
SELECT memory_check_finish('edge_outbox', 'edge_outbox_kind_check');

CREATE TABLE IF NOT EXISTS edge_outbox_state (
    one            boolean PRIMARY KEY DEFAULT true CHECK (one),
    enabled        boolean NOT NULL DEFAULT false,
    revoke_enabled boolean NOT NULL DEFAULT false,
    changed_at     timestamptz
);
INSERT INTO edge_outbox_state (one) VALUES (true) ON CONFLICT (one) DO NOTHING;

ALTER TABLE edge_outbox OWNER TO memory_edge_views;
ALTER TABLE edge_outbox_state OWNER TO memory_edge_views;
REVOKE ALL ON edge_outbox, edge_outbox_state FROM PUBLIC;
GRANT SELECT ON records, record_content, chunks, record_placements, record_people, record_entities, record_stages,
                record_link_details TO memory_edge_views;

CREATE OR REPLACE VIEW v_edge_gate WITH (security_barrier) AS
SELECT q.record_id, q.c7, q.c8, q.c9_open, (q.c7 AND q.c8 AND q.c9_open) AS ok_open, q.chain
  FROM (SELECT r.id AS record_id,
               COALESCE(ch.whole AND NOT ch.bad, false) AS c7,
               COALESCE(NOT ch.held AND NOT ch.converting, false)
                 AND NOT EXISTS (SELECT 1 FROM record_stages st WHERE st.record_id = r.id AND st.stage = 'converted'
                                    AND st.status NOT IN ('done', 'skipped')) AS c8,
               (r.audience = 'space') AS c9_open,
               ch.chain
          FROM records r
          CROSS JOIN LATERAL (
              WITH RECURSIVE up(id, parent_id, depth, bad, held, converting) AS (
                  SELECT r.id, r.parent_id, 0,
                         (r.deleted_at IS NOT NULL OR r.hidden_at IS NOT NULL OR NOT r.is_current),
                         (r.attrs -> 'conversion' ->> 'error_kind') IS NOT DISTINCT FROM 'open_check_fallback_failed',
                         (r.attrs -> 'conversion' IS NOT NULL AND (r.attrs -> 'conversion' ->> 'status') IS DISTINCT FROM 'done')
                  UNION ALL
                  SELECT p.id, p.parent_id, u.depth + 1,
                         (p.deleted_at IS NOT NULL OR p.hidden_at IS NOT NULL OR NOT p.is_current),
                         (p.attrs -> 'conversion' ->> 'error_kind') IS NOT DISTINCT FROM 'open_check_fallback_failed',
                         (p.attrs -> 'conversion' IS NOT NULL AND (p.attrs -> 'conversion' ->> 'status') IS DISTINCT FROM 'done')
                    FROM up u JOIN records p ON p.id = u.parent_id
                   WHERE u.depth < 64)
              SELECT bool_or(up.parent_id IS NULL) AS whole, bool_or(up.bad) AS bad, bool_or(up.held) AS held,
                     bool_or(up.converting) AS converting,
                     COALESCE(array_agg(up.id ORDER BY up.depth) FILTER (WHERE up.depth > 0), '{}'::uuid[]) AS chain
                FROM up) ch) q;

CREATE OR REPLACE VIEW v_edge_trees WITH (security_barrier) AS
SELECT r.id, r.type::text AS type, r.event_kind::text AS event_kind, r.space_id, r.title, r.summary_line, r.occurred_at, r.ingested_at,
       r.updated_at, r.owner_id, r.origin::text AS origin, r.method::text AS method, (r.confirmed_at IS NOT NULL) AS confirmed,
       r.parent_id, r.locator, r.version, r.is_current, r.domain_tags,
       COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(r.attrs) e
                  WHERE e.key IN ('rationale', 'alternatives', 'approved_by', 'outcome', 'actors', 'participants', 'due', 'pages', 'quote')),
                '{}'::jsonb) AS attrs,
       f.agent_file,
       (f.agent_file AND EXISTS (SELECT 1 FROM record_content c WHERE c.record_id = r.id AND c.original_key IS NOT NULL)) AS original_ok
  FROM records r
  JOIN v_edge_gate g ON g.record_id = r.id AND g.ok_open
  CROSS JOIN LATERAL (
      SELECT (COALESCE(r.attrs -> 'conversion' ->> 'extraction_state', '') NOT IN ('partial', 'unavailable')
              AND NOT (r.attrs ? 'original_closed')
              AND COALESCE(r.attrs -> 'conversion' ->> 'agent_file', '') <> 'false') AS agent_file) f;

CREATE OR REPLACE VIEW v_edge_content WITH (security_barrier) AS
SELECT c.record_id, c.text AS markdown, c.pages, c.duration_sec, c.language, c.original_key, c.original_mime, c.original_bytes
  FROM record_content c JOIN v_edge_gate g ON g.record_id = c.record_id AND g.ok_open;

CREATE OR REPLACE VIEW v_edge_chunks WITH (security_barrier) AS
SELECT k.id, k.record_id, k.ordinal, k.text, k.token_count, k.section_path, k.page_from, k.page_to, k.time_from_sec, k.time_to_sec,
       k.space_id, k.type::text AS type, k.occurred_at
  FROM chunks k JOIN v_edge_gate g ON g.record_id = k.record_id AND g.ok_open;

CREATE OR REPLACE VIEW v_edge_placements WITH (security_barrier) AS
SELECT p.record_id, p.space_id FROM record_placements p JOIN v_edge_gate g ON g.record_id = p.record_id AND g.ok_open;

CREATE OR REPLACE VIEW v_edge_people WITH (security_barrier) AS
SELECT p.record_id, p.person_id FROM record_people p JOIN v_edge_gate g ON g.record_id = p.record_id AND g.ok_open;

CREATE OR REPLACE VIEW v_edge_entity_refs WITH (security_barrier) AS
SELECT DISTINCT e.record_id, e.entity_id FROM record_entities e JOIN v_edge_gate g ON g.record_id = e.record_id AND g.ok_open
 WHERE e.role = 'mentioned';

CREATE OR REPLACE VIEW v_edge_link_details WITH (security_barrier) AS
SELECT d.link_id AS id, d.src_quote, d.dst_quote, d.rationale FROM record_link_details d WHERE d.class = 'open';

ALTER VIEW v_edge_gate OWNER TO memory_edge_views;
ALTER VIEW v_edge_trees OWNER TO memory_edge_views;
ALTER VIEW v_edge_content OWNER TO memory_edge_views;
ALTER VIEW v_edge_chunks OWNER TO memory_edge_views;
ALTER VIEW v_edge_placements OWNER TO memory_edge_views;
ALTER VIEW v_edge_people OWNER TO memory_edge_views;
ALTER VIEW v_edge_entity_refs OWNER TO memory_edge_views;
ALTER VIEW v_edge_link_details OWNER TO memory_edge_views;
REVOKE ALL ON v_edge_gate, v_edge_trees, v_edge_content, v_edge_chunks, v_edge_placements, v_edge_people, v_edge_entity_refs,
              v_edge_link_details FROM PUBLIC;

CREATE OR REPLACE FUNCTION edge_outbox_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE((SELECT enabled FROM edge_outbox_state WHERE one), false)
$$;

CREATE OR REPLACE FUNCTION edge_revoke_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE((SELECT enabled OR revoke_enabled FROM edge_outbox_state WHERE one), false)
$$;

CREATE OR REPLACE FUNCTION edge_enqueue(p_lane text, p_kind text, p_ids uuid[], p_reason text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN 0;
    END IF;
    IF NOT (CASE WHEN p_lane = 'revoke' THEN edge_revoke_on() ELSE edge_outbox_on() END) THEN
        RETURN 0;
    END IF;
    INSERT INTO edge_outbox AS q (lane, kind, id, reason)
    SELECT p_lane, p_kind, d.u, p_reason FROM (SELECT DISTINCT u FROM unnest(p_ids) u WHERE u IS NOT NULL) d
    ON CONFLICT (lane, kind, id) WHERE processed_at IS NULL AND batch_id IS NULL
       DO UPDATE SET reason = EXCLUDED.reason
       WHERE EXCLUDED.reason IN ('deleted', 'hidden', 'held', 'audience_people')
         AND q.reason NOT IN ('deleted', 'hidden', 'held', 'audience_people');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
        PERFORM pg_notify('edge_outbox_' || p_lane, '');
    END IF;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_with_descendants(p_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH RECURSIVE d(id, depth) AS (
        SELECT u, 0 FROM unnest(p_ids) u WHERE u IS NOT NULL
        UNION
        SELECT r.id, d.depth + 1 FROM d JOIN records r ON r.parent_id = d.id WHERE d.depth < 64)
    SELECT COALESCE(array_agg(DISTINCT id), '{}') FROM d
$$;

CREATE OR REPLACE FUNCTION edge_enqueue_publish(p_ids uuid[], p_reason text, p_kind text DEFAULT 'record') RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_kind NOT IN ('record', 'link_detail', 'original') THEN
        RAISE EXCEPTION 'edge_enqueue_publish: kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'edge_enqueue_publish: reason — a code [a-z][a-z0-9_]{0,63}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN edge_enqueue('publish', p_kind, p_ids, p_reason);
END $$;

CREATE OR REPLACE FUNCTION edge_outbox_gc(p_keep interval) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_keep IS NULL OR p_keep < interval '1 hour' THEN
        RAISE EXCEPTION 'edge_outbox_gc: the period is not less than an hour' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    WITH gone AS (DELETE FROM edge_outbox q WHERE q.processed_at IS NOT NULL AND q.processed_at < now() - p_keep RETURNING 1)
    SELECT count(*) INTO n FROM gone;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_outbox_set(p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_enabled IS NULL THEN
        RAISE EXCEPTION 'edge_outbox_set: yes or no' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE edge_outbox_state SET enabled = p_enabled, revoke_enabled = revoke_enabled OR p_enabled, changed_at = now()
     WHERE one AND (enabled IS DISTINCT FROM p_enabled OR (p_enabled AND NOT revoke_enabled));
    IF NOT p_enabled THEN
        UPDATE edge_outbox SET processed_at = now() WHERE processed_at IS NULL AND lane = 'publish';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_records() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r      record;
    closed uuid[];
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT n.id FROM new_t n), 'new');
    ELSIF TG_OP = 'UPDATE' THEN
        FOR r IN
            SELECT x.reason, array_agg(x.id) AS ids
              FROM (SELECT n.id,
                           CASE WHEN o.deleted_at IS NULL AND n.deleted_at IS NOT NULL THEN 'deleted'
                                WHEN o.hidden_at IS NULL AND n.hidden_at IS NOT NULL THEN 'hidden'
                                WHEN (o.attrs -> 'conversion' ->> 'error_kind') IS DISTINCT FROM 'open_check_fallback_failed'
                                     AND (n.attrs -> 'conversion' ->> 'error_kind') IS NOT DISTINCT FROM 'open_check_fallback_failed' THEN 'held'
                                WHEN o.audience = 'space' AND n.audience = 'people' THEN 'audience_people'
                                WHEN (n.attrs -> 'conversion' IS NOT NULL AND (n.attrs -> 'conversion' ->> 'status') IS DISTINCT FROM 'done')
                                     AND (o.attrs -> 'conversion' IS NULL OR (o.attrs -> 'conversion' ->> 'status') = 'done') THEN 'converting'
                                WHEN o.is_current AND NOT n.is_current THEN 'not_current'
                                WHEN o.parent_id IS DISTINCT FROM n.parent_id THEN 'parent_change'
                                WHEN o.space_id <> n.space_id THEN 'space_change' END AS reason
                      FROM old_t o JOIN new_t n ON n.id = o.id) x
             WHERE x.reason IS NOT NULL
             GROUP BY x.reason
        LOOP
            PERFORM edge_enqueue('revoke', 'record', edge_with_descendants(r.ids), r.reason);
        END LOOP;
        closed := ARRAY(
            SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
             WHERE (NOT (o.attrs ? 'original_closed') AND n.attrs ? 'original_closed')
                OR (COALESCE(o.attrs -> 'conversion' ->> 'agent_file', '') <> 'false' AND COALESCE(n.attrs -> 'conversion' ->> 'agent_file', '') = 'false')
                OR (COALESCE(o.attrs -> 'conversion' ->> 'extraction_state', '') NOT IN ('partial', 'unavailable')
                    AND COALESCE(n.attrs -> 'conversion' ->> 'extraction_state', '') IN ('partial', 'unavailable')));
        PERFORM edge_enqueue('revoke', 'original', closed, 'original_closed');
        PERFORM edge_enqueue('revoke', 'record', closed, 'original_closed');
        PERFORM edge_enqueue('publish', 'record', ARRAY(
            SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
             WHERE (o.deleted_at IS NULL, o.hidden_at IS NULL, o.is_current, o.audience, o.parent_id, o.space_id, o.title, o.summary_line,
                    o.attrs, o.version, o.event_kind, o.domain_tags, o.occurred_at, o.owner_id, o.confirmed_at IS NULL, o.locator, o.type)
                   IS DISTINCT FROM
                   (n.deleted_at IS NULL, n.hidden_at IS NULL, n.is_current, n.audience, n.parent_id, n.space_id, n.title, n.summary_line,
                    n.attrs, n.version, n.event_kind, n.domain_tags, n.occurred_at, n.owner_id, n.confirmed_at IS NULL, n.locator, n.type)),
            'content');
    ELSE
        PERFORM edge_enqueue('revoke', 'record', ARRAY(SELECT o.id FROM old_t o), 'deleted');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_record_parts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_TABLE_NAME = 'record_stages' THEN
        IF TG_OP = 'INSERT' THEN
            PERFORM edge_enqueue('revoke', 'record', edge_with_descendants(ARRAY(
                SELECT n.record_id FROM new_t n WHERE n.stage = 'converted' AND n.status NOT IN ('done', 'skipped'))), 'converting');
        ELSIF TG_OP = 'UPDATE' THEN
            PERFORM edge_enqueue('revoke', 'record', edge_with_descendants(ARRAY(
                SELECT n.record_id FROM old_t o JOIN new_t n ON n.record_id = o.record_id AND n.stage = o.stage
                 WHERE n.stage = 'converted' AND n.status NOT IN ('done', 'skipped') AND o.status IN ('done', 'skipped'))), 'converting');
        END IF;
        IF TG_OP = 'INSERT' THEN
            PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT n.record_id FROM new_t n
                                                             WHERE n.stage = 'converted' AND n.status IN ('done', 'skipped')), 'content');
        ELSIF TG_OP = 'UPDATE' THEN
            PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT n.record_id FROM old_t o JOIN new_t n ON n.record_id = o.record_id AND n.stage = o.stage
                                                             WHERE n.stage = 'converted' AND n.status IN ('done', 'skipped')
                                                               AND o.status IS DISTINCT FROM n.status), 'content');
        END IF;
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('record_people', 'record_placements') THEN
        PERFORM edge_enqueue('revoke', 'record', ARRAY(SELECT DISTINCT (to_jsonb(o)->>'record_id')::uuid FROM old_t o),
                             CASE TG_TABLE_NAME WHEN 'record_people' THEN 'people_removed' ELSE 'placement_removed' END);
    ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('record_people', 'record_placements') THEN
        PERFORM edge_enqueue('revoke', 'record',
                             ARRAY(SELECT DISTINCT (to_jsonb(o)->>'record_id')::uuid FROM old_t o
                                    WHERE NOT EXISTS (SELECT 1 FROM new_t n WHERE to_jsonb(n) = to_jsonb(o))),
                             CASE TG_TABLE_NAME WHEN 'record_people' THEN 'people_removed' ELSE 'placement_removed' END);
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT DISTINCT (to_jsonb(n)->>'record_id')::uuid FROM new_t n), 'content');
    END IF;
    IF TG_OP <> 'INSERT' THEN
        PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT DISTINCT (to_jsonb(o)->>'record_id')::uuid FROM old_t o), 'content');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_link_details() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        PERFORM edge_enqueue('publish', 'link_detail', ARRAY(SELECT n.link_id FROM new_t n WHERE n.class = 'open'), 'content');
    ELSE
        PERFORM edge_enqueue('revoke', 'link_detail', ARRAY(SELECT o.link_id FROM old_t o), 'link_down');
    END IF;
    RETURN NULL;
END $$;

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('records', 'edge_trg_records'), ('record_content', 'edge_trg_record_parts'), ('chunks', 'edge_trg_record_parts'),
        ('record_placements', 'edge_trg_record_parts'), ('record_people', 'edge_trg_record_parts'),
        ('record_entities', 'edge_trg_record_parts'), ('record_stages', 'edge_trg_record_parts'),
        ('record_link_details', 'edge_trg_link_details')) v(tbl, fn)
    LOOP
        EXECUTE format('CREATE OR REPLACE TRIGGER edge_out_ins AFTER INSERT ON %I REFERENCING NEW TABLE AS new_t FOR EACH STATEMENT EXECUTE FUNCTION %I()', t.tbl, t.fn);
        EXECUTE format('CREATE OR REPLACE TRIGGER edge_out_upd AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_t NEW TABLE AS new_t FOR EACH STATEMENT EXECUTE FUNCTION %I()', t.tbl, t.fn);
        EXECUTE format('CREATE OR REPLACE TRIGGER edge_out_del AFTER DELETE ON %I REFERENCING OLD TABLE AS old_t FOR EACH STATEMENT EXECUTE FUNCTION %I()', t.tbl, t.fn);
    END LOOP;
END $$;

DO $$
DECLARE
    f regprocedure;
BEGIN
    FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('edge_outbox_on', 'edge_revoke_on', 'edge_enqueue', 'edge_with_descendants', 'edge_enqueue_publish', 'edge_outbox_gc',
                                  'edge_outbox_set', 'edge_trg_records', 'edge_trg_record_parts', 'edge_trg_link_details')
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO memory_edge_views', f);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    END LOOP;
END $$;

GRANT SELECT ON v_edge_gate, v_edge_trees, v_edge_content, v_edge_chunks, v_edge_placements, v_edge_people, v_edge_entity_refs,
                v_edge_link_details TO memory_exporter;
GRANT SELECT ON edge_outbox, edge_outbox_state TO memory_exporter;
GRANT UPDATE (processed_at, batch_id) ON edge_outbox TO memory_exporter;
GRANT EXECUTE ON FUNCTION edge_outbox_set(boolean), edge_outbox_gc(interval) TO memory_exporter;
-- the full-text configurations applied to the open records: the edge copy builds its search with the same list
GRANT SELECT (fts_configs) ON retrieval_config TO memory_exporter;
GRANT SELECT (id, parent_id, space_id, audience, is_current, deleted_at, hidden_at, attrs, updated_at) ON records TO memory_reconciler;
GRANT SELECT (record_id, text) ON record_content TO memory_reconciler;
GRANT SELECT (id, record_id, text) ON chunks TO memory_reconciler;
GRANT SELECT ON record_stages, record_link_details TO memory_reconciler;
GRANT EXECUTE ON FUNCTION edge_enqueue_publish(uuid[], text, text) TO memory_reconciler;
GRANT SELECT (lane, kind, id, created_at, processed_at) ON edge_outbox TO memory_reconciler;
GRANT SELECT (type, event_kind, title, summary_line, occurred_at, ingested_at, owner_id, origin, method, confirmed_at, locator, version,
              domain_tags) ON records TO memory_reconciler;
GRANT SELECT (original_key, pages, duration_sec, language) ON record_content TO memory_reconciler;
GRANT SELECT (ordinal) ON chunks TO memory_reconciler;
GRANT SELECT (record_id, space_id) ON record_placements TO memory_reconciler;
GRANT SELECT (record_id, person_id) ON record_people TO memory_reconciler;
GRANT SELECT (record_id, entity_id, role) ON record_entities TO memory_reconciler;
GRANT EXECUTE ON FUNCTION edge_with_descendants(uuid[]) TO memory_exporter;

-- [1c]

-- [1d]

-- [1e]

-- [1f]

-- [S2-3]

-- [4]

-- [E2]

-- [5]
