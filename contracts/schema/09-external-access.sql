
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

SELECT memory_check_extend('settings', 'settings_category_check', 'category', ARRAY['edge', 'admin']);
SELECT memory_check_finish('settings', 'settings_category_check');

-- ---------------------------------------------------------------- inner roles
DO $$
DECLARE
    r text;
BEGIN
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
        LOCK TABLE pg_catalog.pg_authid IN SHARE ROW EXCLUSIVE MODE;
    END IF;
    FOREACH r IN ARRAY ARRAY['memory_authcheck', 'memory_exporter', 'memory_intake', 'memory_reconciler', 'memory_edge_views',
                             'memory_probe', 'memory_admin_plane'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
    END LOOP;
    IF NOT pg_has_role('memory_admin_plane', 'memory_gateway', 'MEMBER') THEN
        GRANT memory_gateway TO memory_admin_plane;
    END IF;
    COMMENT ON ROLE memory_authcheck IS 'Sign-in check from outside: the password in AD over the channel the mode allows (in advanced — LDAPS), the factor, permissions (program “External access”)';
    COMMENT ON ROLE memory_exporter IS 'Export of what is published to the edge through the bridge';
    COMMENT ON ROLE memory_intake IS 'Intake of edge events: connections, logs, C2 requests';
    COMMENT ON ROLE memory_reconciler IS 'Reconciliation of the edge copy with its own SQL';
    COMMENT ON ROLE memory_edge_views IS 'Owner of the views of the publication gate and of functions 10/11; no login';
    COMMENT ON ROLE memory_probe IS 'Probe: synthetic sign-in and an outside check of the edge';
    COMMENT ON ROLE memory_admin_plane IS 'Admin listener: it has the gateway’s rights and only it has the admin plane’s rights';
END $$;

-- ---------------------------------------------------------------- external access
CREATE TABLE IF NOT EXISTS external_access (
    person_id              uuid PRIMARY KEY REFERENCES people(id),
    instance_id            text NOT NULL REFERENCES instances(id),
    enabled_at             timestamptz,
    enabled_session_id     uuid,
    first_enabled_at       timestamptz,
    first_confirm          text,
    last_external_login_at timestamptz,
    ad_checked_at          timestamptz,
    ad_ok                  boolean NOT NULL DEFAULT false,
    disabled_at            timestamptz,
    disabled_by            text,
    disabled_code          text,
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_access_on_idx ON external_access (instance_id) WHERE enabled_at IS NOT NULL AND disabled_at IS NULL;
SELECT memory_check_extend('external_access', 'external_access_first_confirm_check', 'first_confirm', ARRAY['office', 'support', 'none']);
SELECT memory_check_finish('external_access', 'external_access_first_confirm_check');
SELECT memory_check_extend('external_access', 'external_access_disabled_code_check', 'disabled_code',
                           ARRAY['self', 'admin', 'support', 'idle', 'person_inactive', 'ad_disabled', 'ad_deleted', 'ad_expired',
                                 'ad_group', 'ad_deny', 'admin_no_webauthn', 'compromise']);
SELECT memory_check_finish('external_access', 'external_access_disabled_code_check');
GRANT SELECT (person_id) ON external_access TO memory_test_purge;

CREATE TABLE IF NOT EXISTS audit_spool (
    id          bigserial PRIMARY KEY,
    instance_id text NOT NULL REFERENCES instances(id),
    at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    source      text NOT NULL,
    event_type  text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
    details     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 8192),
    rejected_at timestamptz,
    reject_code text CHECK (reject_code ~ '^[a-z0-9_]{1,32}$')
);
CREATE INDEX IF NOT EXISTS audit_spool_at_idx ON audit_spool (at);
CREATE INDEX IF NOT EXISTS audit_spool_pending_idx ON audit_spool (instance_id, id) WHERE rejected_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_spool_types (
    source     text NOT NULL,
    event_type text NOT NULL,
    PRIMARY KEY (source, event_type)
);
GRANT SELECT ON audit_spool_types TO memory_worker;

CREATE OR REPLACE FUNCTION audit_spool_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    NEW.source := session_user;
    NEW.at := clock_timestamp();
    NEW.rejected_at := NULL;
    NEW.reject_code := NULL;
    IF NOT EXISTS (SELECT 1 FROM audit_spool_types t WHERE t.source = NEW.source AND t.event_type = NEW.event_type) THEN
        RAISE EXCEPTION 'audit_spool: role % does not write events of type %', NEW.source, left(NEW.event_type, 64)
              USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION audit_spool_source() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_spool_source ON audit_spool;
CREATE TRIGGER audit_spool_source BEFORE INSERT ON audit_spool FOR EACH ROW EXECUTE FUNCTION audit_spool_source();
REVOKE INSERT ON audit_spool FROM memory_authcheck, memory_probe;
GRANT INSERT (instance_id, event_type, details) ON audit_spool TO memory_authcheck, memory_probe;
GRANT USAGE ON SEQUENCE audit_spool_id_seq TO memory_authcheck, memory_probe;
GRANT SELECT, DELETE ON audit_spool TO memory_worker;
GRANT UPDATE (rejected_at, reject_code) ON audit_spool TO memory_worker;

CREATE TABLE IF NOT EXISTS service_heartbeats (
    instance_id text NOT NULL REFERENCES instances(id),
    service     text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    version     text,
    run_mode    text NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (instance_id, service)
);
SELECT memory_check_extend('service_heartbeats', 'service_heartbeats_run_mode_check', 'run_mode', ARRAY['user', 'system', 'container']);
SELECT memory_check_finish('service_heartbeats', 'service_heartbeats_run_mode_check');

CREATE OR REPLACE FUNCTION service_heartbeat(p_service text, p_version text, p_run_mode text, p_detail jsonb, p_instance text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    mine text := CASE session_user
        WHEN 'memory_authcheck'  THEN 'memory-authcheck'
        WHEN 'memory_exporter'   THEN 'exporter'
        WHEN 'memory_intake'     THEN 'intake'
        WHEN 'memory_reconciler' THEN 'reconciler'
        WHEN 'memory_probe'      THEN 'memory-probe'
    END;
    inst text := p_instance;
BEGIN
    IF mine IS NULL OR p_service IS DISTINCT FROM mine THEN
        RAISE EXCEPTION 'service_heartbeat: role % does not write the heartbeat of service %', session_user, p_service USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_detail IS NOT NULL AND (jsonb_typeof(p_detail) <> 'object' OR octet_length(p_detail::text) > 4096) THEN
        RAISE EXCEPTION 'service_heartbeat: detail — an object of at most 4 KiB' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF inst IS NULL THEN
        IF (SELECT count(*) FROM instances) <> 1 THEN
            RAISE EXCEPTION 'service_heartbeat: there is not exactly one instance — pass p_instance' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        SELECT id INTO inst FROM instances;
    END IF;
    INSERT INTO service_heartbeats AS h (instance_id, service, at, version, run_mode, detail)
    VALUES (inst, mine, now(), left(p_version, 100), p_run_mode, COALESCE(p_detail, '{}'::jsonb))
    ON CONFLICT (instance_id, service) DO UPDATE
       SET at = EXCLUDED.at, version = EXCLUDED.version, run_mode = EXCLUDED.run_mode, detail = EXCLUDED.detail;
END $$;
REVOKE ALL ON FUNCTION service_heartbeat(text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION service_heartbeat(text, text, text, jsonb, text) TO memory_authcheck, memory_exporter, memory_intake, memory_reconciler, memory_probe;
GRANT SELECT ON service_heartbeats TO memory_gateway, memory_worker;

CREATE TABLE IF NOT EXISTS run_mode_flags (
    category text NOT NULL,
    key      text NOT NULL,
    service  text NOT NULL,
    PRIMARY KEY (category, key)
);
INSERT INTO run_mode_flags (category, key, service) VALUES
    ('edge', 'export_enabled', 'exporter'),
    ('edge', 'login_enabled', 'memory-authcheck'),
    ('edge', 'synthetic_login_enabled', 'memory-probe'),
    ('edge', 'probe_enabled', 'memory-probe'),
    ('edge', 'c2_enabled', 'intake')
ON CONFLICT (category, key) DO NOTHING;
UPDATE run_mode_flags SET service = 'memory-probe'
 WHERE category = 'edge' AND key = 'synthetic_login_enabled' AND service = 'memory-authcheck';
GRANT SELECT ON run_mode_flags TO memory_gateway, memory_worker;

CREATE OR REPLACE FUNCTION settings_run_mode_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    svc text;
BEGIN
    IF NEW.value IS DISTINCT FROM 'true'::jsonb THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.value IS NOT DISTINCT FROM 'true'::jsonb THEN RETURN NEW; END IF;
    SELECT f.service INTO svc FROM run_mode_flags f WHERE f.category = NEW.category AND f.key = NEW.key;
    IF svc IS NULL THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM service_heartbeats h
                    WHERE h.instance_id = NEW.instance_id AND h.service = svc AND h.run_mode IN ('system', 'container')
                      AND h.at >= now() - interval '120 seconds') THEN
        RAISE EXCEPTION 'run_mode_user: %.% cannot be enabled — service % is in user mode or has not answered for a long time', NEW.category, NEW.key, svc
              USING ERRCODE = 'check_violation', CONSTRAINT = 'settings_run_mode';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION settings_run_mode_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS settings_run_mode ON settings;
CREATE TRIGGER settings_run_mode BEFORE INSERT OR UPDATE OF value ON settings FOR EACH ROW EXECUTE FUNCTION settings_run_mode_guard();

DO $$
DECLARE
    d text;
    g record;
BEGIN
    FOR d IN SELECT datname FROM pg_database WHERE datname IN ('memory_open', 'memory_closed', 'memory_audit') LOOP
        EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', d);
    END LOOP;
    FOR g IN SELECT * FROM (VALUES
        ('memory_open', 'memory_admin'), ('memory_open', 'memory_gateway'), ('memory_open', 'memory_worker'),
        ('memory_open', 'memory_test_purge'), ('memory_open', 'memory_exporter'), ('memory_open', 'memory_reconciler'),
        ('memory_closed', 'memory_admin'), ('memory_closed', 'memory_gateway'), ('memory_closed', 'memory_worker'),
        ('memory_closed', 'memory_test_purge'),
        ('memory_audit', 'memory_gateway'), ('memory_audit', 'memory_worker'), ('memory_audit', 'memory_audit_reader'),
        ('memory_audit', 'memory_audit_maint'), ('memory_audit', 'memory_intake'), ('memory_audit', 'memory_reconciler')) v(db, role)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_database WHERE datname = g.db) AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = g.role) THEN
            EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', g.db, g.role);
        END IF;
    END LOOP;
END $$;

-- [1a]

CREATE OR REPLACE FUNCTION service_heartbeat_edge_side(p_side text, p_serial bigint, p_root text, p_instance text DEFAULT NULL, p_at timestamptz DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    svc  text := CASE p_side WHEN 'edge' THEN 'edge' WHEN 'relay' THEN 'memory-relay' END;
    inst text := p_instance;
BEGIN
    IF session_user IS DISTINCT FROM 'memory_reconciler' THEN
        RAISE EXCEPTION 'service_heartbeat_edge_side: only the reconciler (memory_reconciler) writes, not %', session_user USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF svc IS NULL THEN
        RAISE EXCEPTION 'service_heartbeat_edge_side: the side is edge or relay' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF (p_serial IS NOT NULL AND p_serial < 1) OR (p_root IS NOT NULL AND p_root !~ '^[0-9a-f]{64}$') THEN
        RAISE EXCEPTION 'service_heartbeat_edge_side: serial ≥ 1, the root fingerprint is 64 hexadecimal characters' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF inst IS NULL THEN
        IF (SELECT count(*) FROM instances) <> 1 THEN
            RAISE EXCEPTION 'service_heartbeat_edge_side: there is not exactly one instance — pass p_instance' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        SELECT id INTO inst FROM instances;
    END IF;
    INSERT INTO service_heartbeats AS h (instance_id, service, at, version, run_mode, detail)
    VALUES (inst, svc, LEAST(now(), COALESCE(p_at, now())), NULL, 'container',
            jsonb_strip_nulls(jsonb_build_object('anchors_serial', p_serial, 'anchors_root_sha256', p_root, 'via', 'reconciler')))
    ON CONFLICT (instance_id, service) DO UPDATE
       SET at = EXCLUDED.at, version = EXCLUDED.version, run_mode = EXCLUDED.run_mode, detail = EXCLUDED.detail;
END $$;
DROP FUNCTION IF EXISTS service_heartbeat_edge_side(text, bigint, text, text);
REVOKE ALL ON FUNCTION service_heartbeat_edge_side(text, bigint, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION service_heartbeat_edge_side(text, bigint, text, text, timestamptz) TO memory_reconciler;

-- [1b]

-- [1c]

-- [1d]

CREATE OR REPLACE VIEW v_probe_settings WITH (security_barrier = true) AS
SELECT s.instance_id, s.key, s.value, s.updated_at
  FROM settings s
 WHERE s.category = 'edge' AND NOT s.secret
   AND s.key IN ('probe_enabled', 'probe_base_url', 'probe_interval_min',
                 'synthetic_login_enabled', 'synthetic_login_account', 'synthetic_login_interval_min');
GRANT SELECT ON v_probe_settings TO memory_probe;
CREATE OR REPLACE VIEW v_probe_connect WITH (security_barrier = true) AS
SELECT s.instance_id, s.key, s.value, s.updated_at, s.category
  FROM settings s
 WHERE NOT s.secret
   AND ((s.category = 'edge' AND s.key IN ('probe_connect_addr', 'probe_inner_hosts'))
     OR (s.category = 'access' AND s.key = 'trusted_proxies'));
GRANT SELECT ON v_probe_connect TO memory_probe;

INSERT INTO audit_spool_types (source, event_type) VALUES
    ('memory_probe', 'ops')
ON CONFLICT (source, event_type) DO NOTHING;

-- [1e]

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS auth_time timestamptz;

ALTER TABLE external_access ADD COLUMN IF NOT EXISTS ad_guid uuid;
ALTER TABLE external_access ADD COLUMN IF NOT EXISTS ad_pwd_last_set timestamptz;
SELECT memory_check_extend('external_access', 'external_access_disabled_code_check', 'disabled_code', ARRAY['ad_link_changed']);
SELECT memory_check_finish('external_access', 'external_access_disabled_code_check');

CREATE TABLE IF NOT EXISTS external_access_confirmations (
    id           uuid PRIMARY KEY,
    person_id    uuid NOT NULL REFERENCES people(id),
    instance_id  text NOT NULL REFERENCES instances(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    requested_ip inet,
    confirmed_by text CHECK (char_length(confirmed_by) BETWEEN 1 AND 300),
    confirmed_at timestamptz,
    expires_at   timestamptz,
    used_at      timestamptz,
    CONSTRAINT external_access_confirmations_confirmed CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS external_access_confirmations_person_idx ON external_access_confirmations (person_id) WHERE used_at IS NULL;
GRANT SELECT (person_id) ON external_access_confirmations TO memory_test_purge;

CREATE TABLE IF NOT EXISTS auth_budget (
    account_guid uuid NOT NULL,
    kind         text NOT NULL,
    run_failures int NOT NULL DEFAULT 0 CHECK (run_failures >= 0),
    run_last_at  timestamptz,
    day          date NOT NULL DEFAULT current_date,
    day_failures int NOT NULL DEFAULT 0 CHECK (day_failures >= 0),
    PRIMARY KEY (account_guid, kind)
);
CREATE INDEX IF NOT EXISTS auth_budget_recent_idx ON auth_budget (run_last_at) WHERE kind = 'password';
SELECT memory_check_extend('auth_budget', 'auth_budget_kind_check', 'kind', ARRAY['password', 'code']);
SELECT memory_check_finish('auth_budget', 'auth_budget_kind_check');

CREATE TABLE IF NOT EXISTS auth_pause (
    id          uuid PRIMARY KEY,
    instance_id text NOT NULL REFERENCES instances(id),
    started_at  timestamptz NOT NULL DEFAULT now(),
    until       timestamptz NOT NULL,
    reason      text NOT NULL,
    by          text NOT NULL CHECK (char_length(by) BETWEEN 1 AND 300),
    lifted_at   timestamptz,
    lifted_by   text CHECK (char_length(lifted_by) BETWEEN 1 AND 300),
    CONSTRAINT auth_pause_lifted CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);
CREATE INDEX IF NOT EXISTS auth_pause_live_idx ON auth_pause (instance_id, until) WHERE lifted_at IS NULL;
SELECT memory_check_extend('auth_pause', 'auth_pause_reason_check', 'reason', ARRAY['spray', 'manual', 'kill']);
SELECT memory_check_finish('auth_pause', 'auth_pause_reason_check');

CREATE OR REPLACE FUNCTION auth_pause_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    trusted boolean := current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = TG_RELID)
                       OR current_user = 'memory_edge_views'
                       OR COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false);
BEGIN
    IF trusted THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'DELETE' OR OLD.reason <> 'manual' THEN
        RAISE EXCEPTION 'auth_pause: pause % is not lifted by the panel: spraying expires on its own, the switch only with a second signature', OLD.reason
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF to_jsonb(NEW) - 'until' - 'lifted_at' - 'lifted_by' IS DISTINCT FROM to_jsonb(OLD) - 'until' - 'lifted_at' - 'lifted_by' THEN
        RAISE EXCEPTION 'auth_pause: for a manual pause only the expiry and the lifting change' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION auth_pause_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS auth_pause_guard ON auth_pause;
CREATE TRIGGER auth_pause_guard BEFORE UPDATE OR DELETE ON auth_pause FOR EACH ROW EXECUTE FUNCTION auth_pause_guard();

CREATE TABLE IF NOT EXISTS login_sessions (
    id             uuid PRIMARY KEY,
    secret_hash    bytea NOT NULL UNIQUE CHECK (octet_length(secret_hash) = 32),
    person_id      uuid NOT NULL REFERENCES people(id),
    instance_id    text NOT NULL REFERENCES instances(id),
    mfa_level      text NOT NULL,
    auth_time      timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz,
    revoked_reason text CHECK (revoked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT login_sessions_revoked CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS login_sessions_person_idx ON login_sessions (person_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS login_sessions_expires_idx ON login_sessions (expires_at);
SELECT memory_check_extend('login_sessions', 'login_sessions_mfa_level_check', 'mfa_level',
                           ARRAY['none', 'totp', 'recovery', 'radius_otp', 'push', 'passkey']);
SELECT memory_check_finish('login_sessions', 'login_sessions_mfa_level_check');
GRANT SELECT (person_id) ON login_sessions TO memory_test_purge;

CREATE TABLE IF NOT EXISTS edge_grants (
    id             uuid PRIMARY KEY,
    grant_hash     bytea NOT NULL UNIQUE CHECK (octet_length(grant_hash) = 32),
    person_id      uuid NOT NULL REFERENCES people(id),
    session_id     uuid NOT NULL REFERENCES login_sessions(id),
    instance_id    text NOT NULL REFERENCES instances(id),
    client_id      text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
    resource       text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
    challenge_hash text NOT NULL CHECK (challenge_hash ~ '^[A-Za-z0-9_-]{43}$'),
    mfa_level      text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    used_at        timestamptz,
    connection_id  uuid,
    revoked_at     timestamptz,
    CONSTRAINT edge_grants_used CHECK ((used_at IS NULL) = (connection_id IS NULL))
);
CREATE INDEX IF NOT EXISTS edge_grants_person_idx ON edge_grants (person_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS edge_grants_session_idx ON edge_grants (session_id);
SELECT memory_check_extend('edge_grants', 'edge_grants_mfa_level_check', 'mfa_level',
                           ARRAY['none', 'totp', 'recovery', 'radius_otp', 'push', 'passkey']);
SELECT memory_check_finish('edge_grants', 'edge_grants_mfa_level_check');
GRANT SELECT (person_id) ON edge_grants TO memory_test_purge;

CREATE TABLE IF NOT EXISTS login_check_nonces (
    nonce   bytea PRIMARY KEY CHECK (octet_length(nonce) = 16),
    seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_check_nonces_seen_idx ON login_check_nonces (seen_at);

CREATE TABLE IF NOT EXISTS external_notices (
    id          uuid PRIMARY KEY,
    instance_id text NOT NULL REFERENCES instances(id),
    person_id   uuid NOT NULL REFERENCES people(id),
    kind        text NOT NULL,
    data        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 2048),
    created_at  timestamptz NOT NULL DEFAULT now(),
    seen_at     timestamptz
);
CREATE INDEX IF NOT EXISTS external_notices_unseen_idx ON external_notices (person_id) WHERE seen_at IS NULL;
SELECT memory_check_extend('external_notices', 'external_notices_kind_check', 'kind',
                           ARRAY['optin_enabled', 'optin_disabled', 'connection_new', 'connection_revoked_reuse',
                                 'refresh_reuse_rejected', 'budget_exhausted', 'idle_reminder', 'idle_off', 'ad_revoked']);
SELECT memory_check_finish('external_notices', 'external_notices_kind_check');
GRANT SELECT (person_id) ON external_notices TO memory_test_purge;

ALTER TABLE oauth_connections ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'keycloak';
ALTER TABLE oauth_connections ADD COLUMN IF NOT EXISTS grant_hash bytea;
ALTER TABLE oauth_connections ADD COLUMN IF NOT EXISTS challenge_hash text;
ALTER TABLE oauth_connections ADD COLUMN IF NOT EXISTS mfa_level text;
ALTER TABLE oauth_connections ADD COLUMN IF NOT EXISTS consent_version smallint;
SELECT memory_check_extend('oauth_connections', 'oauth_connections_origin_check', 'origin', ARRAY['keycloak', 'edge']);
SELECT memory_check_finish('oauth_connections', 'oauth_connections_origin_check');
SELECT memory_check_extend('oauth_connections', 'oauth_connections_mfa_level_check', 'mfa_level',
                           ARRAY['none', 'totp', 'recovery', 'radius_otp', 'push', 'passkey']);
SELECT memory_check_finish('oauth_connections', 'oauth_connections_mfa_level_check');
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'oauth_connections'::regclass AND conname = 'oauth_connections_edge_fields') THEN
        ALTER TABLE oauth_connections ADD CONSTRAINT oauth_connections_edge_fields CHECK (
            origin <> 'edge' OR (grant_hash IS NOT NULL AND octet_length(grant_hash) = 32
                                 AND challenge_hash IS NOT NULL AND challenge_hash ~ '^[A-Za-z0-9_-]{43}$'
                                 AND mfa_level IS NOT NULL AND consent_version IS NOT NULL AND consent_version >= 1));
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS oauth_connections_grant_idx ON oauth_connections (grant_hash) WHERE grant_hash IS NOT NULL;

SELECT memory_check_extend('api_keys', 'api_keys_client_kind_check', 'client_kind', ARRAY['vscode', 'local_other', 'claude_desktop']);
SELECT memory_check_finish('api_keys', 'api_keys_client_kind_check');
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'api_keys'::regclass AND conname = 'api_keys_oauth_grant_check'
               AND pg_get_constraintdef(oid) LIKE '%cloud_other%')
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'api_keys'::regclass AND conname = 'api_keys_oauth_grant_check_new') THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_oauth_grant_check_new CHECK (
            (auth_method = 'api_key' AND key_hash IS NOT NULL) OR
            (auth_method = 'oauth' AND key_hash IS NULL AND principal_type = 'person' AND principal_id IS NOT NULL
             AND kind = 'personal' AND tier = 'T2' AND NOT preview AND key_prefix = 'oauth'
             AND client_kind IS NOT NULL AND client_kind <> 'script'
             AND expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= created_at + interval '90 days')) NOT VALID;
    END IF;
END $$;
SELECT memory_check_finish('api_keys', 'api_keys_oauth_grant_check');

SELECT memory_check_extend('mail_outbox', 'mail_outbox_kind_check', 'kind', ARRAY['external']);
SELECT memory_check_finish('mail_outbox', 'mail_outbox_kind_check');

CREATE OR REPLACE FUNCTION edge_revoke_lane(p_item jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF to_regprocedure('edge_enqueue_revoke(jsonb)') IS NULL THEN
        IF to_regclass('edge_outbox_control') IS NOT NULL THEN
            RAISE EXCEPTION 'edge_revoke_lane: the revocation queue exists but the edge_enqueue_revoke function does not' USING ERRCODE = 'undefined_function';
        END IF;
        RETURN;
    END IF;
    EXECUTE 'SELECT edge_enqueue_revoke($1)' USING p_item;
END $$;
REVOKE ALL ON FUNCTION edge_revoke_lane(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION edge_revoke_person_do(p_person uuid, p_reason text, p_before timestamptz, p_off boolean) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_person IS NULL OR p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'edge_revoke_person: a person and a reason code [a-z0-9_] are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE login_sessions SET revoked_at = now(), revoked_reason = p_reason
     WHERE person_id = p_person AND revoked_at IS NULL AND (p_before IS NULL OR auth_time < p_before);
    UPDATE edge_grants g SET revoked_at = now()
     WHERE g.person_id = p_person AND g.used_at IS NULL AND g.revoked_at IS NULL
       AND (p_before IS NULL OR EXISTS (SELECT 1 FROM login_sessions s WHERE s.id = g.session_id AND s.auth_time < p_before));
    IF to_regclass('login_tickets') IS NOT NULL THEN
        DELETE FROM login_tickets lt WHERE lt.person_id = p_person AND lt.used_at IS NULL AND (p_before IS NULL OR lt.created_at < p_before);
    END IF;
    WITH revoked AS (
        UPDATE api_keys k SET revoked_at = now() FROM oauth_connections c
         WHERE c.id = k.id AND c.origin = 'edge' AND c.person_id = p_person AND k.auth_method = 'oauth' AND k.revoked_at IS NULL
           AND (p_before IS NULL
                OR NOT (k.created_at >= p_before
                        AND EXISTS (SELECT 1 FROM edge_grants g JOIN login_sessions s ON s.id = g.session_id
                                     WHERE g.id::text = c.session_id AND s.auth_time >= p_before)))
        RETURNING k.id),
    cancelled AS (UPDATE action_plans SET status = 'cancelled' WHERE status = 'pending' AND key_id IN (SELECT id FROM revoked))
    SELECT count(*)::int INTO n FROM revoked;
    PERFORM edge_revoke_lane(jsonb_strip_nulls(jsonb_build_object(
        'type', 'person', 'id', p_person::text, 'reason', p_reason,
        'before', CASE WHEN p_before IS NOT NULL THEN to_char(p_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
        'external_access_off', CASE WHEN p_off THEN true END)));
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION edge_revoke_person_do(uuid, text, timestamptz, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION edge_revoke_person(p_person uuid, p_reason text, p_before timestamptz DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    RETURN edge_revoke_person_do(p_person, p_reason, p_before, false);
END $$;
REVOKE ALL ON FUNCTION edge_revoke_person(uuid, text, timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION external_access_disable(p_person uuid, p_by text, p_code text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_by IS NULL OR char_length(p_by) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'external_access_disable: who disabled it — 1–300 characters' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE external_access SET disabled_at = now(), disabled_by = p_by, disabled_code = p_code, updated_at = now()
     WHERE person_id = p_person AND enabled_at IS NOT NULL AND disabled_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 AND NOT EXISTS (SELECT 1 FROM external_access WHERE person_id = p_person) THEN
        RETURN false;
    END IF;
    PERFORM edge_revoke_person_do(p_person, p_code, NULL, true);
    RETURN n > 0;
END $$;
REVOKE ALL ON FUNCTION external_access_disable(uuid, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION edge_revoke_connection(p_id uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n int;
BEGIN
    IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'edge_revoke_connection: reason — a code [a-z0-9_]' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    WITH revoked AS (
        UPDATE api_keys k SET revoked_at = now() FROM oauth_connections c
         WHERE c.id = k.id AND k.id = p_id AND c.origin = 'edge' AND k.auth_method = 'oauth' AND k.revoked_at IS NULL
        RETURNING k.id),
    cancelled AS (UPDATE action_plans SET status = 'cancelled' WHERE status = 'pending' AND key_id IN (SELECT id FROM revoked))
    SELECT count(*)::int INTO n FROM revoked;
    RETURN n > 0;
END $$;
REVOKE ALL ON FUNCTION edge_revoke_connection(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION api_keys_edge_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM oauth_connections c WHERE c.id = NEW.id AND c.origin = 'edge') THEN
        PERFORM edge_revoke_lane(jsonb_build_object('type', 'connection', 'id', NEW.id::text, 'reason', 'revoked'));
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION api_keys_edge_revoked() FROM PUBLIC;
DROP TRIGGER IF EXISTS api_keys_edge_revoked ON api_keys;
CREATE TRIGGER api_keys_edge_revoked AFTER UPDATE OF revoked_at ON api_keys FOR EACH ROW
    WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.auth_method = 'oauth')
    EXECUTE FUNCTION api_keys_edge_revoked();

CREATE OR REPLACE FUNCTION people_external_off() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM external_access_disable(NEW.id, 'auto', 'person_inactive');
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION people_external_off() FROM PUBLIC;
DROP TRIGGER IF EXISTS people_external_off ON people;
CREATE TRIGGER people_external_off AFTER UPDATE OF active ON people FOR EACH ROW
    WHEN (OLD.active AND NOT NEW.active)
    EXECUTE FUNCTION people_external_off();

CREATE OR REPLACE FUNCTION edge_accept_connection(p jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    g        edge_grants%ROWTYPE;
    v_hash   bytea;
    v_conn   uuid;
    v_person uuid;
    v_from   timestamptz;
    v_until  timestamptz;
    v_ver    int;
    v_kind   text := p->>'client_kind';
    v_iss    text := p->>'issuer';
    v_days   int;
BEGIN
    IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RETURN 'rejected'; END IF;
    BEGIN
        v_conn   := (p->>'connection_id')::uuid;
        v_person := (p->>'person_id')::uuid;
        v_from   := (p->>'created_at')::timestamptz;
        v_until  := (p->>'expires_at')::timestamptz;
        v_ver    := (p->>'consent_version')::int;
    EXCEPTION WHEN data_exception THEN
        RETURN 'rejected';
    END;
    IF v_conn IS NULL OR v_person IS NULL OR v_from IS NULL OR v_until IS NULL OR v_ver IS NULL OR v_ver NOT BETWEEN 1 AND 32767
       OR p->>'grant_id' IS NULL OR p->>'client_id' IS NULL OR p->>'resource' IS NULL OR p->>'challenge_hash' IS NULL
       OR v_kind IS NULL OR v_kind = 'script' OR v_iss IS NULL THEN
        RETURN 'rejected';
    END IF;
    v_hash := sha256(convert_to(p->>'grant_id', 'UTF8'));
    UPDATE edge_grants eg SET used_at = now(), connection_id = v_conn
     WHERE eg.grant_hash = v_hash AND eg.used_at IS NULL AND eg.revoked_at IS NULL AND eg.person_id = v_person
       AND eg.client_id = p->>'client_id' AND eg.resource = p->>'resource' AND eg.challenge_hash = p->>'challenge_hash'
       AND eg.created_at > now() - interval '24 hours'
       AND EXISTS (SELECT 1 FROM login_sessions s WHERE s.id = eg.session_id AND s.revoked_at IS NULL)
    RETURNING eg.* INTO g;
    IF NOT FOUND THEN
        IF EXISTS (SELECT 1 FROM oauth_connections c WHERE c.id = v_conn AND c.origin = 'edge' AND c.grant_hash = v_hash AND c.person_id = v_person) THEN
            RETURN 'already';
        END IF;
        IF EXISTS (SELECT 1 FROM edge_grants eg LEFT JOIN login_sessions s ON s.id = eg.session_id
                    WHERE eg.grant_hash = v_hash AND (eg.revoked_at IS NOT NULL OR s.revoked_at IS NOT NULL)) THEN
            RETURN 'grant_revoked';
        END IF;
        RETURN 'rejected';
    END IF;
    SELECT CASE WHEN jsonb_typeof(value) = 'number' THEN (value#>>'{}')::numeric::int END INTO v_days
      FROM settings WHERE instance_id = g.instance_id AND category = 'edge' AND key = 'connection_max_days';
    v_days := LEAST(GREATEST(COALESCE(v_days, 30), 1), 30);
    v_from := LEAST(v_from, now());
    v_until := LEAST(v_until, v_from + make_interval(days => v_days));
    IF v_until <= v_from THEN RETURN 'rejected'; END IF;
    BEGIN
        INSERT INTO api_keys (id, key_prefix, key_hash, auth_method, principal_type, principal_id, kind, tier, instance_id,
                              client_kind, client_label, basis, created_at, expires_at)
        VALUES (v_conn, 'oauth', NULL, 'oauth', 'person', g.person_id, 'personal', 'T2', g.instance_id,
                v_kind, g.client_id, 'edge login', v_from, v_until);
        INSERT INTO oauth_connections (id, instance_id, issuer, subject, client_id, session_id, person_id, resource_url,
                                       origin, grant_hash, challenge_hash, mfa_level, consent_version)
        VALUES (v_conn, g.instance_id, v_iss, g.person_id::text, g.client_id, g.id::text, g.person_id, g.resource,
                'edge', g.grant_hash, g.challenge_hash, g.mfa_level, v_ver);
    EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
        RETURN 'rejected';
    END;
    RETURN 'accepted';
END $$;
REVOKE ALL ON FUNCTION edge_accept_connection(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION external_notice(p_person uuid, p_kind text, p_data jsonb, p_mail boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    pr    people%ROWTYPE;
    vars  jsonb := COALESCE(p_data->'vars', '{}'::jsonb);
    data  jsonb;
    subj  text := p_data#>>'{mail,subject}';
    body  text := p_data#>>'{mail,body}';
    links text := '([a-z][a-z0-9+.-]*:/|www\.|@|mailto:|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}|[0-9a-zA-Z\u0430-\u044f\u0410-\u042f\u0451\u0401-]+\.(\u0440\u0444|\u0420\u0424|\u0440\u0443\u0441|\u0420\u0423\u0421))';
BEGIN
    IF p_data IS NOT NULL AND jsonb_typeof(p_data) <> 'object' OR jsonb_typeof(vars) <> 'object' THEN
        RAISE EXCEPTION 'external_notice: p_data and vars are objects' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF (p_kind = ANY (memory_check_literals(
           (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
             WHERE c.conrelid = 'external_notices'::regclass AND c.conname = 'external_notices_kind_check'), 'kind'))) IS NOT TRUE THEN
        RAISE EXCEPTION 'external_notice: the kind is not in the registry external_notices.kind' USING ERRCODE = 'check_violation';
    END IF;
    IF concat_ws(' ', vars->>'program', vars->>'time', vars->>'network', subj, body) ~* links THEN
        RAISE EXCEPTION 'external_notice: a banner and an e-mail have no links at all' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO pr FROM people WHERE id = p_person;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'external_notice: no such person' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    data := jsonb_strip_nulls(jsonb_build_object('program', left(vars->>'program', 200), 'time', left(vars->>'time', 40),
                                                 'network', left(vars->>'network', 64)));
    IF COALESCE((p_data->>'banner')::boolean, true) THEN
        INSERT INTO external_notices (id, instance_id, person_id, kind, data) VALUES (gen_random_uuid(), pr.instance_id, p_person, p_kind, data);
    END IF;
    IF NOT COALESCE(p_mail, false) THEN RETURN; END IF;
    IF subj IS NULL OR body IS NULL OR char_length(subj) NOT BETWEEN 1 AND 300 OR char_length(body) NOT BETWEEN 1 AND 8000 THEN
        RAISE EXCEPTION 'external_notice: e-mail — subject 1–300 and text 1–8000 characters' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT pr.active OR lower(btrim(pr.login)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RETURN; END IF;
    INSERT INTO mail_outbox (id, instance_id, kind, to_address, subject, body_text, dedupe_key, created_by)
    VALUES (gen_random_uuid(), pr.instance_id, 'external', lower(btrim(pr.login)), subj, body, left(p_data->>'dedupe_key', 200), 'external_notice:' || p_kind)
    ON CONFLICT (instance_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION external_notice(uuid, text, jsonb, boolean) FROM PUBLIC;

CREATE OR REPLACE VIEW v_authcheck_settings WITH (security_barrier = true) AS
SELECT s.instance_id, s.category, s.key, s.value, s.secret, s.enc_kid, s.updated_at
  FROM settings s
 WHERE (s.category IN ('edge', 'ldap')
        OR (s.category = 'admin' AND s.key IN ('webauthn_required', 'webauthn_min_keys'))
        OR (s.category = 'access' AND s.key = 'test_sessions'))
   AND (NOT s.secret OR (s.category = 'ldap' AND s.key = 'bind_password'));

CREATE OR REPLACE VIEW v_authcheck_ad_links WITH (security_barrier = true) AS
SELECT i.person_id, i.external_id, i.verified, i.active
  FROM person_identities i
 WHERE i.system = 'ad';

CREATE OR REPLACE VIEW v_memory_admins AS
SELECT DISTINCT person_id FROM (
    SELECT g.person_id FROM role_grants g
     WHERE g.role_code = 'memory_admin' AND g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now()) AND g.valid_from <= now()
    UNION ALL
    SELECT a.person_id FROM admin_users a WHERE a.person_id IS NOT NULL AND a.disabled_at IS NULL
) x;

GRANT SELECT (id, login, active, attrs, instance_id) ON people TO memory_authcheck;
GRANT SELECT ON external_access, v_authcheck_ad_links, v_authcheck_settings, v_memory_admins, instances TO memory_authcheck;
GRANT UPDATE (last_external_login_at, ad_checked_at, ad_ok, updated_at) ON external_access TO memory_authcheck;
GRANT UPDATE (ad_guid, ad_pwd_last_set) ON external_access TO memory_authcheck;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_budget, login_sessions, edge_grants TO memory_authcheck;
GRANT SELECT, INSERT, DELETE ON login_check_nonces TO memory_authcheck;
GRANT SELECT, INSERT ON auth_pause TO memory_authcheck;
GRANT SELECT, DELETE ON external_access_confirmations TO memory_authcheck;
GRANT EXECUTE ON FUNCTION edge_revoke_person(uuid, text, timestamptz), external_access_disable(uuid, text, text),
                          external_notice(uuid, text, jsonb, boolean) TO memory_authcheck;
GRANT SELECT ON external_access TO memory_gateway;
GRANT INSERT (person_id, instance_id, enabled_at, enabled_session_id, first_enabled_at, first_confirm, updated_at) ON external_access TO memory_gateway;
GRANT UPDATE (enabled_at, enabled_session_id, first_enabled_at, first_confirm, disabled_at, disabled_by, disabled_code, updated_at)
    ON external_access TO memory_gateway;
GRANT SELECT, INSERT, UPDATE ON external_access_confirmations TO memory_gateway;
GRANT SELECT, UPDATE ON external_notices TO memory_gateway;
GRANT SELECT ON auth_pause, auth_budget TO memory_gateway;
GRANT SELECT (id, person_id, created_at, expires_at, revoked_at) ON login_sessions TO memory_gateway;
GRANT EXECUTE ON FUNCTION edge_revoke_person(uuid, text, timestamptz), external_access_disable(uuid, text, text),
                          edge_revoke_connection(uuid, text), external_notice(uuid, text, jsonb, boolean) TO memory_gateway;
GRANT INSERT, UPDATE ON auth_pause TO memory_admin_plane;
GRANT EXECUTE ON FUNCTION edge_accept_connection(jsonb), edge_revoke_connection(uuid, text),
                          edge_revoke_person(uuid, text, timestamptz), external_notice(uuid, text, jsonb, boolean) TO memory_intake;
GRANT SELECT (id, last_used_at) ON api_keys TO memory_intake;
GRANT UPDATE (last_used_at) ON api_keys TO memory_intake;
GRANT SELECT ON external_access, auth_pause TO memory_exporter;
GRANT SELECT ON external_notices TO memory_worker;

INSERT INTO audit_spool_types (source, event_type) VALUES
    ('memory_authcheck', 'external'),
    ('memory_authcheck', 'edge_alert')
ON CONFLICT (source, event_type) DO NOTHING;

-- [1f]

CREATE TABLE IF NOT EXISTS mfa_factors (
    id                 uuid PRIMARY KEY,
    person_id          uuid NOT NULL REFERENCES people(id),
    kind               text NOT NULL,
    secret_enc         bytea NOT NULL CHECK (octet_length(secret_enc) BETWEEN 1 AND 1024),
    key_version        int NOT NULL DEFAULT 1 CHECK (key_version >= 1),
    label              text CHECK (char_length(label) BETWEEN 1 AND 64),
    created_at         timestamptz NOT NULL DEFAULT now(),
    pending_expires_at timestamptz,
    activated_at       timestamptz,
    last_step          bigint CHECK (last_step >= 0),
    disabled_at        timestamptz,
    disabled_reason    text CHECK (disabled_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
    CONSTRAINT mfa_factors_disabled CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS mfa_factors_active_idx ON mfa_factors (person_id) WHERE disabled_at IS NULL AND activated_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS mfa_factors_person_idx ON mfa_factors (person_id);
SELECT memory_check_extend('mfa_factors', 'mfa_factors_kind_check', 'kind', ARRAY['totp', 'radius_otp']);
SELECT memory_check_finish('mfa_factors', 'mfa_factors_kind_check');
GRANT SELECT (person_id) ON mfa_factors TO memory_test_purge;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id   uuid NOT NULL REFERENCES people(id),
    code_hmac   bytea NOT NULL CHECK (octet_length(code_hmac) = 32),
    key_version int NOT NULL DEFAULT 1 CHECK (key_version >= 1),
    created_at  timestamptz NOT NULL DEFAULT now(),
    used_at     timestamptz,
    CONSTRAINT mfa_recovery_codes_person_code UNIQUE (person_id, code_hmac)
);
CREATE INDEX IF NOT EXISTS mfa_recovery_codes_left_idx ON mfa_recovery_codes (person_id) WHERE used_at IS NULL;
GRANT SELECT (person_id) ON mfa_recovery_codes TO memory_test_purge;

CREATE TABLE IF NOT EXISTS mfa_mode_changes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id text NOT NULL REFERENCES instances(id),
    at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    from_mode   text NOT NULL,
    to_mode     text NOT NULL,
    by          text NOT NULL CHECK (char_length(by) BETWEEN 1 AND 300),
    approval_id uuid
);
CREATE INDEX IF NOT EXISTS mfa_mode_changes_last_idx ON mfa_mode_changes (instance_id, at DESC);
SELECT memory_check_extend('mfa_mode_changes', 'mfa_mode_changes_from_mode_check', 'from_mode', ARRAY['off', 'optional', 'required']);
SELECT memory_check_finish('mfa_mode_changes', 'mfa_mode_changes_from_mode_check');
SELECT memory_check_extend('mfa_mode_changes', 'mfa_mode_changes_to_mode_check', 'to_mode', ARRAY['off', 'optional', 'required']);
SELECT memory_check_finish('mfa_mode_changes', 'mfa_mode_changes_to_mode_check');

CREATE TABLE IF NOT EXISTS login_tickets (
    ticket_hash bytea PRIMARY KEY CHECK (octet_length(ticket_hash) = 32),
    person_id   uuid NOT NULL REFERENCES people(id),
    instance_id text NOT NULL REFERENCES instances(id),
    tx_id       text NOT NULL CHECK (tx_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    mfa_level   text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS login_tickets_expires_idx ON login_tickets (expires_at);
SELECT memory_check_extend('login_tickets', 'login_tickets_mfa_level_check', 'mfa_level',
                           ARRAY['none', 'totp', 'recovery', 'radius_otp', 'push', 'passkey']);
SELECT memory_check_finish('login_tickets', 'login_tickets_mfa_level_check');
GRANT SELECT (person_id) ON login_tickets TO memory_test_purge;

CREATE TABLE IF NOT EXISTS mfa_factor_resets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id text NOT NULL REFERENCES instances(id),
    person_id   uuid NOT NULL REFERENCES people(id),
    approval_id uuid NOT NULL UNIQUE,
    at          timestamptz NOT NULL DEFAULT now(),
    by          uuid
);
GRANT SELECT (person_id) ON mfa_factor_resets TO memory_test_purge;

ALTER TABLE auth_budget ADD COLUMN IF NOT EXISTS locked_until timestamptz;

SELECT memory_check_extend('mail_outbox', 'mail_outbox_kind_check', 'kind', ARRAY['security']);
SELECT memory_check_finish('mail_outbox', 'mail_outbox_kind_check');

CREATE OR REPLACE FUNCTION mfa_mode_rank(p_mode text) RETURNS int
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT CASE p_mode WHEN 'off' THEN 0 WHEN 'optional' THEN 1 WHEN 'required' THEN 2 END
$$;

CREATE OR REPLACE FUNCTION mfa_mode_of(p_value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT CASE WHEN jsonb_typeof(p_value) = 'string' AND p_value #>> '{}' IN ('off', 'optional', 'required') THEN p_value #>> '{}'
                ELSE 'required' END
$$;

CREATE OR REPLACE FUNCTION mfa_mode_floor_without(p_instance text, p_kind text, p_serial bigint) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v text;
BEGIN
    IF to_regclass('anchors_applied') IS NULL THEN RETURN 'off'; END IF;
    EXECUTE $q$
        SELECT m FROM (SELECT DISTINCT ON (a.kind) a.mfa_mode_min AS m
                         FROM anchors_applied a
                        WHERE a.instance_id = $1 AND a.mfa_mode_min IS NOT NULL
                          AND (a.kind, a.serial) IS DISTINCT FROM ($2, $3)
                        ORDER BY a.kind, a.serial DESC) x
         ORDER BY COALESCE(mfa_mode_rank(m), 2) DESC LIMIT 1$q$ INTO v USING p_instance, p_kind, p_serial;
    IF v IS NULL THEN RETURN 'off'; END IF;
    RETURN CASE WHEN mfa_mode_rank(v) IS NULL THEN 'required' ELSE v END;
END $$;

CREATE OR REPLACE FUNCTION mfa_mode_floor(p_instance text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    RETURN mfa_mode_floor_without(p_instance, NULL, NULL);
END $$;

CREATE OR REPLACE FUNCTION mfa_policy(p_instance text)
RETURNS TABLE(mode text, required_since timestamptz, grace_days int, grace_until timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_variable
DECLARE
    v_mode  text;
    v_floor text;
    v_days  int := 0;
    v_since timestamptz;
    v_raw   jsonb;
    l_to    text;
    l_at    timestamptz;
BEGIN
    SELECT COALESCE(s.value, s.default_value) INTO v_raw FROM settings s WHERE s.instance_id = p_instance AND s.category = 'edge' AND s.key = 'mfa_mode';
    v_mode := mfa_mode_of(v_raw);
    v_floor := mfa_mode_floor(p_instance);
    IF mfa_mode_rank(v_floor) > mfa_mode_rank(v_mode) THEN v_mode := v_floor; END IF;
    SELECT COALESCE(s.value, s.default_value) INTO v_raw FROM settings s WHERE s.instance_id = p_instance AND s.category = 'edge' AND s.key = 'mfa_required_grace_days';
    IF jsonb_typeof(v_raw) = 'number' AND (v_raw #>> '{}')::numeric BETWEEN 0 AND 60 THEN
        v_days := floor((v_raw #>> '{}')::numeric)::int;
    END IF;
    IF v_mode = 'required' THEN
        SELECT c.to_mode, c.at INTO l_to, l_at FROM mfa_mode_changes c
         WHERE c.instance_id = p_instance ORDER BY c.at DESC, c.id DESC LIMIT 1;
        IF l_to = 'required' THEN v_since := l_at; END IF;
    END IF;
    RETURN QUERY SELECT v_mode, v_since, v_days, v_since + make_interval(days => v_days);
END $$;

CREATE OR REPLACE FUNCTION mfa_coverage(p_instance text) RETURNS TABLE(optin int, enrolled int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT count(*)::int,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM mfa_factors f
                                           WHERE f.person_id = e.person_id AND f.activated_at IS NOT NULL AND f.disabled_at IS NULL))::int
      FROM external_access e
     WHERE e.instance_id = p_instance AND e.enabled_at IS NOT NULL AND e.disabled_at IS NULL
$$;

CREATE OR REPLACE FUNCTION mfa_mode_transition(p_instance text, p_from text, p_to text, p_by text, p_approval_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    s record;
    n int := 0;
BEGIN
    IF mfa_mode_rank(p_from) IS NULL OR mfa_mode_rank(p_to) IS NULL THEN
        RAISE EXCEPTION 'mfa_mode_transition: modes are off, optional, required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_by IS NULL OR char_length(p_by) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'mfa_mode_transition: who changed it — 1–300 characters' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_from = p_to THEN RETURN 0; END IF;
    INSERT INTO mfa_mode_changes (instance_id, from_mode, to_mode, by, approval_id) VALUES (p_instance, p_from, p_to, p_by, p_approval_id);
    IF p_to = 'off' THEN RETURN 0; END IF;
    IF to_regclass('login_sessions') IS NULL OR to_regclass('edge_grants') IS NULL THEN RETURN 0; END IF;
    FOR s IN
        UPDATE login_sessions ls SET revoked_at = now(), revoked_reason = 'mfa_mode'
         WHERE ls.instance_id = p_instance AND ls.revoked_at IS NULL AND ls.mfa_level = 'none' AND ls.expires_at > now()
           AND (p_to = 'required' OR EXISTS (SELECT 1 FROM mfa_factors f
                                              WHERE f.person_id = ls.person_id AND f.activated_at IS NOT NULL AND f.disabled_at IS NULL))
        RETURNING ls.secret_hash
    LOOP
        PERFORM edge_revoke_lane(jsonb_build_object('type', 'session', 'id', encode(s.secret_hash, 'hex'), 'reason', 'mfa_mode'));
        n := n + 1;
    END LOOP;
    UPDATE edge_grants g SET revoked_at = now()
     WHERE g.instance_id = p_instance AND g.used_at IS NULL AND g.revoked_at IS NULL AND g.mfa_level = 'none'
       AND (p_to = 'required' OR EXISTS (SELECT 1 FROM mfa_factors f
                                          WHERE f.person_id = g.person_id AND f.activated_at IS NOT NULL AND f.disabled_at IS NULL));
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION mfa_mode_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    fl     text;
    v_from text := mfa_mode_of(COALESCE(OLD.value, OLD.default_value));
    v_to   text := mfa_mode_of(COALESCE(NEW.value, NEW.default_value));
    v_appr uuid;
    raw    text := current_setting('memory.approval_id', true);
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mfa_mode'), hashtext(NEW.instance_id));
    fl := mfa_mode_floor(NEW.instance_id);
    IF mfa_mode_rank(fl) > mfa_mode_rank(v_from) THEN v_from := fl; END IF;
    IF mfa_mode_rank(fl) > mfa_mode_rank(v_to) THEN v_to := fl; END IF;
    IF v_from IS DISTINCT FROM v_to AND to_regprocedure('mfa_mode_approval(text,text)') IS NOT NULL THEN
        v_appr := mfa_mode_approval(NEW.instance_id, raw);
    END IF;
    PERFORM mfa_mode_transition(NEW.instance_id, v_from, v_to, COALESCE(NEW.updated_by::text, 'system'), v_appr);
    RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER settings_mfa_mode AFTER UPDATE OF value ON settings FOR EACH ROW
    WHEN (NEW.category = 'edge' AND NEW.key = 'mfa_mode' AND OLD.value IS DISTINCT FROM NEW.value)
    EXECUTE FUNCTION mfa_mode_apply();

CREATE OR REPLACE FUNCTION security_mail(p_person uuid, p_template text, p_subject text, p_body text, p_dedupe text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    pr    people%ROWTYPE;
    n     int;
    links text := '([a-z][a-z0-9+.-]*:/|www\.|@|mailto:|[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}|[0-9a-zA-Z\u0430-\u044f\u0410-\u042f\u0451\u0401-]+\.(\u0440\u0444|\u0420\u0424|\u0440\u0443\u0441|\u0420\u0423\u0421))';
BEGIN
    IF p_template IS NULL OR p_template !~ '^[a-z][a-z0-9_]{0,63}$' THEN
        RAISE EXCEPTION 'security_mail: template — a code [a-z0-9_]' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_subject IS NULL OR p_body IS NULL OR char_length(p_subject) NOT BETWEEN 1 AND 300 OR char_length(p_body) NOT BETWEEN 1 AND 8000 THEN
        RAISE EXCEPTION 'security_mail: subject 1–300 and text 1–8000 characters' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF concat_ws(' ', p_subject, p_body) ~* links THEN
        RAISE EXCEPTION 'security_mail: a security e-mail has no links at all' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO pr FROM people WHERE id = p_person;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'security_mail: no such person' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT pr.active OR lower(btrim(pr.login)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RETURN false; END IF;
    INSERT INTO mail_outbox (id, instance_id, kind, to_address, subject, body_text, dedupe_key, created_by)
    VALUES (gen_random_uuid(), pr.instance_id, 'security', lower(btrim(pr.login)), p_subject, p_body, left(p_dedupe, 200), 'security:' || p_template)
    ON CONFLICT (instance_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n > 0;
END $$;

CREATE OR REPLACE FUNCTION login_ticket_take(p_ticket_hash bytea, p_tx_id text, p_person uuid)
RETURNS TABLE(status text, mfa_level text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    t_person uuid;
    t_level  text;
BEGIN
    IF p_ticket_hash IS NULL OR p_tx_id IS NULL OR p_person IS NULL THEN
        RAISE EXCEPTION 'login_ticket_take: ticket, request and person are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE login_tickets lt SET used_at = now()
     WHERE lt.ticket_hash = p_ticket_hash AND lt.tx_id = p_tx_id AND lt.used_at IS NULL AND lt.expires_at > now()
    RETURNING lt.person_id, lt.mfa_level INTO t_person, t_level;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'none'::text, NULL::text;
    ELSIF t_person <> p_person THEN
        RETURN QUERY SELECT 'other_person'::text, NULL::text;
    ELSE
        RETURN QUERY SELECT 'ok'::text, t_level;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION mfa_reset_revoke_sessions(p_instance text, p_person uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    s record;
    n int := 0;
BEGIN
    IF p_instance IS NULL OR p_person IS NULL THEN
        RAISE EXCEPTION 'mfa_reset_revoke_sessions: instance and person are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF to_regclass('login_sessions') IS NULL OR to_regclass('edge_grants') IS NULL THEN RETURN 0; END IF;
    FOR s IN
        UPDATE login_sessions ls SET revoked_at = now(), revoked_reason = 'factor_reset'
         WHERE ls.instance_id = p_instance AND ls.person_id = p_person AND ls.revoked_at IS NULL AND ls.expires_at > now()
        RETURNING ls.secret_hash
    LOOP
        PERFORM edge_revoke_lane(jsonb_build_object('type', 'session', 'id', encode(s.secret_hash, 'hex'), 'reason', 'factor_reset'));
        n := n + 1;
    END LOOP;
    UPDATE edge_grants g SET revoked_at = now()
     WHERE g.instance_id = p_instance AND g.person_id = p_person AND g.used_at IS NULL AND g.revoked_at IS NULL;
    DELETE FROM login_tickets lt WHERE lt.instance_id = p_instance AND lt.person_id = p_person AND lt.used_at IS NULL;
    RETURN n;
END $$;

CREATE OR REPLACE FUNCTION mfa_grace_sweep(p_instance text, p_limit int)
RETURNS TABLE(connection_id uuid, person_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    pol     record;
    c       record;
    v_since timestamptz;
BEGIN
    IF p_instance IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'mfa_grace_sweep: instance and a limit of 1–500 are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO pol FROM mfa_policy(p_instance);
    IF pol.mode IS DISTINCT FROM 'required' OR pol.grace_until IS NOT NULL THEN
        DELETE FROM maintenance_state m WHERE m.instance_id = p_instance AND m.key = 'mfa_grace_unknown';
    END IF;
    IF pol.mode IS DISTINCT FROM 'required' THEN
        RETURN;
    END IF;
    IF pol.grace_until IS NULL THEN
        INSERT INTO maintenance_state (instance_id, key, value, updated_at)
        VALUES (p_instance, 'mfa_grace_unknown', jsonb_build_object('since', now()), now())
        ON CONFLICT (instance_id, key) DO NOTHING;
        BEGIN
            SELECT (m.value ->> 'since')::timestamptz INTO v_since
              FROM maintenance_state m WHERE m.instance_id = p_instance AND m.key = 'mfa_grace_unknown';
        EXCEPTION WHEN data_exception THEN
            v_since := NULL;
        END;
        IF v_since IS NULL OR NOT isfinite(v_since) OR v_since > now() THEN
            UPDATE maintenance_state m SET value = jsonb_build_object('since', now()), updated_at = now()
             WHERE m.instance_id = p_instance AND m.key = 'mfa_grace_unknown';
            RETURN;
        END IF;
        IF v_since + interval '1 day' >= now() THEN
            RETURN;
        END IF;
    ELSIF pol.grace_until + interval '1 day' >= now() THEN
        RETURN;
    END IF;
    FOR c IN
        SELECT o.id AS cid, o.person_id AS pid
          FROM oauth_connections o JOIN api_keys k ON k.id = o.id
         WHERE o.instance_id = p_instance AND o.origin = 'edge' AND o.mfa_level = 'none'
           AND k.auth_method = 'oauth' AND k.revoked_at IS NULL
         ORDER BY o.id
         LIMIT p_limit
    LOOP
        IF edge_revoke_connection(c.cid, 'mfa_grace') THEN
            connection_id := c.cid;
            person_id := c.pid;
            RETURN NEXT;
        END IF;
    END LOOP;
END $$;

REVOKE ALL ON FUNCTION mfa_mode_rank(text), mfa_mode_of(jsonb), mfa_mode_floor_without(text, text, bigint), mfa_mode_floor(text), mfa_policy(text), mfa_coverage(text),
                       mfa_mode_transition(text, text, text, text, uuid), mfa_mode_apply(),
                       security_mail(uuid, text, text, text, text), login_ticket_take(bytea, text, uuid),
                       mfa_reset_revoke_sessions(text, uuid), mfa_grace_sweep(text, int) FROM PUBLIC;

REVOKE ALL ON mfa_factors, mfa_recovery_codes, mfa_factor_resets, login_tickets FROM PUBLIC, memory_gateway, memory_worker;
REVOKE ALL ON mfa_mode_changes FROM PUBLIC, memory_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_factors, mfa_recovery_codes TO memory_authcheck;
REVOKE UPDATE ON login_tickets FROM memory_authcheck;
GRANT SELECT, INSERT, DELETE ON login_tickets TO memory_authcheck;
GRANT SELECT, INSERT ON mfa_factor_resets TO memory_authcheck;
GRANT EXECUTE ON FUNCTION mfa_policy(text), security_mail(uuid, text, text, text, text), login_ticket_take(bytea, text, uuid) TO memory_authcheck;
GRANT EXECUTE ON FUNCTION mfa_policy(text) TO memory_gateway, memory_exporter, memory_worker;
GRANT EXECUTE ON FUNCTION mfa_coverage(text) TO memory_gateway;
GRANT EXECUTE ON FUNCTION mfa_reset_revoke_sessions(text, uuid) TO memory_authcheck;
GRANT EXECUTE ON FUNCTION mfa_grace_sweep(text, int) TO memory_authcheck;
GRANT EXECUTE ON FUNCTION mfa_mode_floor(text) TO memory_gateway;
GRANT SELECT ON mfa_mode_changes TO memory_worker;

INSERT INTO audit_spool_types (source, event_type) VALUES
    ('memory_authcheck', 'factor')
ON CONFLICT (source, event_type) DO NOTHING;

-- [S2-3]

-- [4]

-- [E2]

-- [5]
