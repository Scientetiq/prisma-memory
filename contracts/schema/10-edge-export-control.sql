
-- [P0]

-- [1a]

-- [1b]

CREATE TABLE IF NOT EXISTS edge_state (
    kind         text NOT NULL,
    id           uuid NOT NULL,
    gen          bigint NOT NULL DEFAULT 0,
    tomb_gen     bigint,
    exported_gen bigint,
    exported_at  timestamptz,
    PRIMARY KEY (kind, id)
);
SELECT memory_check_extend('edge_state', 'edge_state_kind_check', 'kind', ARRAY['record', 'link', 'space', 'person', 'entity']);
SELECT memory_check_finish('edge_state', 'edge_state_kind_check');

CREATE TABLE IF NOT EXISTS edge_hold (
    record_id  uuid NOT NULL,
    reason     text NOT NULL,
    source     text NOT NULL CHECK (source ~ '^[a-z_]{1,32}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (record_id, reason)
);
CREATE INDEX IF NOT EXISTS edge_hold_record ON edge_hold (record_id);
SELECT memory_check_extend('edge_hold', 'edge_hold_reason_check', 'reason',
                           ARRAY['close_requested', 'hidden', 'deleted', 'open_check', 'held', 'org_review', 'audience_people',
                                 'restore_tomb', 'manual']);
SELECT memory_check_finish('edge_hold', 'edge_hold_reason_check');

CREATE TABLE IF NOT EXISTS edge_outbox_control (
    seq          bigserial PRIMARY KEY,
    lane         text NOT NULL,
    kind         text NOT NULL,
    id           uuid NOT NULL,
    reason       text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
    item         jsonb CHECK (item IS NULL OR (jsonb_typeof(item) = 'object' AND octet_length(item::text) <= 65536)),
    created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    batch_id     uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS edge_outbox_control_pending ON edge_outbox_control (lane, kind, id) WHERE processed_at IS NULL AND batch_id IS NULL;
CREATE INDEX IF NOT EXISTS edge_outbox_control_lane ON edge_outbox_control (lane, seq) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_outbox_control_done ON edge_outbox_control (processed_at) WHERE processed_at IS NOT NULL;
SELECT memory_check_extend('edge_outbox_control', 'edge_outbox_control_lane_check', 'lane', ARRAY['revoke', 'publish']);
SELECT memory_check_finish('edge_outbox_control', 'edge_outbox_control_lane_check');
SELECT memory_check_extend('edge_outbox_control', 'edge_outbox_control_kind_check', 'kind',
                           ARRAY['record', 'link', 'space', 'person', 'person_access', 'projection', 'entity', 'meta']);
SELECT memory_check_finish('edge_outbox_control', 'edge_outbox_control_kind_check');

CREATE TABLE IF NOT EXISTS edge_outbox_control_state (
    one            boolean PRIMARY KEY DEFAULT true CHECK (one),
    enabled        boolean NOT NULL DEFAULT false,
    revoke_enabled boolean NOT NULL DEFAULT false,
    changed_at     timestamptz
);
INSERT INTO edge_outbox_control_state (one) VALUES (true) ON CONFLICT (one) DO NOTHING;

CREATE TABLE IF NOT EXISTS edge_export_status (
    one               boolean PRIMARY KEY DEFAULT true CHECK (one),
    watermark_sent_at timestamptz,
    revoke_age_ms     bigint,
    revoke_pending    int,
    publish_pending   int,
    last_full_sync_at timestamptz,
    last_light_at     timestamptz,
    last_full_at      timestamptz,
    last_result       jsonb CHECK (last_result IS NULL OR (jsonb_typeof(last_result) = 'object' AND octet_length(last_result::text) <= 8192)),
    reconcile_result  jsonb CHECK (reconcile_result IS NULL OR (jsonb_typeof(reconcile_result) = 'object' AND octet_length(reconcile_result::text) <= 8192)),
    canary_checked_at timestamptz,
    canary_tripped_at timestamptz,
    canary_state      text GENERATED ALWAYS AS (CASE WHEN canary_tripped_at IS NOT NULL THEN 'tripped'
                                                     WHEN canary_checked_at IS NOT NULL THEN 'ok' ELSE 'unknown' END) STORED,
    killed_at         timestamptz,
    killed_reason     text CHECK (killed_reason ~ '^[a-z_]{1,32}$'),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO edge_export_status (one) VALUES (true) ON CONFLICT (one) DO NOTHING;

CREATE TABLE IF NOT EXISTS edge_canaries (
    record_id  uuid PRIMARY KEY,
    kind       text NOT NULL,
    marker     text NOT NULL UNIQUE CHECK (marker ~ '^CANARY-[0-9a-f]{32}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz
);
SELECT memory_check_extend('edge_canaries', 'edge_canaries_kind_check', 'kind',
                           ARRAY['closed_personal', 'closed_team', 'closed_meeting', 'hidden_open', 'transitional_nda', 'transitional_held']);
SELECT memory_check_finish('edge_canaries', 'edge_canaries_kind_check');

CREATE TABLE IF NOT EXISTS edge_meta_keys (
    category text NOT NULL,
    key      text NOT NULL,
    name     text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_]*$'),
    PRIMARY KEY (category, key)
);
INSERT INTO edge_meta_keys (category, key, name) VALUES
    ('access', 'original_link_ttl_sec', 'original_link_ttl_sec'),
    ('edge', 'deadman_theta_sec', 'deadman_theta_sec'),
    ('edge', 'originals_max_mib', 'originals_max_mib'),
    ('edge', 'max_concurrent_per_connection', 'max_concurrent_per_connection'),
    ('edge', 'connection_expiry_warn_days', 'connection_expiry_warn_days'),
    ('onboarding', 'readme_templates_enabled', 'readme_templates_enabled')
ON CONFLICT (category, key) DO NOTHING;

ALTER TABLE edge_state OWNER TO memory_edge_views;
ALTER TABLE edge_hold OWNER TO memory_edge_views;
ALTER TABLE edge_outbox_control OWNER TO memory_edge_views;
ALTER TABLE edge_outbox_control_state OWNER TO memory_edge_views;
ALTER TABLE edge_export_status OWNER TO memory_edge_views;
ALTER TABLE edge_canaries OWNER TO memory_edge_views;
ALTER TABLE edge_meta_keys OWNER TO memory_edge_views;
REVOKE ALL ON edge_state, edge_hold, edge_outbox_control, edge_outbox_control_state, edge_export_status, edge_canaries, edge_meta_keys FROM PUBLIC;

GRANT SELECT ON record_locations, class_moves, org_reviews, spaces, people, org_units, space_members_effective, external_access,
                record_links, entities, settings, space_groups, directory_group_members, instances TO memory_edge_views;
GRANT EXECUTE ON FUNCTION tp_showcase_logins() TO memory_edge_views, memory_exporter, memory_reconciler;

CREATE OR REPLACE VIEW v_edge_gate_control WITH (security_barrier) AS
SELECT q.*, (q.c1 AND q.c2 AND q.c3 AND q.c4 AND q.c5 AND q.c9_control AND NOT q.canary) AS ok,
       (SELECT o.state FROM org_reviews o WHERE o.record_id = q.record_id) AS org_review_state
  FROM (SELECT l.record_id, l.space_id, l.owner_id,
               COALESCE(es.gen, 0) AS gen, es.tomb_gen,
               (l.class = 'open' AND NOT l.deleted) AS c1,
               NOT EXISTS (SELECT 1 FROM class_moves m WHERE m.record_id = l.record_id AND m.status IN ('pending', 'copying', 'verifying')) AS c2,
               NOT EXISTS (SELECT 1 FROM edge_hold h WHERE h.record_id = l.record_id) AS c3,
               (l.open_check IS NULL) AS c4,
               NOT EXISTS (SELECT 1 FROM org_reviews o WHERE o.record_id = l.record_id AND o.held_at IS NOT NULL) AS c5,
               (s.archived_at IS NULL AND s.slug <> 'demo-showcase'
                AND NOT (COALESCE(op.attrs->>'demo', '') = 'true' OR COALESCE(lower(op.login) = ANY (tp_showcase_logins()), false))
                AND NOT EXISTS (SELECT 1 FROM people sp WHERE sp.id = s.owner_id
                                   AND (COALESCE(sp.attrs->>'demo', '') = 'true' OR lower(sp.login) = ANY (tp_showcase_logins())))
                AND NOT EXISTS (SELECT 1 FROM org_units u WHERE u.id = s.org_unit_id AND u.code = 'demo')) AS c9_control,
               EXISTS (SELECT 1 FROM edge_canaries c WHERE c.record_id = l.record_id) AS canary
          FROM record_locations l
          JOIN spaces s ON s.id = l.space_id
          LEFT JOIN people op ON op.id = l.owner_id
          LEFT JOIN edge_state es ON es.kind = 'record' AND es.id = l.record_id) q;

CREATE OR REPLACE VIEW v_edge_spaces WITH (security_barrier) AS
SELECT s.id AS space_id, s.slug, s.name AS title, s.kind, s.description, s.readme
  FROM spaces s
 WHERE s.archived_at IS NULL AND s.slug <> 'demo-showcase'
   AND NOT EXISTS (SELECT 1 FROM people sp WHERE sp.id = s.owner_id
                      AND (COALESCE(sp.attrs->>'demo', '') = 'true' OR lower(sp.login) = ANY (tp_showcase_logins())))
   AND NOT EXISTS (SELECT 1 FROM org_units u WHERE u.id = s.org_unit_id AND u.code = 'demo')
   AND (EXISTS (SELECT 1 FROM v_edge_gate_control g WHERE g.space_id = s.id AND g.ok)
        OR EXISTS (SELECT 1 FROM edge_state es WHERE es.kind = 'space' AND es.id = s.id AND es.gen > COALESCE(es.tomb_gen, 0)));

CREATE OR REPLACE VIEW v_people_min WITH (security_barrier) AS
SELECT p.id AS person_id, p.display_name, p.active,
       (ea.person_id IS NOT NULL) AS external_access,
       CASE WHEN ea.person_id IS NOT NULL THEN lower(p.login) END AS login_lc,
       CASE WHEN ea.person_id IS NOT NULL THEN p.login END AS email
  FROM people p
  LEFT JOIN external_access ea ON ea.person_id = p.id AND ea.enabled_at IS NOT NULL AND ea.disabled_at IS NULL AND p.active
 WHERE COALESCE(p.attrs->>'demo', '') <> 'true' AND NOT COALESCE(lower(p.login) = ANY (tp_showcase_logins()), false)
   AND (ea.person_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM v_edge_gate_control g WHERE g.owner_id = p.id AND g.ok)
        OR EXISTS (SELECT 1 FROM edge_state es WHERE es.kind = 'person' AND es.id = p.id AND es.gen > COALESCE(es.tomb_gen, 0)));

CREATE OR REPLACE VIEW v_edge_projection WITH (security_barrier) AS
SELECT p.id AS person_id, s.id AS space_id, true AS can_read, false AS can_write_open,
       CASE WHEN s.kind = 'personal' OR (s.kind = 'org' AND COALESCE(p.attrs->>'demo', '') <> 'true') THEN NULL
            ELSE m.expires_at END AS until
  FROM people p
  JOIN external_access ea ON ea.person_id = p.id AND ea.enabled_at IS NOT NULL AND ea.disabled_at IS NULL
  JOIN spaces s ON s.instance_id = p.instance_id AND s.archived_at IS NULL
  LEFT JOIN space_members_effective m ON m.space_id = s.id AND m.person_id = p.id AND s.kind <> 'personal'
 WHERE p.active
   AND ((s.kind = 'personal' AND s.owner_id = p.id)
        OR (s.kind = 'org' AND p.active AND COALESCE(p.attrs->>'demo', '') <> 'true')
        OR m.person_id IS NOT NULL);

CREATE OR REPLACE VIEW v_edge_links_control WITH (security_barrier) AS
SELECT k.id, k.src_id, k.dst_id, k.relation, k.status
  FROM record_links k
  JOIN v_edge_gate_control a ON a.record_id = k.src_id AND a.ok
  JOIN v_edge_gate_control b ON b.record_id = k.dst_id AND b.ok
 WHERE k.status IN ('active', 'confirmed') AND k.detail_class = 'open';

CREATE OR REPLACE VIEW v_edge_entities_control WITH (security_barrier) AS
SELECT e.id AS entity_id, e.kind, e.display_name AS name, e.external_id AS slug
  FROM entities e
 WHERE e.kind = 'project' AND e.external_system = 'memory' AND e.external_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM edge_state es WHERE es.kind = 'entity' AND es.id = e.id AND es.gen > COALESCE(es.tomb_gen, 0));

CREATE OR REPLACE VIEW v_edge_export_settings WITH (security_barrier) AS
SELECT s.instance_id, k.name AS key, COALESCE(s.value, s.default_value) AS value,
       floor(extract(epoch FROM s.updated_at) * 1000)::bigint AS version
  FROM settings s JOIN edge_meta_keys k ON k.category = s.category AND k.key = s.key
 WHERE NOT s.secret
UNION ALL
SELECT s.instance_id, 'export_enabled', COALESCE(s.value, s.default_value), floor(extract(epoch FROM s.updated_at) * 1000)::bigint
  FROM settings s
 WHERE s.category = 'edge' AND s.key = 'export_enabled' AND NOT s.secret;

CREATE OR REPLACE VIEW v_edge_canary_hashes WITH (security_barrier) AS
SELECT encode(sha256(convert_to(c.marker, 'UTF8')), 'hex') AS marker_sha256
  FROM edge_canaries c;

ALTER VIEW v_edge_gate_control OWNER TO memory_edge_views;
ALTER VIEW v_edge_spaces OWNER TO memory_edge_views;
ALTER VIEW v_people_min OWNER TO memory_edge_views;
ALTER VIEW v_edge_projection OWNER TO memory_edge_views;
ALTER VIEW v_edge_links_control OWNER TO memory_edge_views;
ALTER VIEW v_edge_entities_control OWNER TO memory_edge_views;
ALTER VIEW v_edge_export_settings OWNER TO memory_edge_views;
ALTER VIEW v_edge_canary_hashes OWNER TO memory_edge_views;
REVOKE ALL ON v_edge_gate_control, v_edge_spaces, v_people_min, v_edge_projection, v_edge_links_control, v_edge_entities_control,
              v_edge_export_settings, v_edge_canary_hashes FROM PUBLIC;

CREATE OR REPLACE FUNCTION edge_next_gen(prev bigint) RETURNS bigint
LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
    SELECT greatest(COALESCE(prev, 0) + 1, floor(extract(epoch FROM clock_timestamp()) * 1e6)::bigint)
$$;

CREATE OR REPLACE FUNCTION edge_outbox_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE((SELECT enabled FROM edge_outbox_control_state WHERE one), false)
$$;

CREATE OR REPLACE FUNCTION edge_revoke_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE((SELECT enabled OR revoke_enabled FROM edge_outbox_control_state WHERE one), false)
$$;

CREATE OR REPLACE FUNCTION edge_revoke_item_merge(a jsonb, b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT CASE WHEN a IS NULL THEN b WHEN b IS NULL THEN a ELSE
        (a || b) - 'generation' - 'before' - 'external_access_off' - 'keep'
        || CASE WHEN a ? 'generation' AND b ? 'generation'
                THEN jsonb_build_object('generation', greatest((a->>'generation')::numeric, (b->>'generation')::numeric))
                ELSE '{}'::jsonb END
        || CASE WHEN a ? 'before' AND b ? 'before'
                THEN jsonb_build_object('before', CASE WHEN (a->>'before')::timestamptz >= (b->>'before')::timestamptz
                                                       THEN a->'before' ELSE b->'before' END)
                ELSE '{}'::jsonb END
        || CASE WHEN a ? 'external_access_off' OR b ? 'external_access_off'
                THEN jsonb_build_object('external_access_off', COALESCE((a->>'external_access_off')::boolean, false)
                                                               OR COALESCE((b->>'external_access_off')::boolean, false))
                ELSE '{}'::jsonb END
        || CASE WHEN a ? 'keep' AND b ? 'keep'
                THEN jsonb_build_object('keep', COALESCE((SELECT jsonb_agg(x ORDER BY x) FROM jsonb_array_elements_text(a->'keep') x
                                                           WHERE x IN (SELECT jsonb_array_elements_text(b->'keep'))), '[]'::jsonb))
                ELSE '{}'::jsonb END
    END
$$;

CREATE OR REPLACE FUNCTION edge_enqueue(p_lane text, p_kind text, p_ids uuid[], p_reason text, p_item jsonb DEFAULT NULL) RETURNS int
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
    INSERT INTO edge_outbox_control AS q (lane, kind, id, reason, item)
    SELECT p_lane, p_kind, d.u, p_reason, p_item FROM (SELECT DISTINCT u FROM unnest(p_ids) u WHERE u IS NOT NULL) d
    ON CONFLICT (lane, kind, id) WHERE processed_at IS NULL AND batch_id IS NULL
       DO UPDATE SET item = edge_revoke_item_merge(q.item, EXCLUDED.item), reason = EXCLUDED.reason WHERE EXCLUDED.item IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
        PERFORM pg_notify('edge_outbox_' || p_lane, '');
    END IF;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_revoke_mark(p_kind text, p_ids uuid[], p_reason text, p_sticky boolean)
RETURNS TABLE(id uuid, tomb_gen bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN;
    END IF;
    IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'edge_revoke_mark: reason — a code [a-z][a-z0-9_]{0,63}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO edge_state (kind, id) SELECT DISTINCT p_kind, u FROM unnest(p_ids) u WHERE u IS NOT NULL
    ON CONFLICT (kind, id) DO NOTHING;
    PERFORM 1 FROM edge_state s WHERE s.kind = p_kind AND s.id = ANY (p_ids) ORDER BY s.id FOR UPDATE;
    IF p_sticky AND p_kind = 'record' THEN
        INSERT INTO edge_hold (record_id, reason, source)
        SELECT s.id,
               CASE WHEN p_reason = 'deleted'
                         AND EXISTS (SELECT 1 FROM record_locations l WHERE l.record_id = s.id AND NOT l.deleted) THEN 'close_requested'
                    WHEN p_reason = 'hidden'
                         AND EXISTS (SELECT 1 FROM record_locations l
                                      WHERE l.record_id = s.id AND NOT l.deleted
                                        AND (l.class = 'closed'
                                             OR EXISTS (SELECT 1 FROM class_moves m WHERE m.record_id = s.id AND m.from_class = 'open'
                                                           AND m.status IN ('pending', 'copying', 'verifying')))) THEN 'close_requested'
                    ELSE p_reason END,
               'revoke_mark'
          FROM edge_state s
         WHERE s.kind = 'record' AND s.id = ANY (p_ids) AND (s.exported_gen IS NOT NULL OR s.gen > COALESCE(s.tomb_gen, 0))
        ON CONFLICT (record_id, reason) DO NOTHING;
        PERFORM edge_hold_drop(ARRAY(SELECT h.record_id FROM edge_hold h WHERE h.record_id = ANY (p_ids) AND h.reason = 'close_requested'),
                               ARRAY['hidden']);
    END IF;
    RETURN QUERY
    WITH nxt AS (SELECT s.kind, s.id, edge_next_gen(greatest(s.gen, COALESCE(s.tomb_gen, 0))) AS g
                   FROM edge_state s WHERE s.kind = p_kind AND s.id = ANY (p_ids)),
         upd AS (UPDATE edge_state s SET tomb_gen = n.g, gen = n.g FROM nxt n
                  WHERE s.kind = n.kind AND s.id = n.id RETURNING s.id, s.tomb_gen)
    SELECT upd.id, upd.tomb_gen FROM upd;
END $$;

CREATE OR REPLACE FUNCTION edge_hold_drop(p_ids uuid[], p_reasons text[]) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 OR p_reasons IS NULL OR cardinality(p_reasons) = 0 THEN
        RETURN 0;
    END IF;
    WITH gone AS (DELETE FROM edge_hold h WHERE h.record_id = ANY (p_ids) AND h.reason = ANY (p_reasons) RETURNING 1)
    SELECT count(*) INTO n FROM gone;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_links_of(p_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT COALESCE(array_agg(k.id), '{}') FROM record_links k WHERE k.src_id = ANY (p_ids) OR k.dst_id = ANY (p_ids)
$$;

CREATE OR REPLACE FUNCTION edge_revoke_records(p_ids uuid[], p_reason text, p_sticky boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    links uuid[];
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 OR NOT edge_revoke_on() THEN
        RETURN;
    END IF;
    PERFORM edge_enqueue('revoke', 'record', p_ids, p_reason);
    PERFORM edge_revoke_mark('record', p_ids, p_reason, p_sticky);
    IF p_reason <> 'space_change' THEN
        links := edge_links_of(p_ids);
        IF cardinality(links) > 0 THEN
            PERFORM edge_enqueue('revoke', 'link', links, 'link_down');
            PERFORM edge_revoke_mark('link', links, 'link_down', false);
        END IF;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION edge_revoke_refs(p_kind text, p_ids uuid[], p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 OR NOT edge_revoke_on() THEN
        RETURN;
    END IF;
    PERFORM edge_enqueue('revoke', p_kind, p_ids, p_reason);
    PERFORM edge_revoke_mark(p_kind, p_ids, p_reason, false);
END $$;

CREATE OR REPLACE FUNCTION edge_publish_records(p_ids uuid[], p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 OR NOT edge_outbox_on() THEN
        RETURN;
    END IF;
    PERFORM edge_enqueue('publish', 'record', p_ids, p_reason);
    PERFORM edge_enqueue('publish', 'link', edge_links_of(p_ids), p_reason);
END $$;

CREATE OR REPLACE FUNCTION edge_revoke_access(p_people uuid[], p_reason text, p_item jsonb DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_people IS NULL OR cardinality(p_people) = 0 OR NOT edge_revoke_on() THEN
        RETURN;
    END IF;
    PERFORM edge_enqueue('revoke', 'person_access',
                         ARRAY(SELECT ea.person_id FROM external_access ea
                                WHERE ea.person_id = ANY (p_people) AND ((ea.enabled_at IS NOT NULL AND ea.disabled_at IS NULL) OR p_item IS NOT NULL)),
                         p_reason, p_item);
END $$;

CREATE OR REPLACE FUNCTION edge_enqueue_revoke(p_item jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    t      text;
    raw    text;
    v_id   uuid;
    v_kind text;
    v_seq  bigint;
BEGIN
    IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
        RAISE EXCEPTION 'edge_enqueue_revoke: the item is a RevokeItem object' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_item) k
                WHERE k NOT IN ('type', 'id', 'generation', 'before', 'reason', 'external_access_off', 'keep')) THEN
        RAISE EXCEPTION 'edge_enqueue_revoke: extra RevokeItem field' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    t := p_item->>'type';
    raw := p_item->>'id';
    IF t IS NULL OR raw IS NULL OR length(raw) NOT BETWEEN 1 AND 256 OR COALESCE(p_item->>'reason', '') !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'edge_enqueue_revoke: type, id (1–256) and reason ([a-z][a-z0-9_]{0,63}) are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    v_kind := CASE t WHEN 'person_projection' THEN 'person_access' ELSE t END;
    IF raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_id := raw::uuid;
    ELSE
        v_id := md5(t || ':' || raw)::uuid;
    END IF;
    INSERT INTO edge_outbox_control AS q (lane, kind, id, reason, item)
    VALUES ('revoke', v_kind, v_id, p_item->>'reason', p_item)
    ON CONFLICT (lane, kind, id) WHERE processed_at IS NULL AND batch_id IS NULL
       DO UPDATE SET item = edge_revoke_item_merge(q.item, EXCLUDED.item), reason = EXCLUDED.reason
    RETURNING q.seq INTO v_seq;
    PERFORM pg_notify('edge_outbox_revoke', '');
    RETURN v_seq;
END $$;

CREATE OR REPLACE FUNCTION edge_gate_claim(p_ids uuid[]) RETURNS TABLE(id uuid, gen bigint, ok boolean, why text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN;
    END IF;
    IF cardinality(p_ids) > 5000 THEN
        RAISE EXCEPTION 'edge_gate_claim: not more than 5000 ids per call' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO edge_state (kind, id) SELECT DISTINCT 'record', u FROM unnest(p_ids) u WHERE u IS NOT NULL
    ON CONFLICT (kind, id) DO NOTHING;
    PERFORM 1 FROM edge_state s WHERE s.kind = 'record' AND s.id = ANY (p_ids) ORDER BY s.id FOR UPDATE;
    RETURN QUERY
    WITH want AS (SELECT DISTINCT u AS id FROM unnest(p_ids) u WHERE u IS NOT NULL),
         chk AS (SELECT w.id,
                        CASE WHEN g.record_id IS NULL OR NOT g.c1 THEN 'c1' WHEN NOT g.c2 THEN 'c2' WHEN NOT g.c3 THEN 'c3'
                             WHEN NOT g.c4 THEN 'c4' WHEN NOT g.c5 THEN 'c5' WHEN NOT g.c9_control THEN 'c9'
                             WHEN g.canary THEN 'canary' END AS why
                   FROM want w LEFT JOIN v_edge_gate_control g ON g.record_id = w.id),
         upd AS (UPDATE edge_state s SET gen = edge_next_gen(greatest(s.gen, COALESCE(s.tomb_gen, 0)))
                   FROM chk c WHERE c.why IS NULL AND s.kind = 'record' AND s.id = c.id
                 RETURNING s.id, s.gen)
    SELECT c.id, u.gen, c.why IS NULL, c.why FROM chk c LEFT JOIN upd u ON u.id = c.id;
END $$;

CREATE OR REPLACE FUNCTION edge_ref_ok(p_kind text, p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT CASE p_kind
        WHEN 'link' THEN EXISTS (SELECT 1 FROM v_edge_links_control v WHERE v.id = p_id)
        WHEN 'space' THEN EXISTS (SELECT 1 FROM spaces s WHERE s.id = p_id AND s.archived_at IS NULL AND s.slug <> 'demo-showcase'
                                     AND NOT EXISTS (SELECT 1 FROM people sp WHERE sp.id = s.owner_id
                                                        AND (COALESCE(sp.attrs->>'demo', '') = 'true' OR lower(sp.login) = ANY (tp_showcase_logins())))
                                     AND NOT EXISTS (SELECT 1 FROM org_units u WHERE u.id = s.org_unit_id AND u.code = 'demo'))
        WHEN 'person' THEN EXISTS (SELECT 1 FROM people p WHERE p.id = p_id AND COALESCE(p.attrs->>'demo', '') <> 'true'
                                      AND NOT COALESCE(lower(p.login) = ANY (tp_showcase_logins()), false))
        WHEN 'entity' THEN EXISTS (SELECT 1 FROM entities e WHERE e.id = p_id AND e.kind = 'project' AND e.external_system = 'memory'
                                      AND e.external_id IS NOT NULL)
        ELSE false END
$$;

CREATE OR REPLACE FUNCTION edge_ref_live(p_kind text, p_ids uuid[]) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    live uuid[];
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN '{}';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT u), '{}') INTO live
      FROM unnest(p_ids) u
     WHERE u IS NOT NULL
       AND (EXISTS (SELECT 1 FROM edge_state es WHERE es.kind = p_kind AND es.id = u AND es.gen > COALESCE(es.tomb_gen, 0))
            OR (p_kind = 'space' AND EXISTS (SELECT 1 FROM v_edge_gate_control g WHERE g.space_id = u AND g.ok))
            OR (p_kind = 'person' AND (EXISTS (SELECT 1 FROM v_edge_gate_control g WHERE g.owner_id = u AND g.ok)
                                       OR EXISTS (SELECT 1 FROM external_access ea
                                                   WHERE ea.person_id = u AND ea.enabled_at IS NOT NULL AND ea.disabled_at IS NULL))));
    RETURN live;
END $$;

CREATE OR REPLACE FUNCTION edge_ref_claim(p_kind text, p_ids uuid[]) RETURNS TABLE(id uuid, gen bigint, ok boolean, why text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
    IF p_kind NOT IN ('link', 'space', 'person', 'entity') THEN
        RAISE EXCEPTION 'edge_ref_claim: kind — link, space, person, entity' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN;
    END IF;
    IF cardinality(p_ids) > 5000 THEN
        RAISE EXCEPTION 'edge_ref_claim: not more than 5000 ids per call' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO edge_state (kind, id) SELECT DISTINCT p_kind, u FROM unnest(p_ids) u WHERE u IS NOT NULL
    ON CONFLICT (kind, id) DO NOTHING;
    PERFORM 1 FROM edge_state s WHERE s.kind = p_kind AND s.id = ANY (p_ids) ORDER BY s.id FOR UPDATE;
    RETURN QUERY
    WITH chk AS (SELECT w.id, CASE WHEN edge_ref_ok(p_kind, w.id) THEN NULL ELSE 'not_eligible' END AS why
                   FROM (SELECT DISTINCT u AS id FROM unnest(p_ids) u WHERE u IS NOT NULL) w),
         upd AS (UPDATE edge_state s SET gen = edge_next_gen(greatest(s.gen, COALESCE(s.tomb_gen, 0)))
                   FROM chk c WHERE c.why IS NULL AND s.kind = p_kind AND s.id = c.id
                 RETURNING s.id, s.gen)
    SELECT c.id, u.gen, c.why IS NULL, c.why FROM chk c LEFT JOIN upd u ON u.id = c.id;
END $$;

CREATE OR REPLACE FUNCTION edge_gate_recheck(p_items jsonb) RETURNS TABLE(id uuid, ok boolean, why text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'edge_gate_recheck: an array of items {kind, id, gen, chain}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    WITH it AS (SELECT o.n, COALESCE(o.e->>'kind', 'record') AS kind, (o.e->>'id')::uuid AS id, (o.e->>'gen')::bigint AS gen,
                       CASE WHEN jsonb_typeof(o.e->'chain') = 'array' THEN o.e->'chain' END AS chain
                  FROM jsonb_array_elements(p_items) WITH ORDINALITY o(e, n)),
         anc AS (SELECT it.n,
                        min(CASE WHEN g.record_id IS NULL OR NOT g.c1 THEN 1 WHEN NOT g.c2 THEN 2 WHEN NOT g.c3 THEN 3
                                 WHEN NOT g.c4 THEN 4 WHEN NOT g.c5 THEN 5 END) AS bad
                   FROM it
                   CROSS JOIN LATERAL jsonb_array_elements_text(it.chain) a(x)
                   LEFT JOIN v_edge_gate_control g ON g.record_id = a.x::uuid
                  WHERE it.kind = 'record' AND it.chain IS NOT NULL
                  GROUP BY it.n),
         chk AS (SELECT it.n, it.id,
                        CASE WHEN it.kind = 'record' THEN
                                 CASE WHEN g.record_id IS NULL OR NOT g.c1 THEN 'c1' WHEN NOT g.c2 THEN 'c2' WHEN NOT g.c3 THEN 'c3'
                                      WHEN NOT g.c4 THEN 'c4' WHEN NOT g.c5 THEN 'c5' WHEN NOT g.c9_control THEN 'c9'
                                      WHEN g.canary THEN 'canary' WHEN it.chain IS NULL THEN 'chain'
                                      WHEN a.bad IS NOT NULL THEN 'chain_c' || a.bad END
                             WHEN NOT edge_ref_ok(it.kind, it.id) THEN 'not_eligible' END AS why_gate,
                        (s.id IS NULL OR it.gen IS NULL OR s.gen <> it.gen OR it.gen <= COALESCE(s.tomb_gen, 0)) AS stale
                   FROM it
                   LEFT JOIN anc a ON a.n = it.n
                   LEFT JOIN v_edge_gate_control g ON it.kind = 'record' AND g.record_id = it.id
                   LEFT JOIN edge_state s ON s.kind = it.kind AND s.id = it.id)
    SELECT c.id, c.why_gate IS NULL AND NOT c.stale, COALESCE(c.why_gate, CASE WHEN c.stale THEN 'c6' END) FROM chk c ORDER BY c.n;
END $$;

CREATE OR REPLACE FUNCTION edge_mark_exported(p_items jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
        RAISE EXCEPTION 'edge_mark_exported: an array of items {kind, id, gen}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE edge_state s SET exported_gen = greatest(COALESCE(s.exported_gen, 0), it.gen), exported_at = now()
      FROM (SELECT COALESCE(e->>'kind', 'record') AS kind, (e->>'id')::uuid AS id, (e->>'gen')::bigint AS gen
              FROM jsonb_array_elements(p_items) e) it
     WHERE s.kind = it.kind AND s.id = it.id AND it.gen IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_kill(p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_reason IS NULL OR p_reason !~ '^[a-z_]{1,32}$' THEN
        RAISE EXCEPTION 'edge_kill: reason — a code [a-z_]{1,32}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_reason = 'restore' THEN
        UPDATE edge_export_status SET killed_reason = 'restore', killed_at = now(), updated_at = now();
        BEGIN
            EXECUTE 'UPDATE edge_export_status SET restore_auth_at = NULL';
        EXCEPTION WHEN undefined_column THEN NULL;
        END;
    ELSE
        UPDATE edge_export_status
           SET killed_reason = CASE WHEN killed_at IS NULL THEN p_reason ELSE killed_reason END,
               killed_at = COALESCE(killed_at, now()), updated_at = now();
    END IF;
    IF to_regclass('auth_pause') IS NOT NULL THEN
        BEGIN
            EXECUTE 'INSERT INTO auth_pause (id, instance_id, until, reason, "by") SELECT gen_random_uuid(), i.id, ''infinity'', ''kill'', ''auto'' FROM instances i'
                    || ' WHERE NOT EXISTS (SELECT 1 FROM auth_pause a WHERE a.instance_id = i.id AND a.reason = ''kill'' AND a.lifted_at IS NULL)';
        EXCEPTION WHEN OTHERS THEN
            UPDATE edge_export_status SET last_result = COALESCE(last_result, '{}'::jsonb) || jsonb_build_object('auth_pause', 'failed', 'sqlstate', SQLSTATE);
        END;
    END IF;
    PERFORM pg_notify('edge_kill', p_reason);
END $$;

CREATE OR REPLACE FUNCTION edge_unkill(p_by text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    was boolean;
BEGIN
    IF p_by IS NULL OR length(p_by) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'edge_unkill: who lifts it — required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT killed_at IS NOT NULL INTO was FROM edge_export_status WHERE one;
    UPDATE edge_export_status SET killed_at = NULL, killed_reason = NULL, updated_at = now();
    IF to_regclass('auth_pause') IS NOT NULL THEN
        BEGIN
            EXECUTE 'UPDATE auth_pause SET lifted_at = now(), lifted_by = $1 WHERE reason = ''kill'' AND lifted_at IS NULL' USING p_by;
        EXCEPTION WHEN OTHERS THEN
            UPDATE edge_export_status SET last_result = COALESCE(last_result, '{}'::jsonb) || jsonb_build_object('auth_pause_lift', 'failed', 'sqlstate', SQLSTATE);
        END;
    END IF;
    RETURN COALESCE(was, false);
END $$;

CREATE OR REPLACE FUNCTION edge_hold_release(p_record uuid, p_person uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    released text[];
BEGIN
    IF p_record IS NULL OR p_person IS NULL THEN
        RAISE EXCEPTION 'edge_hold_release: record and person are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM record_locations l
                     JOIN people p ON p.id = p_person AND p.active
                     JOIN spaces s ON s.id = l.space_id
                    WHERE l.record_id = p_record
                      AND (l.owner_id = p_person
                           OR (s.archived_at IS NULL AND s.owner_id = p_person AND (s.kind = 'personal' OR s.org_unit_id IS NULL))
                           OR (s.archived_at IS NULL AND s.kind <> 'personal'
                               AND EXISTS (SELECT 1 FROM space_members_effective m
                                            WHERE m.space_id = s.id AND m.person_id = p_person AND m.role IN ('owner', 'member'))))) THEN
        RAISE EXCEPTION 'edge_hold_release: no right to write' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT COALESCE(array_agg(h.reason ORDER BY h.reason), '{}') INTO released
      FROM edge_hold h WHERE h.record_id = p_record
                         AND h.reason IN ('close_requested', 'hidden', 'deleted', 'audience_people', 'restore_tomb');
    PERFORM edge_hold_drop(ARRAY[p_record], released);
    PERFORM edge_publish_records(ARRAY[p_record], 'hold_released');
    RETURN released;
END $$;

CREATE OR REPLACE FUNCTION edge_restore_hold(p_ids uuid[]) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN 0;
    END IF;
    INSERT INTO edge_hold (record_id, reason, source)
    SELECT DISTINCT u, 'restore_tomb', 'restore_rebase' FROM unnest(p_ids) u WHERE u IS NOT NULL
    ON CONFLICT (record_id, reason) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_enqueue_publish(p_ids uuid[], p_reason text, p_kind text DEFAULT 'record') RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_kind NOT IN ('record', 'link', 'space', 'person', 'entity', 'projection', 'meta') THEN
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
    WITH gone AS (DELETE FROM edge_outbox_control q WHERE q.processed_at IS NOT NULL AND q.processed_at < now() - p_keep RETURNING 1)
    SELECT count(*) INTO n FROM gone;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_outbox_set(p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_enabled IS NULL THEN
        RAISE EXCEPTION 'edge_outbox_set: yes or no' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE edge_outbox_control_state SET enabled = p_enabled, revoke_enabled = revoke_enabled OR p_enabled, changed_at = now()
     WHERE one AND (enabled IS DISTINCT FROM p_enabled OR (p_enabled AND NOT revoke_enabled));
    IF NOT p_enabled THEN
        UPDATE edge_outbox_control SET processed_at = now() WHERE processed_at IS NULL AND lane = 'publish';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION edge_reconcile_report(p_kind text, p_canary_ok boolean, p_result jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_kind IS NULL OR p_kind NOT IN ('light', 'full') THEN
        RAISE EXCEPTION 'edge_reconcile_report: kind — light or full' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_result IS NOT NULL AND (jsonb_typeof(p_result) <> 'object' OR octet_length(p_result::text) > 8192) THEN
        RAISE EXCEPTION 'edge_reconcile_report: result — an object up to 8 KiB' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE edge_export_status
       SET last_light_at = CASE WHEN p_kind = 'light' THEN now() ELSE last_light_at END,
           last_full_at = CASE WHEN p_kind = 'full' THEN now() ELSE last_full_at END,
           reconcile_result = COALESCE(p_result, reconcile_result),
           canary_checked_at = CASE WHEN p_canary_ok IS NULL THEN canary_checked_at ELSE now() END,
           canary_tripped_at = CASE WHEN p_canary_ok IS NULL THEN canary_tripped_at
                                    WHEN p_canary_ok THEN NULL ELSE COALESCE(canary_tripped_at, now()) END,
           updated_at = now()
     WHERE one;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_locations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r record;
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT n.record_id FROM new_t n WHERE n.class = 'open' AND NOT n.deleted), 'new');
    ELSIF TG_OP = 'UPDATE' THEN
        FOR r IN
            SELECT x.reason, array_agg(x.record_id) AS ids
              FROM (SELECT n.record_id,
                           CASE WHEN o.class = 'open' AND n.class = 'closed' THEN 'close_requested'
                                WHEN NOT o.deleted AND n.deleted THEN 'deleted'
                                WHEN o.open_check IS NULL AND n.open_check IS NOT NULL THEN 'open_check'
                                WHEN o.space_id <> n.space_id THEN 'space_change' END AS reason
                      FROM old_t o JOIN new_t n ON n.record_id = o.record_id) x
             WHERE x.reason IS NOT NULL
             GROUP BY x.reason
        LOOP
            PERFORM edge_revoke_records(r.ids, r.reason, r.reason <> 'space_change');
        END LOOP;
        PERFORM edge_hold_drop(ARRAY(SELECT n.record_id FROM old_t o JOIN new_t n ON n.record_id = o.record_id
                                      WHERE o.class = 'closed' AND n.class = 'open'),
                               ARRAY['close_requested', 'hidden', 'open_check', 'held']);
        PERFORM edge_publish_records(ARRAY(
            SELECT n.record_id FROM old_t o JOIN new_t n ON n.record_id = o.record_id
             WHERE n.class = 'open' AND NOT n.deleted AND n.open_check IS NULL
               AND (o.class, o.deleted, o.space_id, o.owner_id, o.type, o.open_check IS NULL)
                   IS DISTINCT FROM (n.class, n.deleted, n.space_id, n.owner_id, n.type, n.open_check IS NULL)), 'widen');
    ELSE
        PERFORM edge_revoke_records(ARRAY(SELECT o.record_id FROM old_t o), 'deleted', true);
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_class_moves() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    ids uuid[];
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM edge_revoke_records(ARRAY(SELECT DISTINCT n.record_id FROM new_t n WHERE n.from_class = 'open'), 'close_requested', true);
    ELSIF TG_OP = 'UPDATE' THEN
        ids := ARRAY(SELECT DISTINCT n.record_id FROM old_t o JOIN new_t n ON n.id = o.id
                      WHERE n.status = 'done' AND o.status IS DISTINCT FROM 'done' AND n.to_class = 'open');
        IF cardinality(ids) > 0 THEN
            PERFORM edge_hold_drop(ids, ARRAY['close_requested', 'hidden', 'open_check', 'held']);
            PERFORM edge_publish_records(ids, 'widen');
        END IF;
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r record;
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        FOR r IN SELECT n.reason, array_agg(n.record_id) AS ids FROM new_t n WHERE n.source <> 'revoke_mark' GROUP BY n.reason LOOP
            PERFORM edge_revoke_records(r.ids, r.reason, false);
        END LOOP;
    ELSIF TG_OP <> 'UPDATE' THEN
        PERFORM edge_publish_records(ARRAY(SELECT DISTINCT o.record_id FROM old_t o
                                            WHERE NOT EXISTS (SELECT 1 FROM edge_hold h WHERE h.record_id = o.record_id)), 'hold_released');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_org_reviews() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    ids uuid[];
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM edge_revoke_records(ARRAY(SELECT n.record_id FROM new_t n WHERE n.held_at IS NOT NULL), 'org_review', true);
        PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT n.record_id FROM new_t n WHERE n.held_at IS NULL), 'meta_change');
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM edge_revoke_records(ARRAY(SELECT n.record_id FROM old_t o JOIN new_t n ON n.record_id = o.record_id
                                           WHERE o.held_at IS NULL AND n.held_at IS NOT NULL), 'org_review', true);
        ids := ARRAY(SELECT n.record_id FROM old_t o JOIN new_t n ON n.record_id = o.record_id WHERE o.held_at IS NOT NULL AND n.held_at IS NULL);
        IF cardinality(ids) > 0 THEN
            PERFORM edge_hold_drop(ids, ARRAY['org_review']);
            PERFORM edge_publish_records(ids, 'hold_released');
        END IF;
        PERFORM edge_enqueue('publish', 'record', ARRAY(SELECT n.record_id FROM old_t o JOIN new_t n ON n.record_id = o.record_id
                                                         WHERE n.held_at IS NULL AND o.state IS DISTINCT FROM n.state), 'meta_change');
    ELSE
        ids := ARRAY(SELECT o.record_id FROM old_t o);
        PERFORM edge_hold_drop(ids, ARRAY['org_review']);
        PERFORM edge_enqueue('publish', 'record', ids, 'meta_change');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_spaces() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    nil   CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
    down  uuid[];
    up    uuid[];
    moved uuid[];
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM edge_enqueue('publish', 'projection', ARRAY[nil], 'projection_grow');
    ELSIF TG_OP = 'UPDATE' THEN
        down := ARRAY(SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                       WHERE (o.archived_at IS NULL AND n.archived_at IS NOT NULL)
                          OR (n.archived_at IS NULL AND (o.kind, o.org_unit_id) IS DISTINCT FROM (n.kind, n.org_unit_id)));
        IF cardinality(down) > 0 THEN
            PERFORM edge_revoke_refs('space', down, 'space_down');
            PERFORM edge_revoke_records(ARRAY(SELECT l.record_id FROM record_locations l, new_t n
                                               WHERE n.id = ANY (down) AND l.space_id = n.id AND l.class = 'open' AND n.archived_at IS NOT NULL),
                                        'space_down', false);
        END IF;
        up := ARRAY(SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                     WHERE n.archived_at IS NULL
                       AND (o.archived_at IS NOT NULL
                            OR (o.name, o.slug, o.description, o.readme, o.kind, o.org_unit_id)
                               IS DISTINCT FROM (n.name, n.slug, n.description, n.readme, n.kind, n.org_unit_id)));
        IF cardinality(up) > 0 THEN
            PERFORM edge_enqueue('publish', 'space', edge_ref_live('space', up), 'meta_change');
            PERFORM edge_enqueue('publish', 'projection', ARRAY[nil], 'projection_grow');
        END IF;
        moved := ARRAY(SELECT l.record_id FROM old_t o JOIN new_t n ON n.id = o.id JOIN record_locations l ON l.space_id = n.id
                        WHERE n.archived_at IS NULL AND l.class = 'open' AND NOT l.deleted
                          AND (o.archived_at IS NOT NULL OR o.slug <> n.slug));
        PERFORM edge_publish_records(moved, 'meta_change');
    ELSE
        PERFORM edge_revoke_refs('space', ARRAY(SELECT o.id FROM old_t o), 'space_down');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    nil CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
    off uuid[];
    onn uuid[];
    r   record;
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_TABLE_NAME = 'external_access' THEN
        IF TG_OP = 'INSERT' THEN
            onn := ARRAY(SELECT n.person_id FROM new_t n WHERE n.enabled_at IS NOT NULL AND n.disabled_at IS NULL);
        ELSIF TG_OP = 'UPDATE' THEN
            onn := ARRAY(SELECT n.person_id FROM old_t o JOIN new_t n ON n.person_id = o.person_id
                          WHERE n.enabled_at IS NOT NULL AND n.disabled_at IS NULL AND NOT (o.enabled_at IS NOT NULL AND o.disabled_at IS NULL));
            off := ARRAY(SELECT n.person_id FROM old_t o JOIN new_t n ON n.person_id = o.person_id
                          WHERE o.enabled_at IS NOT NULL AND o.disabled_at IS NULL AND NOT (n.enabled_at IS NOT NULL AND n.disabled_at IS NULL));
        ELSE
            off := ARRAY(SELECT o.person_id FROM old_t o WHERE o.enabled_at IS NOT NULL AND o.disabled_at IS NULL);
        END IF;
        IF cardinality(off) > 0 THEN
            FOR r IN SELECT m.id, m.tomb_gen FROM edge_revoke_mark('person', off, 'person_access', false) m LOOP
                PERFORM edge_enqueue('revoke', 'person_access', ARRAY[r.id], 'person_access',
                                     jsonb_build_object('external_access_off', true, 'generation', r.tomb_gen));
            END LOOP;
            PERFORM edge_enqueue('publish', 'person', edge_ref_live('person', off), 'meta_change');
        END IF;
        IF cardinality(onn) > 0 THEN
            PERFORM edge_enqueue('publish', 'person', edge_ref_live('person', onn), 'meta_change');
            PERFORM edge_enqueue('publish', 'projection', ARRAY[nil], 'projection_grow');
        END IF;
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM edge_enqueue('publish', 'projection', ARRAY[nil], 'projection_grow');
    ELSE
        PERFORM edge_revoke_access(ARRAY(SELECT DISTINCT (to_jsonb(o)->>'person_id')::uuid FROM old_t o), 'person_access');
        PERFORM edge_enqueue('publish', 'projection', ARRAY[nil], 'projection_grow');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_space_groups() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    nil CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        PERFORM edge_revoke_access(ARRAY(SELECT DISTINCT d.person_id FROM old_t o JOIN directory_group_members d ON d.group_key = o.group_key),
                                   'person_access');
    END IF;
    PERFORM edge_enqueue('publish', 'projection', ARRAY[nil], 'projection_grow');
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_people() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    nil  CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
    gone uuid[];
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        gone := ARRAY(SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id WHERE o.active AND NOT n.active);
        IF cardinality(gone) > 0 THEN
            PERFORM edge_revoke_refs('person', gone, 'person_access');
        END IF;
        PERFORM edge_revoke_access(ARRAY(SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                                          WHERE COALESCE(o.attrs->>'demo', '') <> 'true' AND COALESCE(n.attrs->>'demo', '') = 'true'), 'person_access');
        PERFORM edge_enqueue('publish', 'person', edge_ref_live('person', ARRAY(
                                 SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                                  WHERE (o.display_name, o.login, o.active) IS DISTINCT FROM (n.display_name, n.login, n.active))),
                             'meta_change');
        IF EXISTS (SELECT 1 FROM old_t o JOIN new_t n ON n.id = o.id
                    WHERE (o.active, COALESCE(o.attrs->>'demo', '')) IS DISTINCT FROM (n.active, COALESCE(n.attrs->>'demo', ''))) THEN
            PERFORM edge_enqueue('publish', 'projection', ARRAY[nil], 'projection_grow');
        END IF;
    ELSIF TG_OP <> 'INSERT' THEN
        PERFORM edge_revoke_refs('person', ARRAY(SELECT o.id FROM old_t o), 'person_access');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
        PERFORM edge_enqueue('publish', 'link', ARRAY(SELECT n.id FROM new_t n
                                                       WHERE n.status IN ('active', 'confirmed') AND n.detail_class = 'open'), 'new');
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM edge_revoke_refs('link', ARRAY(SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                                                WHERE o.status IN ('active', 'confirmed') AND o.detail_class = 'open'
                                                  AND NOT (n.status IN ('active', 'confirmed') AND n.detail_class = 'open')), 'link_down');
        PERFORM edge_enqueue('publish', 'link', ARRAY(SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                                                       WHERE n.status IN ('active', 'confirmed') AND n.detail_class = 'open'
                                                         AND (o.status, o.detail_class, o.relation, o.src_id, o.dst_id)
                                                             IS DISTINCT FROM (n.status, n.detail_class, n.relation, n.src_id, n.dst_id)),
                             'meta_change');
    ELSE
        PERFORM edge_revoke_refs('link', ARRAY(SELECT o.id FROM old_t o), 'link_down');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_entities() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        PERFORM edge_revoke_refs('entity', ARRAY(SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                                                  WHERE o.kind = 'project' AND o.external_system = 'memory'
                                                    AND NOT (n.kind = 'project' AND n.external_system = 'memory')), 'entity_down');
        PERFORM edge_enqueue('publish', 'entity', edge_ref_live('entity', ARRAY(
                                 SELECT n.id FROM old_t o JOIN new_t n ON n.id = o.id
                                  WHERE n.kind = 'project' AND n.external_system = 'memory'
                                    AND (o.display_name, o.external_id, o.kind) IS DISTINCT FROM (n.display_name, n.external_id, n.kind))),
                             'meta_change');
    ELSIF TG_OP <> 'INSERT' THEN
        PERFORM edge_revoke_refs('entity', ARRAY(SELECT o.id FROM old_t o WHERE o.kind = 'project' AND o.external_system = 'memory'), 'entity_down');
    END IF;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_trg_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    nil CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
    hit boolean;
BEGIN
    IF NOT edge_revoke_on() THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        SELECT EXISTS (SELECT 1 FROM new_t n WHERE (n.category = 'edge' AND n.key = 'export_enabled')
                          OR EXISTS (SELECT 1 FROM edge_meta_keys k WHERE k.category = n.category AND k.key = n.key)) INTO hit;
    ELSE
        SELECT EXISTS (SELECT 1 FROM old_t o WHERE EXISTS (SELECT 1 FROM edge_meta_keys k WHERE k.category = o.category AND k.key = o.key)) INTO hit;
    END IF;
    IF hit THEN
        PERFORM edge_enqueue('publish', 'meta', ARRAY[nil], 'meta_change');
    END IF;
    RETURN NULL;
END $$;

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('record_locations', 'edge_trg_locations'), ('class_moves', 'edge_trg_class_moves'), ('edge_hold', 'edge_trg_hold'),
        ('org_reviews', 'edge_trg_org_reviews'), ('spaces', 'edge_trg_spaces'), ('space_members', 'edge_trg_access'),
        ('role_grants', 'edge_trg_access'), ('person_org_units', 'edge_trg_access'), ('directory_group_members', 'edge_trg_access'),
        ('external_access', 'edge_trg_access'), ('space_groups', 'edge_trg_space_groups'), ('people', 'edge_trg_people'),
        ('record_links', 'edge_trg_links'), ('entities', 'edge_trg_entities'), ('settings', 'edge_trg_settings')) v(tbl, fn)
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
                AND p.proname IN ('edge_next_gen', 'edge_outbox_on', 'edge_revoke_on', 'edge_revoke_item_merge', 'edge_enqueue',
                                  'edge_revoke_mark', 'edge_hold_drop', 'edge_links_of',
                                  'edge_revoke_records', 'edge_revoke_refs', 'edge_publish_records', 'edge_revoke_access',
                                  'edge_enqueue_revoke', 'edge_gate_claim', 'edge_ref_ok', 'edge_ref_live', 'edge_ref_claim', 'edge_gate_recheck',
                                  'edge_mark_exported', 'edge_kill', 'edge_unkill', 'edge_hold_release', 'edge_restore_hold',
                                  'edge_enqueue_publish', 'edge_outbox_gc', 'edge_outbox_set', 'edge_reconcile_report',
                                  'edge_trg_locations', 'edge_trg_class_moves',
                                  'edge_trg_hold', 'edge_trg_org_reviews', 'edge_trg_spaces', 'edge_trg_access', 'edge_trg_space_groups',
                                  'edge_trg_people', 'edge_trg_links', 'edge_trg_entities', 'edge_trg_settings')
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO memory_edge_views', f);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    END LOOP;
END $$;

GRANT SELECT ON v_edge_gate_control, v_edge_spaces, v_people_min, v_edge_projection, v_edge_links_control, v_edge_entities_control,
                v_edge_export_settings, v_edge_canary_hashes TO memory_exporter;
GRANT SELECT ON edge_outbox_control, edge_outbox_control_state, edge_export_status TO memory_exporter;
GRANT UPDATE (processed_at, batch_id) ON edge_outbox_control TO memory_exporter;
REVOKE UPDATE ON edge_export_status FROM memory_exporter;
GRANT UPDATE (watermark_sent_at, revoke_age_ms, revoke_pending, publish_pending, last_full_sync_at, last_result, updated_at)
      ON edge_export_status TO memory_exporter;
GRANT EXECUTE ON FUNCTION edge_revoke_mark(text, uuid[], text, boolean), edge_gate_claim(uuid[]), edge_ref_claim(text, uuid[]),
                          edge_gate_recheck(jsonb), edge_mark_exported(jsonb), edge_kill(text), edge_outbox_gc(interval),
                          edge_outbox_set(boolean) TO memory_exporter;

GRANT SELECT (record_id, class, space_id, owner_id, deleted, open_check) ON record_locations TO memory_reconciler;
GRANT SELECT (record_id, status, to_class) ON class_moves TO memory_reconciler;
GRANT SELECT (record_id, state, held_at) ON org_reviews TO memory_reconciler;
GRANT SELECT (id, slug, kind, archived_at, org_unit_id, owner_id) ON spaces TO memory_reconciler;
GRANT SELECT (id, code) ON org_units TO memory_reconciler;
GRANT SELECT (id, active, attrs, login) ON people TO memory_reconciler;
GRANT SELECT (id, src_id, dst_id, status, detail_class) ON record_links TO memory_reconciler;
GRANT SELECT ON space_members_effective, external_access, edge_hold, edge_state, edge_export_status TO memory_reconciler;
REVOKE SELECT ON edge_canaries FROM memory_reconciler;
GRANT SELECT (record_id, kind, created_at, retired_at) ON edge_canaries TO memory_reconciler;
GRANT SELECT ON v_edge_canary_hashes TO memory_reconciler;
GRANT EXECUTE ON FUNCTION edge_enqueue_publish(uuid[], text, text), edge_kill(text), edge_revoke_mark(text, uuid[], text, boolean),
                          edge_restore_hold(uuid[]), edge_reconcile_report(text, boolean, jsonb) TO memory_reconciler;

GRANT EXECUTE ON FUNCTION edge_hold_release(uuid, uuid) TO memory_gateway;
GRANT SELECT ON edge_hold, edge_export_status TO memory_gateway;
GRANT SELECT (kind, id, exported_gen, tomb_gen) ON edge_state TO memory_gateway;
REVOKE EXECUTE ON FUNCTION edge_unkill(text) FROM memory_admin_plane;

GRANT SELECT, INSERT ON edge_canaries TO memory_worker;
GRANT UPDATE (retired_at) ON edge_canaries TO memory_worker;

CREATE OR REPLACE VIEW v_edge_inner_settings WITH (security_barrier) AS
SELECT s.instance_id, s.category || '.' || s.key AS path, COALESCE(s.value, s.default_value) AS value
  FROM settings s
 WHERE s.category = 'edge' AND NOT s.secret;
ALTER VIEW v_edge_inner_settings OWNER TO memory_edge_views;
REVOKE ALL ON v_edge_inner_settings FROM PUBLIC;
GRANT SELECT ON v_edge_inner_settings TO memory_exporter, memory_intake, memory_reconciler;
GRANT SELECT (lane, kind, id, created_at, processed_at) ON edge_outbox_control TO memory_reconciler;
GRANT SELECT (name, description, readme, instance_id) ON spaces TO memory_reconciler;
GRANT SELECT (display_name, instance_id) ON people TO memory_reconciler;
GRANT SELECT (id, kind, external_system, external_id, display_name) ON entities TO memory_reconciler;
GRANT SELECT (relation) ON record_links TO memory_reconciler;
GRANT SELECT ON edge_outbox_control_state TO memory_gateway;

-- [1c]

-- [1d]

INSERT INTO edge_meta_keys (category, key, name) VALUES
    ('edge', 'quota_mode', 'quota_mode'),
    ('edge', 'quota_daily', 'quota_daily')
ON CONFLICT (category, key) DO NOTHING;

DO $$
BEGIN
    IF to_regclass('auth_pause') IS NOT NULL THEN
        GRANT SELECT (instance_id, until, lifted_at, started_at) ON auth_pause TO memory_reconciler;
    END IF;
END $$;

-- [1e]

INSERT INTO edge_meta_keys (category, key, name) VALUES
    ('edge', 'login_enabled', 'login_enabled'),
    ('edge', 'login_domain', 'login_domain'),
    ('edge', 'login_step_floor_ms', 'login_step_floor_ms'),
    ('edge', 'login_check_timeout_sec', 'login_check_timeout_sec'),
    ('edge', 'check_unhealthy_queue', 'check_unhealthy_queue'),
    ('edge', 'mfa_mode', 'mfa_mode'),
    ('edge', 'access_token_min', 'access_token_min'),
    ('edge', 'connection_idle_days', 'connection_idle_days'),
    ('edge', 'connection_max_days', 'connection_max_days'),
    ('edge', 'max_active_connections', 'max_active_connections'),
    ('edge', 'login_session_hours', 'login_session_hours'),
    ('edge', 'login_session_hours_no_mfa', 'login_session_hours_no_mfa'),
    ('edge', 'refresh_reuse_grace_sec', 'refresh_reuse_grace_sec'),
    ('edge', 'refresh_reuse_action', 'refresh_reuse_action'),
    ('edge', 'account_page_enabled', 'account_page_enabled'),
    ('edge', 'nat_cidrs', 'nat_cidrs'),
    ('edge', 'login_ip_limits', 'login_ip_limits'),
    ('edge', 'disabled_clients', 'disabled_clients')
ON CONFLICT (category, key) DO NOTHING;

DO $$ BEGIN
    IF to_regclass('auth_pause') IS NOT NULL THEN
        GRANT SELECT, INSERT, UPDATE ON auth_pause TO memory_edge_views;
    END IF;
END $$;

SELECT memory_check_extend('edge_outbox_control', 'edge_outbox_control_kind_check', 'kind',
                           ARRAY['connection', 'client', 'session', 'person_login']);
SELECT memory_check_finish('edge_outbox_control', 'edge_outbox_control_kind_check');

CREATE OR REPLACE FUNCTION outbox_control_person_login() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    NEW.kind := 'person_login';
    RETURN NEW;
END $$;
ALTER FUNCTION outbox_control_person_login() OWNER TO memory_edge_views;
REVOKE ALL ON FUNCTION outbox_control_person_login() FROM PUBLIC;
DROP TRIGGER IF EXISTS outbox_control_person_login ON edge_outbox_control;
CREATE TRIGGER outbox_control_person_login BEFORE INSERT ON edge_outbox_control FOR EACH ROW
    WHEN (NEW.lane = 'revoke' AND NEW.kind = 'person' AND NEW.item IS NOT NULL AND NEW.item->>'type' = 'person'
          AND NOT (NEW.item ? 'generation'))
    EXECUTE FUNCTION outbox_control_person_login();

CREATE OR REPLACE VIEW v_people_min WITH (security_barrier) AS
SELECT p.id AS person_id, p.display_name, p.active,
       (ea.person_id IS NOT NULL) AS external_access,
       CASE WHEN ea.person_id IS NOT NULL AND ea.ad_ok THEN lower(p.login) END AS login_lc,
       CASE WHEN ea.person_id IS NOT NULL AND ea.ad_ok THEN p.login END AS email
  FROM people p
  LEFT JOIN external_access ea ON ea.person_id = p.id AND ea.enabled_at IS NOT NULL AND ea.disabled_at IS NULL AND p.active
 WHERE COALESCE(p.attrs->>'demo', '') <> 'true' AND NOT COALESCE(lower(p.login) = ANY (tp_showcase_logins()), false)
   AND (ea.person_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM v_edge_gate_control g WHERE g.owner_id = p.id AND g.ok)
        OR EXISTS (SELECT 1 FROM edge_state es WHERE es.kind = 'person' AND es.id = p.id AND es.gen > COALESCE(es.tomb_gen, 0)));
ALTER VIEW v_people_min OWNER TO memory_edge_views;
REVOKE ALL ON v_people_min FROM PUBLIC;
GRANT SELECT ON v_people_min TO memory_exporter;

CREATE OR REPLACE VIEW v_people_ad_until WITH (security_barrier) AS
SELECT ea.person_id,
       CASE WHEN NOT ea.ad_ok OR ea.ad_checked_at IS NULL THEN COALESCE(ea.ad_checked_at, 'epoch'::timestamptz)
            ELSE ea.ad_checked_at + make_interval(hours => (
                SELECT least(greatest(COALESCE(CASE WHEN jsonb_typeof(COALESCE(s.value, s.default_value)) = 'number'
                                                    THEN (COALESCE(s.value, s.default_value)#>>'{}')::numeric END, 24), 1), 72)::int
                  FROM (SELECT 1) one
                  LEFT JOIN settings s ON s.instance_id = p.instance_id AND s.category = 'edge' AND s.key = 'ad_state_max_age_hours'))
       END AS ad_ok_until
  FROM external_access ea
  JOIN people p ON p.id = ea.person_id AND p.active
 WHERE ea.enabled_at IS NOT NULL AND ea.disabled_at IS NULL;
ALTER VIEW v_people_ad_until OWNER TO memory_edge_views;
REVOKE ALL ON v_people_ad_until FROM PUBLIC;
GRANT SELECT ON v_people_ad_until TO memory_exporter;

CREATE OR REPLACE FUNCTION external_access_edge_card() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF to_regprocedure('edge_enqueue(text, text, uuid[], text, jsonb)') IS NULL OR to_regprocedure('edge_ref_live(text, uuid[])') IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM edge_enqueue('publish', 'person', edge_ref_live('person', ARRAY(
                             SELECT n.person_id FROM old_t o JOIN new_t n ON n.person_id = o.person_id
                              WHERE n.enabled_at IS NOT NULL AND n.disabled_at IS NULL
                                AND (o.ad_ok, o.ad_checked_at) IS DISTINCT FROM (n.ad_ok, n.ad_checked_at))),
                         'meta_change');
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS external_access_edge_card ON external_access;
CREATE TRIGGER external_access_edge_card AFTER UPDATE ON external_access REFERENCING OLD TABLE AS old_t NEW TABLE AS new_t
    FOR EACH STATEMENT EXECUTE FUNCTION external_access_edge_card();

CREATE OR REPLACE FUNCTION settings_edge_login() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r record;
BEGIN
    IF to_regprocedure('edge_enqueue_revoke(jsonb)') IS NULL OR to_regprocedure('edge_enqueue(text, text, uuid[], text, jsonb)') IS NULL THEN
        RETURN NULL;
    END IF;
    FOR r IN
        SELECT DISTINCT c.client_id, floor(extract(epoch FROM n.updated_at) * 1000)::bigint AS gen
          FROM new_t n
          CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(COALESCE(n.value, n.default_value)) = 'array'
                                                            THEN COALESCE(n.value, n.default_value) ELSE '[]'::jsonb END) AS c(client_id)
         WHERE n.category = 'edge' AND n.key = 'disabled_clients' AND c.client_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'
           AND NOT EXISTS (SELECT 1 FROM old_t o
                            WHERE o.instance_id = n.instance_id AND o.category = n.category AND o.key = n.key
                              AND jsonb_typeof(COALESCE(o.value, o.default_value)) = 'array'
                              AND COALESCE(o.value, o.default_value) ? c.client_id)
         ORDER BY c.client_id
    LOOP
        PERFORM edge_enqueue_revoke(jsonb_build_object('type', 'client', 'id', r.client_id, 'reason', 'client_disabled', 'generation', r.gen));
    END LOOP;
    IF EXISTS (SELECT 1 FROM new_t n WHERE n.category = 'edge' AND n.key = 'ad_state_max_age_hours'
                  AND NOT EXISTS (SELECT 1 FROM old_t o WHERE o.instance_id = n.instance_id AND o.category = n.category AND o.key = n.key
                                     AND COALESCE(o.value, o.default_value) IS NOT DISTINCT FROM COALESCE(n.value, n.default_value)))
       AND to_regprocedure('edge_ref_live(text, uuid[])') IS NOT NULL THEN
        PERFORM edge_enqueue('publish', 'person', edge_ref_live('person', ARRAY(
                                 SELECT ea.person_id FROM external_access ea WHERE ea.enabled_at IS NOT NULL AND ea.disabled_at IS NULL)),
                             'meta_change');
    END IF;
    RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION settings_edge_login_ins() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r record;
BEGIN
    IF to_regprocedure('edge_enqueue_revoke(jsonb)') IS NULL THEN
        RETURN NULL;
    END IF;
    FOR r IN
        SELECT DISTINCT c.client_id, floor(extract(epoch FROM n.updated_at) * 1000)::bigint AS gen
          FROM new_t n
          CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(COALESCE(n.value, n.default_value)) = 'array'
                                                            THEN COALESCE(n.value, n.default_value) ELSE '[]'::jsonb END) AS c(client_id)
         WHERE n.category = 'edge' AND n.key = 'disabled_clients' AND c.client_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'
         ORDER BY c.client_id
    LOOP
        PERFORM edge_enqueue_revoke(jsonb_build_object('type', 'client', 'id', r.client_id, 'reason', 'client_disabled', 'generation', r.gen));
    END LOOP;
    RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS settings_edge_login_upd ON settings;
CREATE TRIGGER settings_edge_login_upd AFTER UPDATE ON settings REFERENCING OLD TABLE AS old_t NEW TABLE AS new_t
    FOR EACH STATEMENT EXECUTE FUNCTION settings_edge_login();
DROP TRIGGER IF EXISTS settings_edge_login_ins ON settings;
CREATE TRIGGER settings_edge_login_ins AFTER INSERT ON settings REFERENCING NEW TABLE AS new_t
    FOR EACH STATEMENT EXECUTE FUNCTION settings_edge_login_ins();
ALTER FUNCTION external_access_edge_card() OWNER TO memory_edge_views;
ALTER FUNCTION settings_edge_login() OWNER TO memory_edge_views;
ALTER FUNCTION settings_edge_login_ins() OWNER TO memory_edge_views;
REVOKE ALL ON FUNCTION external_access_edge_card(), settings_edge_login(), settings_edge_login_ins() FROM PUBLIC;

CREATE OR REPLACE VIEW v_edge_canary_scan_hashes WITH (security_barrier) AS
SELECT encode(sha256(convert_to(c.marker, 'UTF8')), 'hex') AS marker_sha256
  FROM edge_canaries c
 ORDER BY c.created_at DESC, c.record_id
 LIMIT 256;
ALTER VIEW v_edge_canary_scan_hashes OWNER TO memory_edge_views;
REVOKE ALL ON v_edge_canary_scan_hashes FROM PUBLIC;
GRANT SELECT ON v_edge_canary_scan_hashes TO memory_reconciler;

ALTER TABLE edge_export_status ADD COLUMN IF NOT EXISTS restore_auth_at timestamptz;

CREATE OR REPLACE FUNCTION edge_unkill_ready()
RETURNS TABLE(ok boolean, reasons text[], killed_at timestamptz, killed_reason text, reconcile_at timestamptz,
              canary_checked_at timestamptz, scan_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    st   edge_export_status%ROWTYPE;
    r    jsonb;
    lmin int;
    win  interval;
    v_at timestamptz;
    v_sc timestamptz;
    why  text[] := ARRAY[]::text[];
BEGIN
    SELECT * INTO st FROM edge_export_status s WHERE s.one;
    r := st.reconcile_result;
    SELECT CASE WHEN jsonb_typeof(COALESCE(s.value, s.default_value)) = 'number'
                THEN (COALESCE(s.value, s.default_value)#>>'{}')::numeric::int END INTO lmin
      FROM settings s WHERE s.category = 'edge' AND s.key = 'reconcile_light_min' ORDER BY s.instance_id LIMIT 1;
    win := make_interval(mins => 2 * least(greatest(COALESCE(lmin, 15), 5), 60) + 5);
    BEGIN
        v_at := CASE WHEN jsonb_typeof(r->'started_at') = 'string' THEN (r->>'started_at')::timestamptz END;
    EXCEPTION WHEN others THEN v_at := NULL;
    END;
    BEGIN
        v_sc := CASE WHEN jsonb_typeof(r->'scan_at') = 'string' THEN (r->>'scan_at')::timestamptz END;
    EXCEPTION WHEN others THEN v_sc := NULL;
    END;
    IF st.killed_at IS NULL THEN why := array_append(why, 'not_killed'); END IF;
    IF r IS NULL THEN
        why := array_append(why, 'reconcile_none');
    ELSE
        IF v_at IS NULL OR (st.killed_at IS NOT NULL AND v_at < st.killed_at) THEN why := array_append(why, 'reconcile_before_kill');
        ELSIF v_at < now() - win THEN why := array_append(why, 'reconcile_stale');
        END IF;
        IF r ? 'skipped' AND jsonb_typeof(r->'skipped') <> 'null' THEN why := array_append(why, 'reconcile_skipped'); END IF;
        IF r ? 'error_code' AND jsonb_typeof(r->'error_code') <> 'null' THEN why := array_append(why, 'reconcile_error'); END IF;
        IF jsonb_typeof(r->'extra') IS DISTINCT FROM 'number' OR (r->>'extra')::numeric > 0 THEN why := array_append(why, 'reconcile_extra'); END IF;
        IF r->>'revoke' IN ('pending', 'failed') THEN why := array_append(why, 'reconcile_revoke'); END IF;
    END IF;
    IF st.canary_tripped_at IS NOT NULL OR (jsonb_typeof(r->'canary') = 'number' AND (r->>'canary')::numeric > 0) THEN
        why := array_append(why, 'canary_found');
    END IF;
    IF st.canary_checked_at IS NULL OR (st.killed_at IS NOT NULL AND st.canary_checked_at < st.killed_at) THEN why := array_append(why, 'canary_unchecked');
    ELSIF st.canary_checked_at < now() - win THEN why := array_append(why, 'canary_stale');
    END IF;
    IF v_sc IS NULL OR (st.killed_at IS NOT NULL AND v_sc < st.killed_at) THEN why := array_append(why, 'canary_scan_missing'); END IF;
    IF NOT EXISTS (SELECT 1 FROM edge_canaries c WHERE c.retired_at IS NULL) THEN why := array_append(why, 'canary_none'); END IF;
    IF st.killed_reason = 'restore' AND (st.restore_auth_at IS NULL OR st.restore_auth_at < st.killed_at) THEN
        why := array_append(why, 'restore_auth_unchecked');
    END IF;
    RETURN QUERY SELECT cardinality(why) = 0, why, st.killed_at, st.killed_reason, v_at, st.canary_checked_at, v_sc;
END $$;
ALTER FUNCTION edge_unkill_ready() OWNER TO memory_edge_views;
REVOKE ALL ON FUNCTION edge_unkill_ready() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edge_unkill_ready() TO memory_admin_plane;

CREATE OR REPLACE FUNCTION edge_restore_auth_confirm(p_mfa_mode text)
RETURNS TABLE(mfa_mode text, codes_removed int, confirmed_at timestamptz)
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    st  edge_export_status%ROWTYPE;
    bad text;
    n   int := 0;
BEGIN
    IF p_mfa_mode IS NULL OR p_mfa_mode NOT IN ('off', 'optional', 'required') THEN
        RAISE EXCEPTION 'edge_restore_auth_confirm: second-factor mode — off, optional or required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO st FROM edge_export_status s WHERE s.one FOR UPDATE;
    IF st.killed_at IS NULL OR st.killed_reason IS DISTINCT FROM 'restore' THEN
        RAISE EXCEPTION 'edge_restore_auth_confirm: the kill switch is not set for a restore — first edge_kill(''restore'')'
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF to_regprocedure('mfa_policy(text)') IS NOT NULL THEN
        EXECUTE 'SELECT string_agg(i.id || ''='' || COALESCE(p.mode, ''?''), '', '' ORDER BY i.id) FROM instances i CROSS JOIN LATERAL mfa_policy(i.id) p'
                || ' WHERE p.mode IS DISTINCT FROM $1' INTO bad USING p_mfa_mode;
        IF bad IS NOT NULL THEN
            RAISE EXCEPTION 'edge_restore_auth_confirm: the current second-factor mode is %, but % was confirmed: set it in the settings and repeat', bad, p_mfa_mode
                  USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
    END IF;
    IF to_regclass('mfa_recovery_codes') IS NOT NULL THEN
        EXECUTE 'DELETE FROM mfa_recovery_codes WHERE used_at IS NULL AND created_at < $1' USING st.killed_at;
        GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
    UPDATE edge_export_status SET restore_auth_at = now(), updated_at = now() WHERE one;
    RETURN QUERY SELECT p_mfa_mode, n, now();
END $$;
REVOKE ALL ON FUNCTION edge_restore_auth_confirm(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION edge_try_ts(p text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
    IF p IS NULL OR p !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
        RETURN NULL;
    END IF;
    RETURN p::timestamptz;
EXCEPTION WHEN others THEN
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION edge_connection_used(p jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p IS NULL OR jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > 500 THEN
        RAISE EXCEPTION 'edge_connection_used: an array of up to 500 items {connection_id, at}' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    WITH it AS (
        SELECT DISTINCT ON (x.id) x.id, least(x.at, now()) AS at
          FROM (SELECT CASE WHEN e->>'connection_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                            THEN (e->>'connection_id')::uuid END AS id,
                       edge_try_ts(e->>'at') AS at
                  FROM jsonb_array_elements(p) e
                 WHERE jsonb_typeof(e) = 'object') x
         WHERE x.id IS NOT NULL AND x.at IS NOT NULL
         ORDER BY x.id, x.at DESC)
    UPDATE api_keys k SET last_used_at = it.at
      FROM it, oauth_connections c
     WHERE k.id = it.id AND c.id = k.id AND c.origin = 'edge' AND k.auth_method = 'oauth' AND k.revoked_at IS NULL
       AND it.at >= k.created_at AND (k.last_used_at IS NULL OR k.last_used_at < it.at);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION edge_connection_owner(p_id uuid) RETURNS TABLE(person_id uuid, client_id text, revoked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.person_id, c.client_id, k.revoked_at IS NOT NULL
      FROM oauth_connections c JOIN api_keys k ON k.id = c.id
     WHERE c.id = p_id AND c.origin = 'edge'
$$;

CREATE OR REPLACE FUNCTION edge_backchannel_wanted() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM settings s
                    WHERE s.category = 'edge' AND s.key = 'bridge_url'
                      AND jsonb_typeof(COALESCE(s.value, s.default_value)) = 'string'
                      AND length(COALESCE(s.value, s.default_value) #>> '{}') > 0)
$$;

CREATE OR REPLACE FUNCTION edge_unkill_checked(p_by text, p_killed_at timestamptz) RETURNS TABLE(ok boolean, reasons text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r_ok   boolean;
    r_why  text[];
    r_kill timestamptz;
BEGIN
    IF p_by IS NULL OR length(p_by) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'edge_unkill_checked: who lifts it — required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM 1 FROM edge_export_status WHERE one FOR UPDATE;
    SELECT u.ok, u.reasons, u.killed_at INTO r_ok, r_why, r_kill FROM edge_unkill_ready() u;
    IF date_trunc('milliseconds', r_kill) IS DISTINCT FROM date_trunc('milliseconds', p_killed_at) THEN
        RETURN QUERY SELECT false, array_append(COALESCE(r_why, ARRAY[]::text[]), 'kill_changed');
        RETURN;
    END IF;
    IF NOT r_ok THEN
        RETURN QUERY SELECT false, r_why;
        RETURN;
    END IF;
    PERFORM edge_unkill(p_by);
    RETURN QUERY SELECT true, ARRAY[]::text[];
END $$;

CREATE OR REPLACE FUNCTION edge_canary_hold(p_ids uuid[]) RETURNS TABLE(id uuid, tomb_gen bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_held int;
    v_new  int;
BEGIN
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
        RETURN;
    END IF;
    IF cardinality(p_ids) > 16 THEN
        RAISE EXCEPTION 'edge_canary_hold: not more than 16 records per call' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('edge_canary_hold'));
    PERFORM 1 FROM edge_state s WHERE s.kind = 'record' AND s.id = ANY (p_ids) ORDER BY s.id FOR UPDATE;
    SELECT count(*) INTO v_held FROM edge_hold h WHERE h.reason = 'manual' AND h.source = 'canary_trip';
    SELECT count(*) INTO v_new
      FROM edge_state s
     WHERE s.kind = 'record' AND s.id = ANY (p_ids) AND (s.exported_gen IS NOT NULL OR s.gen > COALESCE(s.tomb_gen, 0))
       AND NOT EXISTS (SELECT 1 FROM edge_hold h WHERE h.record_id = s.id AND h.reason = 'manual');
    IF v_held + v_new > 16 THEN
        RAISE EXCEPTION 'edge_canary_hold: there would be more than 16 unreleased canary findings (% + %)', v_held, v_new
              USING ERRCODE = 'program_limit_exceeded';
    END IF;
    INSERT INTO edge_hold (record_id, reason, source)
    SELECT s.id, 'manual', 'canary_trip'
      FROM edge_state s
     WHERE s.kind = 'record' AND s.id = ANY (p_ids) AND (s.exported_gen IS NOT NULL OR s.gen > COALESCE(s.tomb_gen, 0))
    ON CONFLICT (record_id, reason) DO NOTHING;
    RETURN QUERY SELECT m.id, m.tomb_gen FROM edge_revoke_mark('record', p_ids, 'canary_trip', false) m;
END $$;

CREATE OR REPLACE FUNCTION edge_canary_hold_release(p_record uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_record IS NULL THEN
        RAISE EXCEPTION 'edge_canary_hold_release: record is required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    DELETE FROM edge_hold h WHERE h.record_id = p_record AND h.reason = 'manual' AND h.source = 'canary_trip';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $$;

CREATE OR REPLACE FUNCTION edge_canary_hold_release_since(p_since timestamptz) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_since IS NULL THEN
        RAISE EXCEPTION 'edge_canary_hold_release_since: the start time is required (for all — -infinity)' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    DELETE FROM edge_hold h WHERE h.reason = 'manual' AND h.source = 'canary_trip' AND h.created_at >= p_since;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

ALTER FUNCTION edge_try_ts(text) OWNER TO memory_edge_views;
ALTER FUNCTION edge_connection_used(jsonb) OWNER TO memory_edge_views;
ALTER FUNCTION edge_connection_owner(uuid) OWNER TO memory_edge_views;
ALTER FUNCTION edge_backchannel_wanted() OWNER TO memory_edge_views;
ALTER FUNCTION edge_unkill_checked(text, timestamptz) OWNER TO memory_edge_views;
ALTER FUNCTION edge_canary_hold(uuid[]) OWNER TO memory_edge_views;
ALTER FUNCTION edge_canary_hold_release(uuid) OWNER TO memory_edge_views;
ALTER FUNCTION edge_canary_hold_release_since(timestamptz) OWNER TO memory_edge_views;
GRANT SELECT (id, created_at, revoked_at, auth_method, expires_at, last_used_at), UPDATE (last_used_at) ON api_keys TO memory_edge_views;
GRANT SELECT (id, origin, person_id, client_id) ON oauth_connections TO memory_edge_views;
REVOKE ALL ON FUNCTION edge_try_ts(text), edge_connection_used(jsonb), edge_connection_owner(uuid), edge_backchannel_wanted(),
                       edge_unkill_checked(text, timestamptz), edge_canary_hold(uuid[]), edge_canary_hold_release(uuid),
                       edge_canary_hold_release_since(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edge_connection_used(jsonb), edge_connection_owner(uuid), edge_backchannel_wanted() TO memory_intake;
GRANT EXECUTE ON FUNCTION edge_unkill_checked(text, timestamptz), edge_canary_hold_release(uuid), edge_canary_hold_release_since(timestamptz)
      TO memory_admin_plane;
GRANT EXECUTE ON FUNCTION edge_canary_hold(uuid[]) TO memory_reconciler;
REVOKE SELECT (id, last_used_at), UPDATE (last_used_at) ON api_keys FROM memory_intake;

-- [1f]

-- [S2-3]

-- [4]

-- [E2]

-- [5]
