CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE audit_events (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    at              timestamptz NOT NULL DEFAULT now(),
    instance_id     text NOT NULL,
    event_type      text NOT NULL CHECK (event_type IN (
                        'read','search','list','write','promote','open','forget',
                        'extended_key_use','t1_fallback','confirmation','admin','processing',
                        'auth_failure','rate_limited','class_move','purge','directory')),
    key_id          uuid,                                  -- control.api_keys.id
    principal_type  text CHECK (principal_type IN ('person','service','system')),
    principal_id    uuid,
    on_behalf_of    uuid,
    service_id      uuid,
    tier            text CHECK (tier IN ('T0','T1','T2')),
    class           text CHECK (class IN ('open','closed')),
    record_ids      uuid[] NOT NULL DEFAULT '{}',
    space_id        uuid,
    query_text      text,
    filters         jsonb,
    result_count    int,
    details         jsonb NOT NULL DEFAULT '{}'::jsonb,
    client_label    text,
    ip              inet,
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

COMMENT ON TABLE audit_events IS 'Log of accesses and changes; a fact, not the content';

CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;

CREATE OR REPLACE FUNCTION audit_ensure_partition(p_month date)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    start_d date := date_trunc('month', p_month)::date;
    end_d   date := (date_trunc('month', p_month) + interval '1 month')::date;
    pname   text := format('audit_events_%s', to_char(start_d, 'YYYY_MM'));
BEGIN
    IF to_regclass(pname) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)', pname, start_d, end_d);
    END IF;
    RETURN pname;
END $$;
REVOKE EXECUTE ON FUNCTION audit_ensure_partition(date) FROM PUBLIC;

SELECT audit_ensure_partition(current_date);
SELECT audit_ensure_partition((current_date + interval '1 month')::date);

CREATE INDEX audit_events_at_idx           ON audit_events (at);
CREATE INDEX audit_events_principal_idx    ON audit_events (principal_id, at);
CREATE INDEX audit_events_obo_idx          ON audit_events (on_behalf_of, at) WHERE on_behalf_of IS NOT NULL;
CREATE INDEX audit_events_record_ids_idx   ON audit_events USING gin (record_ids);
CREATE INDEX audit_events_type_idx         ON audit_events (event_type, at);
CREATE INDEX audit_events_author_idx       ON audit_events ((details->>'author'), at) WHERE details ? 'author';
CREATE INDEX audit_events_custody_idx      ON audit_events (space_id, at) WHERE details->>'op' IN ('custody_read', 'custody_end');

CREATE OR REPLACE FUNCTION audit_scrub_query_text(p_older_than interval DEFAULT interval '90 days')
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    UPDATE audit_events SET query_text = NULL
    WHERE query_text IS NOT NULL AND at < now() - p_older_than;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

CREATE OR REPLACE VIEW audit_partitions_to_archive AS
    SELECT c.relname AS partition_name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_events'
      AND c.relname ~ '^audit_events_\d{4}_\d{2}$'
      AND to_date(substring(c.relname from '\d{4}_\d{2}$'), 'YYYY_MM') < date_trunc('month', now()) - interval '12 months';

GRANT INSERT ON audit_events TO memory_worker;                          -- the gateway: column grant below
GRANT SELECT ON audit_events TO memory_audit_reader;
GRANT SELECT, UPDATE ON audit_events TO memory_audit_maint;
GRANT EXECUTE ON FUNCTION audit_scrub_query_text(interval) TO memory_audit_maint;
GRANT EXECUTE ON FUNCTION audit_ensure_partition(date) TO memory_audit_maint;
GRANT SELECT ON audit_partitions_to_archive TO memory_audit_maint;

-- The gateway role inserts the 18 event columns only: `at` (DEFAULT now(), the partition key) and `received_at` (13, DEFAULT
-- clock_timestamp(), the order of the alert feed) are always the database's. The same block is in 03-audit.sql (fresh install)
-- and 08-audit-extras.sql (every deploy). It fails the apply, naming the cause and no value, when the gateway can still reach
-- more: has_*_privilege sees inherited rights only, so the block also walks every membership of the gateway (any depth, with or
-- without INHERIT / SET), and refuses superuser, REPLICATION or server-file roles, ownership of the table, a partition, the
-- schema or the database, a right of a reached role, a rule on the table, a trigger on the table or a partition that is not
-- on the block's allow-list (empty: this schema defines none), a view, materialized view or rule-carrying table over it at
-- any depth (the dependency closure), a SECURITY DEFINER trigger on a table the gateway may write, a cascading
-- foreign key, a foreign server or table, default privileges for new partitions, an executable SECURITY DEFINER function, a
-- grant on a partition and a grant by another grantor.
-- ---------------------------------------------------------------- gateway column grants
DO $sec_audit_grants$
DECLARE
    g18 name[] := ARRAY['id','instance_id','event_type','key_id','principal_type','principal_id','on_behalf_of','service_id','tier','class','record_ids','space_id','query_text','filters','result_count','details','client_label','ip']::name[];
    gw oid := 'memory_gateway'::regrole;
    parent oid := 'public.audit_events'::regclass;
    reach oid[];
    parts oid[];
    deps oid[];
    allowed text[] := ARRAY[]::text[];
BEGIN
    REVOKE ALL ON audit_events FROM PUBLIC, memory_gateway;
    GRANT INSERT (id, instance_id, event_type, key_id, principal_type, principal_id, on_behalf_of, service_id, tier, class, record_ids, space_id, query_text, filters, result_count, details, client_label, ip) ON audit_events TO memory_gateway;
    reach := ARRAY(WITH RECURSIVE r(oid) AS (SELECT gw UNION SELECT m.roleid FROM pg_auth_members m JOIN r ON m.member = r.oid) SELECT r.oid FROM r);
    parts := ARRAY(WITH RECURSIVE t(oid) AS (SELECT i.inhrelid FROM pg_inherits i WHERE i.inhparent = parent UNION SELECT i.inhrelid FROM pg_inherits i JOIN t ON i.inhparent = t.oid) SELECT t.oid FROM t);
    deps := ARRAY(WITH RECURSIVE v(oid) AS (SELECT w.ev_class FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND w.oid = d.objid WHERE d.refclassid = 'pg_class'::regclass AND (d.refobjid = parent OR d.refobjid = ANY (parts)) UNION SELECT w.ev_class FROM pg_depend d JOIN pg_rewrite w ON d.classid = 'pg_rewrite'::regclass AND w.oid = d.objid JOIN v ON d.refclassid = 'pg_class'::regclass AND d.refobjid = v.oid) SELECT v.oid FROM v);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE oid = ANY (reach) AND (rolsuper OR rolreplication OR rolname IN ('pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program'))) THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway, or a role it is a member of, is a superuser, has REPLICATION (logical decoding reads every row) or may read or write server files: remove the attribute or the membership and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (c.oid = parent OR c.oid = ANY (parts)) AND (c.relowner = ANY (reach) OR n.nspowner = ANY (reach)))
       OR EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = ANY (reach)) THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway, or a role it is a member of, owns audit_events, one of its partitions, their schema or the database: give it back to the schema owner (ALTER ... OWNER TO) and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(reach) r(oid) WHERE r.oid <> gw AND (
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = parent AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> ALL (g18) AND has_column_privilege(r.oid, parent, a.attnum, 'INSERT'))
           OR has_any_column_privilege(r.oid, parent, 'SELECT, UPDATE, REFERENCES') OR has_table_privilege(r.oid, parent, 'DELETE, TRUNCATE, TRIGGER')
           OR EXISTS (SELECT 1 FROM unnest(parts) t(oid) WHERE has_any_column_privilege(r.oid, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES') OR has_table_privilege(r.oid, t.oid, 'DELETE, TRUNCATE, TRIGGER')))) THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway is a member (directly or through other roles, with or without INHERIT) of a role that holds a right on audit_events or one of its partitions: revoke the membership and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(deps) v(oid) WHERE v.oid = parent OR v.oid = ANY (parts)) THEN
        RAISE EXCEPTION 'Audit privileges: audit_events or one of its partitions carries a rule: drop it (DROP RULE) and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (WITH RECURSIVE up(tid, cur) AS (SELECT t.oid, t.oid FROM pg_trigger t WHERE NOT t.tgisinternal AND (t.tgrelid = parent OR t.tgrelid = ANY (parts)) UNION ALL SELECT up.tid, c.tgparentid FROM up JOIN pg_trigger c ON c.oid = up.cur WHERE c.tgparentid <> 0)
               SELECT 1 FROM up JOIN pg_trigger r ON r.oid = up.cur AND r.tgparentid = 0 JOIN pg_trigger t ON t.oid = up.tid JOIN pg_proc f ON f.oid = r.tgfoid JOIN pg_namespace fn ON fn.oid = f.pronamespace
               WHERE NOT (r.tgrelid = parent AND t.tgfoid = r.tgfoid AND format('%s=%s.%s', r.tgname, fn.nspname, f.proname) = ANY (allowed))) THEN
        RAISE EXCEPTION 'Audit privileges: audit_events or one of its partitions carries a trigger this schema does not define (any timing, level, event, security mode or enabled state; a row trigger can set at or received_at from the row): drop it (DROP TRIGGER) and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger r JOIN pg_proc f ON f.oid = r.tgfoid JOIN pg_namespace fn ON fn.oid = f.pronamespace JOIN pg_class c ON c.oid = parent
               WHERE r.tgrelid = parent AND NOT r.tgisinternal AND format('%s=%s.%s', r.tgname, fn.nspname, f.proname) = ANY (allowed) AND (f.proowner <> c.relowner OR f.proowner = ANY (reach))) THEN
        RAISE EXCEPTION 'Audit privileges: an allowed trigger of audit_events runs a function that is not owned by the owner of audit_events, or that memory_gateway or a role it is a member of could replace: give the function back to that owner and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(deps) v(oid) JOIN pg_class c ON c.oid = v.oid WHERE c.relowner = ANY (reach)
               OR EXISTS (SELECT 1 FROM unnest(reach) r(oid) WHERE has_any_column_privilege(r.oid, v.oid, 'SELECT, INSERT, UPDATE, REFERENCES') OR has_table_privilege(r.oid, v.oid, 'DELETE, TRUNCATE, TRIGGER'))) THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway, or a role it is a member of, owns or holds a right on a view, materialized view or rule-carrying table that reads or writes audit_events, directly or through other views at any depth: revoke it or drop the object and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid
               WHERE NOT t.tgisinternal AND p.prosecdef AND (c.relowner = ANY (reach) OR EXISTS (SELECT 1 FROM unnest(reach) r(oid) WHERE has_any_column_privilege(r.oid, c.oid, 'INSERT, UPDATE, REFERENCES') OR has_table_privilege(r.oid, c.oid, 'DELETE, TRUNCATE, TRIGGER'))))
       OR EXISTS (SELECT 1 FROM pg_event_trigger e JOIN pg_proc p ON p.oid = e.evtfoid WHERE p.prosecdef AND e.evtenabled <> 'D') THEN
        RAISE EXCEPTION 'Audit privileges: a SECURITY DEFINER trigger fires on a table memory_gateway, or a role it is a member of, may write, or an event trigger with a SECURITY DEFINER function is enabled: make the function SECURITY INVOKER or drop the trigger and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype = 'f' AND (k.conrelid = parent OR k.conrelid = ANY (parts)) AND (k.confdeltype IN ('c', 'n', 'd') OR k.confupdtype IN ('c', 'n', 'd'))) THEN
        RAISE EXCEPTION 'Audit privileges: a foreign key of audit_events or one of its partitions cascades or sets values when the referenced table changes: drop it and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_foreign_server s WHERE EXISTS (SELECT 1 FROM unnest(reach) r(oid) WHERE has_server_privilege(r.oid, s.oid, 'USAGE')))
       OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind = 'f' AND (c.relowner = ANY (reach) OR EXISTS (SELECT 1 FROM unnest(reach) r(oid) WHERE has_any_column_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES') OR has_table_privilege(r.oid, c.oid, 'DELETE, TRUNCATE, TRIGGER')))) THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway, or a role it is a member of, may use a foreign server or owns or holds a right on a foreign table of the audit database: revoke it and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a, pg_class c
               WHERE c.oid = parent AND d.defaclobjtype = 'r' AND d.defaclnamespace IN (0, c.relnamespace) AND (a.grantee = 0 OR a.grantee = ANY (reach))) THEN
        RAISE EXCEPTION 'Audit privileges: default privileges give memory_gateway, a role it is a member of, or PUBLIC rights on new tables of the audit schema (new partitions): remove them (ALTER DEFAULT PRIVILEGES ... REVOKE) and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND EXISTS (SELECT 1 FROM unnest(reach) r(oid) WHERE has_function_privilege(r.oid, p.oid, 'EXECUTE'))) THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway, or a role it is a member of, may execute a SECURITY DEFINER function of the audit database: revoke EXECUTE (also from PUBLIC) and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(parts) t(oid) WHERE has_any_column_privilege(gw, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES') OR has_table_privilege(gw, t.oid, 'DELETE, TRUNCATE, TRIGGER')) THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway holds a right on a partition of audit_events (a grant on the partition itself, to PUBLIC or through ON ALL TABLES): revoke it on that partition (REVOKE ALL ON <partition> FROM memory_gateway, PUBLIC) and apply the schema again' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = parent AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> ALL (g18) AND has_column_privilege(gw, parent, a.attnum, 'INSERT'))
       OR has_any_column_privilege(gw, parent, 'SELECT, UPDATE, REFERENCES') OR has_table_privilege(gw, parent, 'DELETE, TRUNCATE, TRIGGER') THEN
        RAISE EXCEPTION 'Audit privileges: memory_gateway holds a right on audit_events beyond INSERT of the 18 event columns (a grant by another grantor): revoke it as that grantor (REVOKE ... FROM memory_gateway) and apply the schema again' USING ERRCODE = '42501';
    END IF;
END $sec_audit_grants$;

-- ---------------------------------------------------------------- audit archive
-- The same text is in 03-audit.sql (fresh install) and 08-audit-extras.sql (every deploy); it is idempotent.
-- The worker job audit_archive (packages/workers/src/jobs/audit-archive.ts, role memory_audit_maint, its own connection) exports a
-- month partition older than observability.audit_retention_months to the closed-class bucket (gzip NDJSON parts and a manifest
-- under audit-archive/<instance>/), downloads and verifies every part, and in the mode export_and_drop detaches and drops the
-- partition inside the night window, through audit_archive_drop below. One row per partition: the state of its archive.
CREATE TABLE IF NOT EXISTS audit_archive_runs (
    partition_name  text PRIMARY KEY CHECK (partition_name ~ '^audit_events_[0-9]{4}_[0-9]{2}$'),
    instance_id     text NOT NULL,                         -- the instance whose worker made the archive (a partition holds every instance)
    status          text NOT NULL CHECK (status IN ('exporting','verified','dropped','expired','failed')),
    rows            bigint,                                -- rows exported and verified; audit_archive_drop compares it with count(*)
    parts           int,
    bytes           bigint,                                -- compressed bytes of all parts
    sha256          text,                                  -- SHA-256 of the uncompressed NDJSON of the month, parts in order
    manifest_key    text,
    manifest_sha256 text,                                  -- SHA-256 of the manifest bytes; the next month's manifest names it (hash chain)
    range_from      timestamptz,                           -- bounds of the partition as created (the month in the time zone of its creation)
    range_to        timestamptz,                           -- after a drop: the journal is complete from here on (audit-archive.ts)
    min_at          timestamptz,
    max_at          timestamptz,
    error           text,                                  -- why the last attempt failed: a short code and counts, never event data
    attempts        int NOT NULL DEFAULT 0,
    started_at      timestamptz,
    verified_at     timestamptz,
    dropped_at      timestamptz,
    expired_at      timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit_archive_runs IS 'Audit archive state per month partition: exported, verified, dropped';

-- Month partitions whose whole month is older than p_months full months (the view audit_partitions_to_archive below is the
-- same rule with a fixed 12 and stays for compatibility). Oldest first. p_months below 3 is refused: it is the floor of the
-- setting, and the drop function enforces it too. range_from / range_to — the bounds the partition was created with
-- (audit_ensure_partition turns the month into timestamps in the time zone of that session, which need not be UTC): the export
-- reads exactly them, so its row count equals the partition's.
CREATE OR REPLACE FUNCTION audit_archive_candidates(p_months int)
RETURNS TABLE (partition_name text, month_start date, month_end date, range_from timestamptz, range_to timestamptz)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp SET datestyle = 'ISO, YMD' AS $$
BEGIN
    IF p_months IS NULL OR p_months < 3 THEN
        RAISE EXCEPTION 'audit_archive_candidates: retention below 3 months' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    SELECT c.relname::text, m.d, (m.d + interval '1 month')::date, b.r[1]::timestamptz, b.r[2]::timestamptz
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      CROSS JOIN LATERAL (SELECT CASE WHEN c.relname ~ '^audit_events_[0-9]{4}_(0[1-9]|1[0-2])$'
                                      THEN to_date(substring(c.relname from '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM') END AS d) m
      CROSS JOIN LATERAL (SELECT regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \(''([^'']+)''\) TO \(''([^'']+)''\)') AS r) b
     WHERE i.inhparent = 'public.audit_events'::regclass
       AND m.d IS NOT NULL AND b.r IS NOT NULL
       AND m.d < date_trunc('month', now()) - make_interval(months => p_months)
     ORDER BY m.d;
END $$;
REVOKE ALL ON FUNCTION audit_archive_candidates(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_archive_candidates(int) TO memory_audit_maint;
-- The reader lists the candidates too (the Readiness item audit_archive counts the months waiting for the archive):
-- the function is not SECURITY DEFINER and reads only the catalog, so this gives the reader nothing it could not query itself.
GRANT EXECUTE ON FUNCTION audit_archive_candidates(int) TO memory_audit_reader;

-- Detach and drop one verified month partition. SECURITY DEFINER: the file is applied by the superuser, so the function runs
-- as the superuser — hence the hardening: a fixed search_path; the name is checked against the pattern and then used only as
-- an identifier (%I); the table must be a partition of audit_events in pg_inherits (a look-alike table with a matching name is
-- refused); the month must be older than p_months, and p_months has a floor of 3 inside the function; the run must be
-- 'verified'. Order of the locks — the order every query through audit_events takes them (the parent first, then the
-- partitions), so the function never waits for a lock while holding one another session waits for (a deadlock with a reader
-- or with audit_scrub_query_text when the partition was locked first): (1) count the partition without an
-- exclusive lock — a count that differs fails early and nothing is locked; (2) ACCESS EXCLUSIVE on audit_events, then on the
-- partition; (3) count again under both locks (no row can enter the month any more; the month was just read, so this count
-- reads it from the cache) and compare with the verified row count; (4) DETACH and DROP. A count that differs marks the run
-- 'failed' and drops nothing (answer 'count_mismatch'); the job exports the month again. lock_timeout 2 s: while the function
-- waits for the parent, audit inserts queue behind it; a timeout (55P03) is retried at the next pass. Plain DETACH: DETACH ...
-- CONCURRENTLY is not allowed while a default partition exists and not inside a function.
-- The maintenance role can forge a 'verified' run; it could already rewrite any event (UPDATE on audit_events), so this adds
-- no new trust: the floor of 3 months and the partition check bound what it can remove.
CREATE OR REPLACE FUNCTION audit_archive_drop(p_partition text, p_months int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    m     date;
    rel   oid;
    run   record;
    n     bigint;
BEGIN
    IF p_partition IS NULL OR p_partition !~ '^audit_events_[0-9]{4}_(0[1-9]|1[0-2])$' THEN
        RAISE EXCEPTION 'audit_archive_drop: not the name of a month partition of audit_events' USING ERRCODE = '22023';
    END IF;
    IF p_months IS NULL OR p_months < 3 THEN
        RAISE EXCEPTION 'audit_archive_drop: retention below 3 months' USING ERRCODE = '22023';
    END IF;
    m := to_date(substring(p_partition from '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM');
    IF m >= date_trunc('month', now()) - make_interval(months => p_months) THEN
        RAISE EXCEPTION 'audit_archive_drop: % is not older than % months', p_partition, p_months USING ERRCODE = '22023';
    END IF;
    SELECT c.oid INTO rel
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace AND ns.nspname = 'public'
      JOIN pg_inherits i ON i.inhrelid = c.oid AND i.inhparent = 'public.audit_events'::regclass
     WHERE c.relname = p_partition AND c.relkind = 'r';
    IF rel IS NULL THEN
        RAISE EXCEPTION 'audit_archive_drop: % is not a partition of audit_events', p_partition USING ERRCODE = '42P01';
    END IF;
    SELECT r.status, r.rows INTO run FROM public.audit_archive_runs r WHERE r.partition_name = p_partition FOR UPDATE;
    IF NOT FOUND OR run.status IS DISTINCT FROM 'verified' OR run.rows IS NULL THEN
        RAISE EXCEPTION 'audit_archive_drop: the archive of % is not verified', p_partition USING ERRCODE = '55000';
    END IF;
    PERFORM set_config('lock_timeout', '2s', true);
    EXECUTE format('SELECT count(*) FROM public.%I', p_partition) INTO n;
    IF n IS NOT DISTINCT FROM run.rows THEN
        LOCK TABLE public.audit_events IN ACCESS EXCLUSIVE MODE;
        EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', p_partition);
        EXECUTE format('SELECT count(*) FROM public.%I', p_partition) INTO n;
    END IF;
    IF n IS DISTINCT FROM run.rows THEN
        UPDATE public.audit_archive_runs
           SET status = 'failed', error = format('count_mismatch: %s rows in the partition, %s verified', n, run.rows), updated_at = now()
         WHERE partition_name = p_partition;
        RETURN 'count_mismatch';
    END IF;
    EXECUTE format('ALTER TABLE public.audit_events DETACH PARTITION public.%I', p_partition);
    EXECUTE format('DROP TABLE public.%I', p_partition);
    UPDATE public.audit_archive_runs SET status = 'dropped', dropped_at = now(), error = NULL, updated_at = now()
     WHERE partition_name = p_partition;
    RETURN 'dropped';
END $$;
REVOKE ALL ON FUNCTION audit_archive_drop(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_archive_drop(text, int) TO memory_audit_maint;

-- The writers (memory_gateway, memory_worker) get nothing; the reader sees the state (where the journal is complete from:
-- auditArchivedBefore() in packages/shared/src/audit-archive.ts; the list of archives); the maintenance role keeps it.
REVOKE ALL ON audit_archive_runs FROM PUBLIC;
GRANT SELECT ON audit_archive_runs TO memory_audit_reader;
GRANT SELECT, INSERT, UPDATE ON audit_archive_runs TO memory_audit_maint;

CREATE TABLE IF NOT EXISTS search_outcomes (
    search_event_id    uuid PRIMARY KEY,
    at                 timestamptz NOT NULL,
    instance_id        text NOT NULL,
    key_id             uuid,
    principal_type     text NOT NULL CHECK (principal_type IN ('person','service')),
    principal_id       uuid,
    on_behalf_of       uuid,
    person_id          uuid,
    key_kind           text NOT NULL CHECK (key_kind IN ('personal','extended','connection','service','obo','session','unknown')),
    client_kind        text,
    channel            text NOT NULL CHECK (channel IN ('agent','workplace','workplace_auto')),
    mode               text NOT NULL,
    has_query          boolean NOT NULL,
    has_filters        boolean NOT NULL,
    closed_seen        boolean NOT NULL,
    rerank             boolean,
    result_count       int NOT NULL,
    hit_ids            uuid[] NOT NULL DEFAULT '{}',
    zero_result        boolean NOT NULL,
    continuation_of    uuid,
    position_offset    int NOT NULL DEFAULT 0,
    session_id         uuid NOT NULL,                     -- caller_sessions.session_id
    session_started_at timestamptz NOT NULL,
    read_ranks         int[] NOT NULL DEFAULT '{}',
    first_read_rank    int,
    reads_explicit     int NOT NULL DEFAULT 0,
    reads_heuristic    int NOT NULL DEFAULT 0,
    reads_followup     int NOT NULL DEFAULT 0,
    reformulated       boolean,
    wrote_after        boolean NOT NULL DEFAULT false,
    past_notes         smallint NOT NULL DEFAULT 0,
    past_notes_others  smallint NOT NULL DEFAULT 0,
    past_note_read     boolean NOT NULL DEFAULT false,
    corrected_ids      uuid[] NOT NULL DEFAULT '{}',
    outdated_ids       uuid[] NOT NULL DEFAULT '{}',
    useful_ids         uuid[] NOT NULL DEFAULT '{}',
    is_test            boolean NOT NULL DEFAULT false,
    test_reason        text CHECK (test_reason IN ('test_login','demo','removed','test_service')),
    settled            boolean NOT NULL DEFAULT true,
    algo               smallint NOT NULL DEFAULT 1,
    built_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT search_outcomes_test_reason CHECK ((test_reason IS NULL) = (NOT is_test))
);
CREATE INDEX IF NOT EXISTS search_outcomes_at_idx       ON search_outcomes (at);
CREATE INDEX IF NOT EXISTS search_outcomes_key_idx      ON search_outcomes (key_id, at);
CREATE INDEX IF NOT EXISTS search_outcomes_person_idx   ON search_outcomes (person_id, at) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS search_outcomes_session_idx  ON search_outcomes (session_id);
CREATE INDEX IF NOT EXISTS search_outcomes_unsettled    ON search_outcomes (at) WHERE NOT settled;

CREATE TABLE IF NOT EXISTS caller_sessions (
    session_id     uuid PRIMARY KEY,
    instance_id    text NOT NULL,
    key_id         uuid NOT NULL,
    principal_type text NOT NULL CHECK (principal_type IN ('person','service')),
    principal_id   uuid,
    on_behalf_of   uuid,
    person_id      uuid,
    channel        text NOT NULL CHECK (channel IN ('agent','workplace')),
    key_kind       text NOT NULL CHECK (key_kind IN ('personal','extended','connection','service','obo','session','unknown')),
    client_kind    text,
    started_at     timestamptz NOT NULL,
    last_at        timestamptz NOT NULL,
    is_test        boolean NOT NULL DEFAULT false,
    test_reason    text CHECK (test_reason IN ('test_login','demo','removed','test_service')),
    algo           smallint NOT NULL DEFAULT 1,
    built_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT caller_sessions_test_reason CHECK ((test_reason IS NULL) = (NOT is_test))
);
CREATE INDEX IF NOT EXISTS caller_sessions_key_idx     ON caller_sessions (key_id, last_at);
CREATE INDEX IF NOT EXISTS caller_sessions_started_idx ON caller_sessions (started_at);

CREATE TABLE IF NOT EXISTS search_outcomes_weeks (
    instance_id   text NOT NULL,
    week_start    date NOT NULL,
    include_test  boolean NOT NULL,
    current       boolean NOT NULL DEFAULT false,
    people        int NOT NULL DEFAULT 0,
    quality       jsonb NOT NULL DEFAULT '{}'::jsonb,
    rollout       jsonb NOT NULL DEFAULT '{}'::jsonb,
    complete      boolean NOT NULL DEFAULT false,
    rules_changed boolean NOT NULL DEFAULT false,
    algo          smallint NOT NULL DEFAULT 1,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, week_start, include_test)
);

CREATE TABLE IF NOT EXISTS search_outcomes_state (
    instance_id           text PRIMARY KEY,
    cursor_at             timestamptz,
    cursor_id             uuid,
    since                 timestamptz,
    algo                  smallint NOT NULL DEFAULT 1,
    windows               jsonb,
    rules_changed_at      timestamptz,
    workplace_exact_since timestamptz,
    test_resync_at        timestamptz,
    slices                jsonb,
    slices_test           jsonb,
    slices_min_group      int,
    last_pass             jsonb,
    poison                jsonb,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    dirty_weeks           date[] NOT NULL DEFAULT '{}'
);

GRANT SELECT ON search_outcomes, caller_sessions, search_outcomes_weeks, search_outcomes_state TO memory_audit_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON search_outcomes, caller_sessions, search_outcomes_weeks, search_outcomes_state TO memory_audit_maint;
