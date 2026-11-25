
-- [P0]

-- [1a]

CREATE TABLE IF NOT EXISTS admin_sessions (
    id                   uuid PRIMARY KEY,
    instance_id          text NOT NULL,
    token_hash           bytea NOT NULL UNIQUE,
    person_id            uuid,                                -- null — admin@local
    local_login          text,
    role                 text NOT NULL,
    auth_method          text NOT NULL,
    ip                   inet NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    last_seen_at         timestamptz NOT NULL DEFAULT now(),
    expires_at           timestamptz NOT NULL,
    uv_at                timestamptz,
    parent_session_id    uuid,
    breakglass_window_id uuid,
    revoked_at           timestamptz,
    revoked_reason       text,
    CONSTRAINT admin_sessions_who_check CHECK (person_id IS NOT NULL OR local_login IS NOT NULL),
    CONSTRAINT admin_sessions_expires_check CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS admin_sessions_person_live_idx ON admin_sessions (person_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS admin_sessions_parent_idx ON admin_sessions (parent_session_id) WHERE parent_session_id IS NOT NULL;
SELECT memory_check_extend('admin_sessions', 'admin_sessions_role_check', 'role', ARRAY['memory_admin', 'security_auditor']);
SELECT memory_check_finish('admin_sessions', 'admin_sessions_role_check');
SELECT memory_check_extend('admin_sessions', 'admin_sessions_auth_method_check', 'auth_method',
                           ARRAY['sso', 'sso_webauthn', 'sso_breakglass', 'local', 'local_breakglass', 'tool']);
SELECT memory_check_finish('admin_sessions', 'admin_sessions_auth_method_check');
SELECT memory_check_extend('admin_sessions', 'admin_sessions_revoked_reason_check', 'revoked_reason',
                           ARRAY['logout', 'logout_all', 'admin_disabled', 'expired_idle', 'ip_changed', 'role_lost', 'breakglass_closed',
                                 'incident', 'parent_revoked', 'anchors']);
SELECT memory_check_finish('admin_sessions', 'admin_sessions_revoked_reason_check');

CREATE TABLE IF NOT EXISTS admin_webauthn_credentials (
    id                 uuid PRIMARY KEY,
    instance_id        text NOT NULL,
    person_id          uuid NOT NULL,
    credential_id      bytea NOT NULL,
    public_key         bytea NOT NULL,                        -- SPKI DER
    alg                integer NOT NULL,
    sign_count         bigint NOT NULL DEFAULT 0,
    user_handle        bytea NOT NULL,
    transports         text[] NOT NULL DEFAULT '{}',
    aaguid             bytea,
    backup_eligible    boolean,
    label              text CONSTRAINT admin_webauthn_label_check CHECK (char_length(label) <= 60),
    created_at         timestamptz NOT NULL DEFAULT now(),
    created_session_id uuid,
    last_used_at       timestamptz,
    disabled_at        timestamptz,
    disabled_by        uuid,
    disabled_reason    text,
    CONSTRAINT admin_webauthn_credential_uniq UNIQUE (instance_id, credential_id)
);
CREATE INDEX IF NOT EXISTS admin_webauthn_person_idx ON admin_webauthn_credentials (person_id) WHERE disabled_at IS NULL;
SELECT memory_check_extend('admin_webauthn_credentials', 'admin_webauthn_credentials_alg_check', 'alg', ARRAY['-7', '-8', '-257']);
SELECT memory_check_finish('admin_webauthn_credentials', 'admin_webauthn_credentials_alg_check');
SELECT memory_check_extend('admin_webauthn_credentials', 'admin_webauthn_credentials_disabled_reason_check', 'disabled_reason',
                           ARRAY['owner', 'admin', 'clone', 'breakglass', 'person_inactive']);
SELECT memory_check_finish('admin_webauthn_credentials', 'admin_webauthn_credentials_disabled_reason_check');

CREATE TABLE IF NOT EXISTS admin_approvals (
    id                 uuid PRIMARY KEY,
    instance_id        text NOT NULL,
    action             text NOT NULL,
    summary            text NOT NULL CONSTRAINT admin_approvals_summary_check CHECK (char_length(summary) <= 300),
    method             text NOT NULL,
    path               text NOT NULL,
    payload_hash       bytea NOT NULL,
    body_enc           bytea,
    key_version        smallint NOT NULL DEFAULT 1,
    requested_by       uuid,
    requested_local    text,
    requested_session  uuid NOT NULL,
    requested_at       timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,
    decided_by         uuid,
    decided_role       text,
    decided_at         timestamptz,
    decision           text,
    executed_at        timestamptz,
    executed_status    integer,
    cancelled_at       timestamptz,
    subject_hash       bytea,
    consumed_at        timestamptz,
    CONSTRAINT admin_approvals_other_signer_check CHECK (decided_by IS NULL OR requested_by IS NULL OR decided_by <> requested_by),
    CONSTRAINT admin_approvals_executed_check CHECK (executed_at IS NULL OR decision = 'approved'),
    CONSTRAINT admin_approvals_decided_by_check CHECK (decision IS NULL OR decided_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS admin_approvals_pending_idx ON admin_approvals (instance_id, requested_at)
    WHERE decision IS NULL AND cancelled_at IS NULL;
SELECT memory_check_extend('admin_approvals', 'admin_approvals_decided_role_check', 'decided_role', ARRAY['memory_admin', 'security_auditor']);
SELECT memory_check_finish('admin_approvals', 'admin_approvals_decided_role_check');
SELECT memory_check_extend('admin_approvals', 'admin_approvals_decision_check', 'decision', ARRAY['approved', 'rejected']);
SELECT memory_check_finish('admin_approvals', 'admin_approvals_decision_check');
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'admin_approvals'::regclass AND conname = 'admin_approvals_requested_by_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%cancelled_at%') THEN
        ALTER TABLE admin_approvals DROP CONSTRAINT admin_approvals_requested_by_check;
    END IF;
    UPDATE admin_approvals SET cancelled_at = now(), body_enc = NULL
     WHERE requested_by IS NULL AND cancelled_at IS NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'admin_approvals'::regclass AND conname = 'admin_approvals_requested_by_check') THEN
        ALTER TABLE admin_approvals ADD CONSTRAINT admin_approvals_requested_by_check
            CHECK (requested_by IS NOT NULL OR cancelled_at IS NOT NULL);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION approval_consume(p_id uuid, p_action text, p_subject_hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n    integer;
    d    text;
    inst text;
BEGIN
    SELECT a.decision, a.instance_id INTO d, inst FROM admin_approvals a WHERE a.id = p_id FOR UPDATE;
    IF d = 'basic_auto' THEN
        IF p_action IS DISTINCT FROM 'mfa.factor_reset' THEN RETURN false; END IF;
        IF to_regprocedure('security_mode(text)') IS NULL THEN RETURN false; END IF;
        IF security_mode(inst) IS DISTINCT FROM 'basic' THEN RETURN false; END IF;
    END IF;
    UPDATE admin_approvals
       SET consumed_at = now()
     WHERE id = p_id AND action = p_action AND subject_hash = p_subject_hash
       AND decision = d AND decision IN ('approved', 'basic_auto') AND cancelled_at IS NULL
       AND executed_at IS NOT NULL AND executed_at <= now() AND executed_at > now() - interval '60 seconds'
       AND consumed_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION approval_consume(uuid, text, bytea) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS anchors_applied (
    instance_id  text NOT NULL,
    kind         text NOT NULL,
    serial       bigint NOT NULL,
    sha256       bytea NOT NULL,
    signers      text[] NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    applied_via  text NOT NULL,
    mfa_mode_min text,
    PRIMARY KEY (instance_id, kind, serial)
);
SELECT memory_check_extend('anchors_applied', 'anchors_applied_kind_check', 'kind', ARRAY['edge', 'inner']);
SELECT memory_check_finish('anchors_applied', 'anchors_applied_kind_check');
SELECT memory_check_extend('anchors_applied', 'anchors_applied_applied_via_check', 'applied_via', ARRAY['start', 'sighup', 'cli']);
SELECT memory_check_finish('anchors_applied', 'anchors_applied_applied_via_check');
SELECT memory_check_extend('anchors_applied', 'anchors_applied_mfa_mode_min_check', 'mfa_mode_min', ARRAY['off', 'optional', 'required']);
SELECT memory_check_finish('anchors_applied', 'anchors_applied_mfa_mode_min_check');
ALTER TABLE anchors_applied ADD COLUMN IF NOT EXISTS security_mode_min text;
ALTER TABLE anchors_applied ADD COLUMN IF NOT EXISTS retire_target text;
SELECT memory_check_extend('anchors_applied', 'anchors_applied_security_mode_min_check', 'security_mode_min', ARRAY['basic', 'advanced']);
SELECT memory_check_finish('anchors_applied', 'anchors_applied_security_mode_min_check');
SELECT memory_check_extend('anchors_applied', 'anchors_applied_retire_target_check', 'retire_target', ARRAY['basic']);
SELECT memory_check_finish('anchors_applied', 'anchors_applied_retire_target_check');
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'anchors_applied'::regclass AND conname = 'anchors_applied_retire_floor_check') THEN
        ALTER TABLE anchors_applied ADD CONSTRAINT anchors_applied_retire_floor_check
            CHECK (retire_target IS NULL OR security_mode_min IS DISTINCT FROM 'advanced');
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS anchors_inner_confirmations (
    instance_id       text NOT NULL,
    serial            bigint NOT NULL,
    sha256            bytea NOT NULL,
    security_mode_min text,
    retire_target     text,
    row_applied_at    timestamptz NOT NULL,
    confirmed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, serial)
);

CREATE TABLE IF NOT EXISTS breakglass_windows (
    id          uuid PRIMARY KEY,
    instance_id text NOT NULL,
    opened_at   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    reason_code text NOT NULL,
    ssh_from    inet,
    closed_at   timestamptz,
    closed_via  text,
    CONSTRAINT breakglass_windows_expires_check CHECK (expires_at > opened_at)
);
SELECT memory_check_extend('breakglass_windows', 'breakglass_windows_reason_code_check', 'reason_code',
                           ARRAY['keys_lost', 'sso_down', 'directory_down', 'incident', 'drill']);
SELECT memory_check_finish('breakglass_windows', 'breakglass_windows_reason_code_check');
SELECT memory_check_extend('breakglass_windows', 'breakglass_windows_closed_via_check', 'closed_via', ARRAY['expired', 'cli', 'admin']);
SELECT memory_check_finish('breakglass_windows', 'breakglass_windows_closed_via_check');
CREATE TABLE IF NOT EXISTS breakglass_attempts (
    id          uuid PRIMARY KEY,
    instance_id text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    ok          boolean NOT NULL,
    ssh_from    inet
);

CREATE TABLE IF NOT EXISTS admin_alerts (
    id          uuid PRIMARY KEY,
    instance_id text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now(),
    level       text NOT NULL,
    code        text NOT NULL,
    summary     text NOT NULL CONSTRAINT admin_alerts_summary_check CHECK (char_length(summary) <= 300),
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key  text,
    mailed_at   timestamptz,
    digest_at   timestamptz,
    acked_by    uuid,
    acked_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_alerts_dedupe_idx ON admin_alerts (instance_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS admin_alerts_at_idx ON admin_alerts (instance_id, at);
SELECT memory_check_extend('admin_alerts', 'admin_alerts_level_check', 'level', ARRAY['high', 'medium']);
SELECT memory_check_finish('admin_alerts', 'admin_alerts_level_check');

CREATE TABLE IF NOT EXISTS obo_read_consents (
    id              uuid PRIMARY KEY,
    instance_id     text NOT NULL,
    person_id       uuid NOT NULL,
    service_id      uuid NOT NULL,
    granted_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    granted_session uuid NOT NULL,
    revoked_at      timestamptz,
    revoked_by      text,
    CONSTRAINT obo_read_consents_expires_check CHECK (expires_at > granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS obo_read_consents_live_idx ON obo_read_consents (instance_id, person_id, service_id) WHERE revoked_at IS NULL;
SELECT memory_check_extend('obo_read_consents', 'obo_read_consents_revoked_by_check', 'revoked_by',
                           ARRAY['person', 'admin', 'service_off', 'person_inactive', 'expired']);
SELECT memory_check_finish('obo_read_consents', 'obo_read_consents_revoked_by_check');

CREATE TABLE IF NOT EXISTS audit_ship_state (
    instance_id     text NOT NULL,
    sink            text NOT NULL,
    cursor_at       timestamptz,
    cursor_id       uuid,
    seq             bigint NOT NULL DEFAULT 0,
    chain_hash      bytea,
    last_ok_at      timestamptz,
    last_error_code text,
    last_error_at   timestamptz,
    reconciled_day  date,
    PRIMARY KEY (instance_id, sink)
);
SELECT memory_check_extend('audit_ship_state', 'audit_ship_state_sink_check', 'sink', ARRAY['file', 'syslog_tls']);
SELECT memory_check_finish('audit_ship_state', 'audit_ship_state_sink_check');
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS start_at timestamptz;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS start_id uuid;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_requested_at timestamptz;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_per_hour integer
    CONSTRAINT audit_ship_state_history_rate_check CHECK (history_per_hour BETWEEN 100 AND 100000);
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_cursor_at timestamptz;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_cursor_id uuid;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_hour_at timestamptz;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_hour_sent integer NOT NULL DEFAULT 0;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_sent bigint NOT NULL DEFAULT 0;
ALTER TABLE audit_ship_state ADD COLUMN IF NOT EXISTS history_done_at timestamptz;

CREATE TABLE IF NOT EXISTS audit_ship_sent (
    instance_id text NOT NULL,
    sink        text NOT NULL,
    day         date NOT NULL,
    id          uuid NOT NULL,                                -- audit_events.id
    seq         bigint NOT NULL,
    PRIMARY KEY (instance_id, sink, day, id),
    CONSTRAINT audit_ship_sent_state_fk FOREIGN KEY (instance_id, sink) REFERENCES audit_ship_state (instance_id, sink) ON DELETE CASCADE
);

SELECT memory_check_extend('mail_outbox', 'mail_outbox_kind_check', 'kind', ARRAY['alert', 'identity_change']);
SELECT memory_check_finish('mail_outbox', 'mail_outbox_kind_check');

CREATE OR REPLACE VIEW v_admin_webauthn_status AS
    SELECT instance_id, person_id, count(*) FILTER (WHERE disabled_at IS NULL)::int AS active_keys
      FROM admin_webauthn_credentials GROUP BY instance_id, person_id;

CREATE OR REPLACE FUNCTION admin_plane_set_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    col  text;
    o    jsonb := to_jsonb(OLD);
    n    jsonb := to_jsonb(NEW);
BEGIN
    FOREACH col IN ARRAY TG_ARGV LOOP
        IF o -> col IS DISTINCT FROM 'null'::jsonb AND o -> col IS DISTINCT FROM n -> col THEN
            RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_set_once',
                MESSAGE = format('%s.%s: the value is set once and never changes', TG_TABLE_NAME, col);
        END IF;
    END LOOP;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION admin_plane_set_once() FROM PUBLIC;
DROP TRIGGER IF EXISTS admin_sessions_set_once ON admin_sessions;
CREATE TRIGGER admin_sessions_set_once BEFORE UPDATE ON admin_sessions FOR EACH ROW
    EXECUTE FUNCTION admin_plane_set_once('token_hash', 'person_id', 'local_login', 'role', 'auth_method', 'ip', 'created_at', 'expires_at',
                                          'parent_session_id', 'breakglass_window_id', 'revoked_at', 'revoked_reason');
DROP TRIGGER IF EXISTS admin_webauthn_credentials_set_once ON admin_webauthn_credentials;
CREATE TRIGGER admin_webauthn_credentials_set_once BEFORE UPDATE ON admin_webauthn_credentials FOR EACH ROW
    EXECUTE FUNCTION admin_plane_set_once('person_id', 'credential_id', 'public_key', 'alg', 'user_handle', 'disabled_at', 'disabled_by',
                                          'disabled_reason');
DROP TRIGGER IF EXISTS admin_approvals_set_once ON admin_approvals;
CREATE TRIGGER admin_approvals_set_once BEFORE UPDATE ON admin_approvals FOR EACH ROW
    EXECUTE FUNCTION admin_plane_set_once('action', 'method', 'path', 'payload_hash', 'requested_by', 'requested_local', 'requested_session',
                                          'requested_at', 'expires_at', 'decided_by', 'decided_role', 'decided_at', 'decision', 'executed_at',
                                          'executed_status', 'cancelled_at', 'subject_hash', 'consumed_at');
DROP TRIGGER IF EXISTS breakglass_windows_set_once ON breakglass_windows;
CREATE TRIGGER breakglass_windows_set_once BEFORE UPDATE ON breakglass_windows FOR EACH ROW
    EXECUTE FUNCTION admin_plane_set_once('opened_at', 'expires_at', 'reason_code', 'ssh_from', 'closed_at', 'closed_via');
DROP TRIGGER IF EXISTS obo_read_consents_set_once ON obo_read_consents;
CREATE TRIGGER obo_read_consents_set_once BEFORE UPDATE ON obo_read_consents FOR EACH ROW
    EXECUTE FUNCTION admin_plane_set_once('person_id', 'service_id', 'granted_at', 'expires_at', 'granted_session', 'revoked_at', 'revoked_by');

REVOKE UPDATE ON obo_read_consents FROM memory_gateway;
REVOKE UPDATE ON admin_alerts FROM memory_admin_plane, memory_worker;
REVOKE UPDATE ON admin_sessions, admin_approvals, obo_read_consents, admin_webauthn_credentials FROM memory_worker;
REVOKE ALL ON breakglass_windows FROM memory_worker;
GRANT INSERT ON admin_alerts TO memory_gateway;
GRANT SELECT, INSERT ON anchors_applied TO memory_gateway;
GRANT SELECT, INSERT ON obo_read_consents TO memory_gateway;
GRANT UPDATE (revoked_at, revoked_by) ON obo_read_consents TO memory_gateway;
GRANT SELECT ON audit_ship_state, v_admin_webauthn_status TO memory_gateway;
GRANT SELECT, INSERT, UPDATE ON admin_sessions, admin_approvals, breakglass_windows, breakglass_attempts,
                                admin_webauthn_credentials TO memory_admin_plane;
GRANT SELECT ON admin_alerts TO memory_admin_plane;
GRANT UPDATE (acked_by, acked_at) ON admin_alerts TO memory_admin_plane;
GRANT SELECT ON v_admin_webauthn_status TO memory_admin_plane;
GRANT SELECT ON audit_ship_state TO memory_admin_plane;
GRANT UPDATE (history_requested_at, history_per_hour) ON audit_ship_state TO memory_admin_plane;
REVOKE INSERT ON anchors_applied FROM memory_worker;
GRANT SELECT ON anchors_applied TO memory_worker;
REVOKE ALL ON anchors_inner_confirmations FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON anchors_inner_confirmations FROM memory_gateway, memory_worker, memory_admin_plane;
GRANT SELECT ON anchors_inner_confirmations TO memory_gateway, memory_worker, memory_admin_plane;
GRANT SELECT, INSERT, DELETE ON admin_alerts TO memory_worker;
GRANT UPDATE (mailed_at, digest_at) ON admin_alerts TO memory_worker;
GRANT SELECT, INSERT, UPDATE ON audit_ship_state TO memory_worker;
GRANT SELECT, INSERT, DELETE ON audit_ship_sent TO memory_worker;
GRANT SELECT, DELETE ON admin_sessions, admin_approvals, obo_read_consents, breakglass_attempts, admin_webauthn_credentials TO memory_worker;
GRANT UPDATE (body_enc) ON admin_approvals TO memory_worker;
GRANT UPDATE (revoked_at, revoked_by) ON obo_read_consents TO memory_worker;
GRANT UPDATE (disabled_at, disabled_by, disabled_reason) ON admin_webauthn_credentials TO memory_worker;
GRANT SELECT ON v_admin_webauthn_status TO memory_worker;

SELECT memory_check_extend('settings', 'settings_category_check', 'category', ARRAY['security']);
SELECT memory_check_finish('settings', 'settings_category_check');
SELECT memory_check_extend('admin_sessions', 'admin_sessions_revoked_reason_check', 'revoked_reason', ARRAY['security_mode']);
SELECT memory_check_finish('admin_sessions', 'admin_sessions_revoked_reason_check');

CREATE TABLE IF NOT EXISTS security_mode_changes (
    id                  uuid PRIMARY KEY,
    seq                 bigint GENERATED ALWAYS AS IDENTITY,
    instance_id         text NOT NULL,
    at                  timestamptz NOT NULL DEFAULT now(),
    from_mode           text NOT NULL,
    to_mode             text NOT NULL,
    by_person           uuid,
    by_session          uuid,
    reason              text CONSTRAINT security_mode_changes_reason_check CHECK (char_length(reason) <= 500),
    flags_before        jsonb NOT NULL DEFAULT '{}'::jsonb,
    flags_after         jsonb NOT NULL DEFAULT '{}'::jsonb,
    keys_revoked        integer NOT NULL DEFAULT 0,
    sessions_revoked    integer NOT NULL DEFAULT 0,
    approvals_cancelled integer NOT NULL DEFAULT 0,
    pending_id          uuid
);
CREATE INDEX IF NOT EXISTS security_mode_changes_last_idx ON security_mode_changes (instance_id, seq DESC);
SELECT memory_check_extend('security_mode_changes', 'security_mode_changes_from_mode_check', 'from_mode', ARRAY['basic', 'advanced']);
SELECT memory_check_finish('security_mode_changes', 'security_mode_changes_from_mode_check');
SELECT memory_check_extend('security_mode_changes', 'security_mode_changes_to_mode_check', 'to_mode', ARRAY['basic', 'advanced']);
SELECT memory_check_finish('security_mode_changes', 'security_mode_changes_to_mode_check');

CREATE TABLE IF NOT EXISTS security_mode_pending (
    id                uuid PRIMARY KEY,
    instance_id       text NOT NULL,
    to_mode           text NOT NULL DEFAULT 'basic' CONSTRAINT security_mode_pending_to_check CHECK (to_mode = 'basic'),
    requested_by      uuid NOT NULL,
    requested_session uuid,
    requested_at      timestamptz NOT NULL DEFAULT now(),
    reason            text NOT NULL CONSTRAINT security_mode_pending_reason_check CHECK (char_length(reason) BETWEEN 20 AND 500),
    not_before        timestamptz NOT NULL,
    approved_by       uuid,
    approved_session  uuid,
    approved_at       timestamptz,
    cancelled_at      timestamptz,
    cancelled_by      uuid,
    cancelled_via     text,
    executed_at       timestamptz,
    approved_anchors_serial bigint,
    CONSTRAINT security_mode_pending_other_signer_check CHECK (approved_by IS NULL OR approved_by <> requested_by),
    CONSTRAINT security_mode_pending_cancel_check CHECK ((cancelled_at IS NULL) = (cancelled_via IS NULL)),
    CONSTRAINT security_mode_pending_executed_check CHECK (executed_at IS NULL OR ((approved_by IS NOT NULL OR approved_anchors_serial IS NOT NULL) AND cancelled_at IS NULL)),
    CONSTRAINT security_mode_pending_signature_check CHECK (approved_by IS NULL OR approved_anchors_serial IS NULL)
);
ALTER TABLE security_mode_pending ADD COLUMN IF NOT EXISTS approved_anchors_serial bigint;
ALTER TABLE security_mode_pending DROP CONSTRAINT IF EXISTS security_mode_pending_executed_check;
ALTER TABLE security_mode_pending ADD CONSTRAINT security_mode_pending_executed_check
    CHECK (executed_at IS NULL OR ((approved_by IS NOT NULL OR approved_anchors_serial IS NOT NULL) AND cancelled_at IS NULL));
ALTER TABLE security_mode_pending DROP CONSTRAINT IF EXISTS security_mode_pending_signature_check;
ALTER TABLE security_mode_pending ADD CONSTRAINT security_mode_pending_signature_check CHECK (approved_by IS NULL OR approved_anchors_serial IS NULL);
CREATE UNIQUE INDEX IF NOT EXISTS security_mode_pending_retire_once_idx ON security_mode_pending (instance_id, approved_anchors_serial)
    WHERE approved_anchors_serial IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS security_mode_pending_open_idx ON security_mode_pending (instance_id)
    WHERE cancelled_at IS NULL AND executed_at IS NULL;
SELECT memory_check_extend('security_mode_pending', 'security_mode_pending_cancelled_via_check', 'cancelled_via', ARRAY['admin', 'cli', 'mode_changed']);
SELECT memory_check_finish('security_mode_pending', 'security_mode_pending_cancelled_via_check');
DROP TRIGGER IF EXISTS security_mode_pending_set_once ON security_mode_pending;
CREATE TRIGGER security_mode_pending_set_once BEFORE UPDATE ON security_mode_pending FOR EACH ROW
    EXECUTE FUNCTION admin_plane_set_once('to_mode', 'requested_by', 'requested_session', 'requested_at', 'reason', 'not_before', 'approved_by',
                                          'approved_session', 'approved_at', 'cancelled_at', 'cancelled_by', 'cancelled_via', 'executed_at',
                                          'approved_anchors_serial');

CREATE TABLE IF NOT EXISTS security_attestations (
    id               uuid PRIMARY KEY,
    instance_id      text NOT NULL,
    kind             text NOT NULL,
    subject          text NOT NULL CONSTRAINT security_attestations_subject_check CHECK (char_length(subject) BETWEEN 1 AND 300),
    value_sha256     bytea CONSTRAINT security_attestations_value_check CHECK (value_sha256 IS NULL OR octet_length(value_sha256) = 32),
    note             text CONSTRAINT security_attestations_note_check CHECK (char_length(note) <= 300),
    attested_by      uuid NOT NULL,
    attested_session uuid,
    attested_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_attestations_subject_idx ON security_attestations (instance_id, kind, subject, attested_at DESC);
SELECT memory_check_extend('security_attestations', 'security_attestations_kind_check', 'kind',
                           ARRAY['profile_weakening', 'device_binding', 'it_instructions', 'gitlab_protected', 'human_signer',
                                 'docker_user_filter', 'machine_keys_destroyed', 'host_hardened',
                                 'bridge_vm', 'edge_proxy_dedicated', 'release_signers_human', 'e5_hostile_bridge']);
SELECT memory_check_finish('security_attestations', 'security_attestations_kind_check');

CREATE OR REPLACE FUNCTION security_mode_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = format('%s: append-only — rows are not changed or deleted', TG_TABLE_NAME);
END $$;
REVOKE ALL ON FUNCTION security_mode_append_only() FROM PUBLIC;
DROP TRIGGER IF EXISTS security_mode_changes_append_only ON security_mode_changes;
CREATE TRIGGER security_mode_changes_append_only BEFORE UPDATE OR DELETE ON security_mode_changes FOR EACH ROW EXECUTE FUNCTION security_mode_append_only();
DROP TRIGGER IF EXISTS security_attestations_append_only ON security_attestations;
CREATE TRIGGER security_attestations_append_only BEFORE UPDATE OR DELETE ON security_attestations FOR EACH ROW EXECUTE FUNCTION security_mode_append_only();

CREATE OR REPLACE FUNCTION security_mode_instance(p_instance text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    inst text := p_instance;
BEGIN
    IF inst IS NULL THEN
        IF (SELECT count(*) FROM instances) <> 1 THEN
            RAISE EXCEPTION 'security_mode: there is not exactly one instance — pass the instance' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        SELECT id INTO inst FROM instances;
    END IF;
    RETURN inst;
END $$;
REVOKE ALL ON FUNCTION security_mode_instance(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode_setting(p_instance text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    inst text := security_mode_instance(p_instance);
    v    jsonb;
    hit  boolean := false;
    m    text;
BEGIN
    SELECT COALESCE(s.value, s.default_value), true INTO v, hit FROM settings s
     WHERE s.instance_id = inst AND s.category = 'security' AND s.key = 'mode';
    IF hit THEN
        RETURN CASE WHEN v = '"advanced"'::jsonb THEN 'advanced' ELSE 'basic' END;
    END IF;
    SELECT c.to_mode INTO m FROM security_mode_changes c WHERE c.instance_id = inst ORDER BY c.seq DESC LIMIT 1;
    RETURN COALESCE(m, 'basic');
END $$;
REVOKE ALL ON FUNCTION security_mode_setting(text) FROM PUBLIC;

-- Advanced is closed in this release until the role split is ported. Both the
-- floor advanced of the inner anchors and the switch to advanced promise that the workers confirm a row of the inner anchors
-- independently of the gateway, and that holds only when every service has its own database password; nothing checks
-- the split yet (the gateway and the workers may derive their passwords from one shared secret). So the database refuses both
-- by itself, whichever role writes: a new row of anchors_applied whose floor is above basic (the trigger
-- anchors_applied_advanced_closed, below) and security_mode_set(…, 'advanced', …). Rows written before stay and keep acting:
-- security_mode_floor() is not changed, an effective floor is never lowered. This function is the one source of the refusal in
-- the database (its twin in the processes is rolesSplitRefusal(), packages/shared/src/security-mode.ts): the refusal text, or
-- NULL when advanced may be switched on. replaces both by the real check of the split and removes the temporary
-- refusals: this function, the trigger anchors_applied_advanced_closed, the check in security_mode_set and the check of the
-- button (POST /api/v1/admin/security-mode).
CREATE OR REPLACE FUNCTION roles_split_refusal() RETURNS text
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
    RETURN 'roles_not_split: advanced is closed in this release until the role split is ported — the database cannot '
        || 'check yet that every service has its own database password, so the workers could not confirm the anchors row '
        || 'independently of the gateway';
END $$;
REVOKE ALL ON FUNCTION roles_split_refusal() FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode_floor(p_instance text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    inst text := security_mode_instance(p_instance);
    r    jsonb;
    c    bigint;
    c_at timestamptz;
BEGIN
    IF to_regclass('anchors_inner_confirmations') IS NULL THEN
        SELECT to_jsonb(a) INTO r FROM anchors_applied a WHERE a.instance_id = inst AND a.kind = 'inner' ORDER BY a.serial DESC LIMIT 1;
        IF r IS NULL OR r->>'retire_target' IS NOT NULL OR r->>'security_mode_min' IS NULL OR r->>'security_mode_min' = 'basic' THEN
            RETURN 'basic';
        END IF;
        RETURN 'advanced';
    END IF;
    SELECT k.serial, k.confirmed_at INTO c, c_at FROM anchors_inner_confirmations k
      JOIN anchors_applied a ON a.instance_id = k.instance_id AND a.kind = 'inner' AND a.serial = k.serial AND a.sha256 = k.sha256
                            AND a.applied_at = k.row_applied_at
     WHERE k.instance_id = inst ORDER BY k.serial DESC LIMIT 1;
    IF EXISTS (SELECT 1 FROM anchors_applied a
                WHERE a.instance_id = inst AND a.kind = 'inner' AND (c IS NULL OR a.serial >= c OR a.applied_at > c_at)
                  AND to_jsonb(a)->>'retire_target' IS NULL AND COALESCE(to_jsonb(a)->>'security_mode_min', 'basic') <> 'basic') THEN
        RETURN 'advanced';
    END IF;
    RETURN 'basic';
END $$;
REVOKE ALL ON FUNCTION security_mode_floor(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION anchors_inner_confirm(p_instance text, p_serial bigint, p_sha256 text, p_min text, p_retire text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_sha text;
    v_min text;
    v_ret text;
    v_at  timestamptz;
    n     integer;
BEGIN
    IF p_instance IS NULL OR p_serial IS NULL OR p_serial < 1 OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-fA-F]{64}$' THEN
        RAISE EXCEPTION 'anchors_inner_confirm: the instance, a serial of at least 1 and the document sha256 (64 hex characters) are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT encode(a.sha256, 'hex'), a.security_mode_min, a.retire_target, a.applied_at INTO v_sha, v_min, v_ret, v_at FROM anchors_applied a
     WHERE a.instance_id = p_instance AND a.kind = 'inner' AND a.serial = p_serial;
    IF NOT FOUND THEN RETURN 'missing'; END IF;
    IF v_sha IS DISTINCT FROM lower(p_sha256) OR v_ret IS DISTINCT FROM p_retire
       OR (p_retire IS NULL AND COALESCE(v_min, 'basic') IS DISTINCT FROM COALESCE(p_min, 'basic')) THEN
        RETURN 'mismatch';
    END IF;
    INSERT INTO anchors_inner_confirmations AS k (instance_id, serial, sha256, security_mode_min, retire_target, row_applied_at)
    VALUES (p_instance, p_serial, decode(v_sha, 'hex'), v_min, v_ret, v_at)
    ON CONFLICT (instance_id, serial) DO UPDATE
       SET sha256 = EXCLUDED.sha256, security_mode_min = EXCLUDED.security_mode_min, retire_target = EXCLUDED.retire_target,
           row_applied_at = EXCLUDED.row_applied_at, confirmed_at = now()
     WHERE k.sha256 IS DISTINCT FROM EXCLUDED.sha256 OR k.row_applied_at IS DISTINCT FROM EXCLUDED.row_applied_at;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RETURN 'already'; END IF;
    PERFORM pg_notify('security_mode', 'anchors');
    RETURN 'confirmed';
END $$;
REVOKE ALL ON FUNCTION anchors_inner_confirm(text, bigint, text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode(p_instance text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    inst text := security_mode_instance(p_instance);
BEGIN
    IF security_mode_setting(inst) = 'advanced' OR security_mode_floor(inst) = 'advanced' THEN RETURN 'advanced'; END IF;
    RETURN 'basic';
END $$;
REVOKE ALL ON FUNCTION security_mode(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode_is_admin(p_instance text, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p_person IS NOT NULL AND EXISTS (
        SELECT 1 FROM role_grants g
         WHERE g.person_id = p_person AND g.instance_id = p_instance AND g.role_code = 'memory_admin'
           AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()))
$$;
REVOKE ALL ON FUNCTION security_mode_is_admin(text, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode_approval(p_instance text, p_raw text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v uuid;
BEGIN
    IF p_raw IS NULL OR p_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
    UPDATE security_mode_pending p SET executed_at = now()
     WHERE p.id = p_raw::uuid AND p.instance_id = p_instance
       AND p.cancelled_at IS NULL AND p.executed_at IS NULL
       AND ((p.approved_by IS NOT NULL AND p.approved_by <> p.requested_by) OR p.approved_anchors_serial IS NOT NULL)
       AND p.not_before <= now()
    RETURNING p.id INTO v;
    RETURN v;
END $$;
REVOKE ALL ON FUNCTION security_mode_approval(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode_set(p_instance text, p_to text, p_person uuid, p_session uuid, p_reason text,
                                             p_flags_before jsonb, p_flags_after jsonb, p_keys_revoked integer, p_sessions_revoked integer,
                                             p_approvals_cancelled integer) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_from    text;
    v_pending uuid;
    v_id      uuid := gen_random_uuid();
    v_closed  text;
BEGIN
    IF p_to IS NULL OR p_to NOT IN ('basic', 'advanced') THEN
        RAISE EXCEPTION 'security_mode_set: mode — basic or advanced' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_instance IS NULL OR NOT EXISTS (SELECT 1 FROM instances WHERE id = p_instance) THEN
        RAISE EXCEPTION 'security_mode_set: no such instance' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('security_mode'), hashtext(p_instance));
    v_from := security_mode_setting(p_instance);
    IF v_from = p_to THEN
        RAISE EXCEPTION 'security_mode_same: the mode is already %', p_to USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF p_to = 'advanced' THEN
        IF NOT security_mode_is_admin(p_instance, p_person) THEN
            RAISE EXCEPTION 'security_mode_set: advanced is enabled by the memory administrator' USING ERRCODE = 'insufficient_privilege';
        END IF;
        -- Switching to advanced is refused until the role split is ported (roles_split_refusal),
        -- before anything is written; switching away from advanced is not touched
        v_closed := roles_split_refusal();
        IF v_closed IS NOT NULL THEN
            RAISE EXCEPTION '%', v_closed USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        UPDATE security_mode_pending SET cancelled_at = now(), cancelled_via = 'mode_changed'
         WHERE instance_id = p_instance AND cancelled_at IS NULL AND executed_at IS NULL;
    ELSE
        v_pending := security_mode_approval(p_instance, current_setting('memory.approval_id', true));
        IF v_pending IS NULL THEN
            RAISE EXCEPTION 'security_mode_unsigned: returning to basic only by a request signed by another person, after a delay'
                  USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF security_mode_floor(p_instance) = 'advanced' THEN
            RAISE EXCEPTION 'floor_advanced: the floor of the internal anchors is advanced — first a 2-of-3 document with the basic floor or a “retire document”'
                  USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
    END IF;
    UPDATE settings SET value = to_jsonb(p_to), updated_by = p_person, updated_at = now()
     WHERE instance_id = p_instance AND category = 'security' AND key = 'mode';
    IF NOT FOUND THEN
        INSERT INTO settings (instance_id, category, key, value, secret, required, description, default_value, updated_by)
        VALUES (p_instance, 'security', 'mode', to_jsonb(p_to), false, false,
                'Security mode: basic or advanced. Changed only by the “Enable advanced” button and by a return on request', '"basic"'::jsonb, p_person);
    END IF;
    INSERT INTO security_mode_changes (id, instance_id, from_mode, to_mode, by_person, by_session, reason, flags_before, flags_after,
                                       keys_revoked, sessions_revoked, approvals_cancelled, pending_id)
    VALUES (v_id, p_instance, v_from, p_to, p_person, p_session, left(p_reason, 500), COALESCE(p_flags_before, '{}'::jsonb),
            COALESCE(p_flags_after, '{}'::jsonb), COALESCE(p_keys_revoked, 0), COALESCE(p_sessions_revoked, 0), COALESCE(p_approvals_cancelled, 0),
            v_pending);
    PERFORM pg_notify('security_mode', p_to);
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION security_mode_set(text, text, uuid, uuid, text, jsonb, jsonb, integer, integer, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION settings_security_mode_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    touches boolean := (TG_OP <> 'INSERT' AND OLD.category = 'security' AND OLD.key = 'mode')
                    OR (TG_OP <> 'DELETE' AND NEW.category = 'security' AND NEW.key = 'mode');
    owner   text;
BEGIN
    IF touches THEN
        SELECT pg_get_userbyid(p.proowner) INTO owner FROM pg_proc p
         WHERE p.oid = to_regprocedure('security_mode_set(text,text,uuid,uuid,text,jsonb,jsonb,integer,integer,integer)');
        IF NOT (COALESCE(current_user = owner, false) OR COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false)) THEN
            RAISE EXCEPTION 'settings: the security mode is changed only by security_mode_set (POST /api/v1/admin/security-mode); the mode row cannot be deleted'
                  USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION settings_security_mode_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS settings_security_mode ON settings;
CREATE TRIGGER settings_security_mode BEFORE INSERT OR UPDATE OR DELETE ON settings FOR EACH ROW EXECUTE FUNCTION settings_security_mode_guard();

CREATE OR REPLACE FUNCTION security_mode_request_downgrade(p_instance text, p_person uuid, p_session uuid, p_reason text)
RETURNS TABLE (id uuid, not_before timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_raw  jsonb;
    v_h    integer;
    v_id   uuid := gen_random_uuid();
    v_nb   timestamptz;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('security_mode'), hashtext(p_instance));
    IF security_mode_setting(p_instance) <> 'advanced' THEN
        RAISE EXCEPTION 'security_mode_not_advanced: a return is requested only from advanced' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NOT security_mode_is_admin(p_instance, p_person) THEN
        RAISE EXCEPTION 'security_mode_request_downgrade: requested by the memory administrator' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 20 THEN
        RAISE EXCEPTION 'security_mode_reason: the reason is at least 20 characters' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT COALESCE(s.value, s.default_value) INTO v_raw FROM settings s
     WHERE s.instance_id = p_instance AND s.category = 'security' AND s.key = 'downgrade_delay_hours';
    v_h := CASE WHEN jsonb_typeof(v_raw) = 'number' THEN (v_raw #>> '{}')::numeric::integer ELSE 24 END;
    v_h := LEAST(GREATEST(v_h, 24), 168);
    v_nb := now() + make_interval(hours => v_h);
    INSERT INTO security_mode_pending (id, instance_id, requested_by, requested_session, reason, not_before)
    VALUES (v_id, p_instance, p_person, p_session, left(btrim(p_reason), 500), v_nb);
    RETURN QUERY SELECT v_id, v_nb;
END $$;
REVOKE ALL ON FUNCTION security_mode_request_downgrade(text, uuid, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode_approve_downgrade(p_instance text, p_id uuid, p_person uuid, p_session uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    IF NOT security_mode_is_admin(p_instance, p_person) THEN
        RAISE EXCEPTION 'security_mode_approve_downgrade: signed by the memory administrator' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE security_mode_pending p SET approved_by = p_person, approved_session = p_session, approved_at = now()
     WHERE p.id = p_id AND p.instance_id = p_instance AND p.cancelled_at IS NULL AND p.executed_at IS NULL
       AND p.approved_by IS NULL AND p.approved_anchors_serial IS NULL AND p.requested_by <> p_person;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION security_mode_approve_downgrade(text, uuid, uuid, uuid) FROM PUBLIC;

DROP FUNCTION IF EXISTS security_mode_approve_downgrade_retire(text, uuid, uuid, uuid);
CREATE OR REPLACE FUNCTION security_mode_approve_downgrade_retire(p_instance text, p_id uuid, p_person uuid, p_session uuid, p_serial bigint, p_sha256 text)
RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_serial bigint;
    v_sha    text;
    v_target text;
    v_at     timestamptz;
    v_req    timestamptz;
    v_by     uuid;
    n        integer;
BEGIN
    IF NOT security_mode_is_admin(p_instance, p_person) THEN
        RAISE EXCEPTION 'security_mode_approve_downgrade_retire: signed by the memory administrator' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('security_mode'), hashtext(p_instance));
    SELECT p.requested_at, p.requested_by INTO v_req, v_by FROM security_mode_pending p WHERE p.id = p_id AND p.instance_id = p_instance;
    IF EXISTS (SELECT 1 FROM role_grants g JOIN people pp ON pp.id = g.person_id AND pp.active
                WHERE g.instance_id = p_instance AND g.role_code = 'memory_admin' AND g.revoked_at IS NULL AND g.valid_from <= now()
                  AND (g.valid_to IS NULL OR g.valid_to > now()) AND g.person_id IS DISTINCT FROM COALESCE(v_by, p_person)
                  AND EXISTS (SELECT 1 FROM admin_webauthn_credentials w WHERE w.person_id = g.person_id AND w.instance_id = p_instance
                                AND w.disabled_at IS NULL AND w.backup_eligible IS FALSE)) THEN
        RAISE EXCEPTION 'retire_not_needed: there is another memory administrator with a key — they sign' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT a.serial, encode(a.sha256, 'hex'), to_jsonb(a)->>'retire_target', a.applied_at INTO v_serial, v_sha, v_target, v_at FROM anchors_applied a
     WHERE a.instance_id = p_instance AND a.kind = 'inner' ORDER BY a.serial DESC LIMIT 1;
    IF v_serial IS NULL OR v_target IS DISTINCT FROM 'basic' THEN
        RAISE EXCEPTION 'retire_missing: the latest internal anchors are not a retirement document' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF p_serial IS NULL OR p_sha256 IS NULL OR v_serial <> p_serial OR v_sha IS DISTINCT FROM lower(p_sha256) THEN
        RAISE EXCEPTION 'retire_unverified: the last row of the internal anchors (serial %) is not a document verified by the gateway loader', v_serial
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM anchors_inner_confirmations k WHERE k.instance_id = p_instance AND k.serial = v_serial
                      AND encode(k.sha256, 'hex') = v_sha AND k.row_applied_at = v_at AND k.retire_target = 'basic') THEN
        RAISE EXCEPTION 'retire_unconfirmed: retire document serial % has not yet been confirmed by the workers — restart the workers (they re-read the anchors at start) and repeat', v_serial
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF v_req IS NOT NULL AND v_at < v_req THEN
        RAISE EXCEPTION 'retire_stale: retire document serial % was applied before the request', v_serial USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF EXISTS (SELECT 1 FROM security_mode_pending o WHERE o.instance_id = p_instance AND o.approved_anchors_serial = v_serial) THEN
        RAISE EXCEPTION 'retire_used: retirement document number % has already signed a request', v_serial USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    UPDATE security_mode_pending p SET approved_anchors_serial = v_serial, approved_session = p_session, approved_at = now()
     WHERE p.id = p_id AND p.instance_id = p_instance AND p.cancelled_at IS NULL AND p.executed_at IS NULL
       AND p.approved_by IS NULL AND p.approved_anchors_serial IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN CASE WHEN n = 1 THEN v_serial END;
END $$;
REVOKE ALL ON FUNCTION security_mode_approve_downgrade_retire(text, uuid, uuid, uuid, bigint, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_mode_cancel_downgrade(p_instance text, p_id uuid, p_person uuid, p_via text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    IF p_via IS NULL OR p_via NOT IN ('admin', 'cli') THEN
        RAISE EXCEPTION 'security_mode_cancel_downgrade: way — admin or cli' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_via = 'admin' AND NOT security_mode_is_admin(p_instance, p_person) THEN
        RAISE EXCEPTION 'security_mode_cancel_downgrade: cancelled by the memory administrator' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE security_mode_pending p SET cancelled_at = now(), cancelled_by = p_person, cancelled_via = p_via
     WHERE p.instance_id = p_instance AND (p_id IS NULL OR p.id = p_id) AND p.cancelled_at IS NULL AND p.executed_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION security_mode_cancel_downgrade(text, uuid, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION security_attest(p_instance text, p_kind text, p_subject text, p_value_sha256 bytea, p_person uuid, p_session uuid,
                                           p_note text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_id uuid := gen_random_uuid();
BEGIN
    IF NOT security_mode_is_admin(p_instance, p_person) THEN
        RAISE EXCEPTION 'security_attest: confirmed by the memory administrator' USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO security_attestations (id, instance_id, kind, subject, value_sha256, note, attested_by, attested_session)
    VALUES (v_id, p_instance, p_kind, p_subject, p_value_sha256, left(p_note, 300), p_person, p_session);
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION security_attest(text, text, text, bytea, uuid, uuid, text) FROM PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON security_mode_changes, security_mode_pending, security_attestations
    FROM memory_gateway, memory_worker, memory_admin_plane;
GRANT SELECT ON security_mode_changes, security_mode_pending, security_attestations TO memory_gateway, memory_worker, memory_admin_plane;
GRANT EXECUTE ON FUNCTION security_mode(text) TO memory_admin_plane, memory_gateway, memory_worker, memory_authcheck;
GRANT EXECUTE ON FUNCTION security_mode_setting(text), security_mode_floor(text) TO memory_admin_plane, memory_gateway, memory_worker, memory_authcheck;
GRANT EXECUTE ON FUNCTION security_mode_approve_downgrade_retire(text, uuid, uuid, uuid, bigint, text) TO memory_admin_plane;
GRANT EXECUTE ON FUNCTION anchors_inner_confirm(text, bigint, text, text, text) TO memory_worker;
GRANT EXECUTE ON FUNCTION security_mode_set(text, text, uuid, uuid, text, jsonb, jsonb, integer, integer, integer) TO memory_admin_plane;
GRANT EXECUTE ON FUNCTION security_mode_request_downgrade(text, uuid, uuid, text) TO memory_admin_plane;
GRANT EXECUTE ON FUNCTION security_mode_approve_downgrade(text, uuid, uuid, uuid) TO memory_admin_plane;
GRANT EXECUTE ON FUNCTION security_mode_cancel_downgrade(text, uuid, uuid, text) TO memory_admin_plane;
GRANT EXECUTE ON FUNCTION security_attest(text, text, text, bytea, uuid, uuid, text) TO memory_admin_plane;

CREATE OR REPLACE FUNCTION anchors_applied_security_floor_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM pg_notify('security_mode', 'anchors');
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION anchors_applied_security_floor_notify() FROM PUBLIC;
CREATE OR REPLACE TRIGGER anchors_applied_security_floor AFTER INSERT ON anchors_applied FOR EACH ROW
    WHEN (NEW.kind = 'inner') EXECUTE FUNCTION anchors_applied_security_floor_notify();
-- A new floor advanced is refused by the database itself, for every role — the gateway and the admin plane
-- hold INSERT on anchors_applied and could write such a row past the loader, which refuses it (checkAnchors). Refused: a row
-- whose security_mode_min would raise the floor (anything but NULL and basic — the rule of security_mode_floor), on INSERT and
-- on an UPDATE that changes security_mode_min; errcode object_not_in_prerequisite_state, the text of roles_split_refusal().
-- Rows written before stay and keep acting (an effective floor is never lowered). The column is read through to_jsonb: the
-- its rollback drops it. removes this trigger with roles_split_refusal().
CREATE OR REPLACE FUNCTION anchors_applied_advanced_closed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v   text := to_jsonb(NEW)->>'security_mode_min';
    why text;
BEGIN
    IF COALESCE(v, 'basic') <> 'basic' AND (TG_OP = 'INSERT' OR v IS DISTINCT FROM to_jsonb(OLD)->>'security_mode_min') THEN
        why := roles_split_refusal();
        IF why IS NOT NULL THEN
            RAISE EXCEPTION 'anchors_applied: security_mode_min % is refused — %', v, why USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION anchors_applied_advanced_closed() FROM PUBLIC;
DROP TRIGGER IF EXISTS anchors_applied_advanced_closed ON anchors_applied;
CREATE TRIGGER anchors_applied_advanced_closed BEFORE INSERT OR UPDATE ON anchors_applied FOR EACH ROW
    EXECUTE FUNCTION anchors_applied_advanced_closed();

CREATE TABLE IF NOT EXISTS edge_prepared (
    instance_id text PRIMARY KEY,
    marked_at   timestamptz NOT NULL DEFAULT now(),
    marked_via  text NOT NULL
);
SELECT memory_check_extend('edge_prepared', 'edge_prepared_marked_via_check', 'marked_via', ARRAY['host_facts', 'gateway_start']);
SELECT memory_check_finish('edge_prepared', 'edge_prepared_marked_via_check');
DROP TRIGGER IF EXISTS edge_prepared_append_only ON edge_prepared;
CREATE TRIGGER edge_prepared_append_only BEFORE UPDATE OR DELETE ON edge_prepared FOR EACH ROW EXECUTE FUNCTION security_mode_append_only();

CREATE OR REPLACE FUNCTION edge_prepared_mark(p_instance text, p_via text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    IF p_instance IS NULL OR NOT EXISTS (SELECT 1 FROM instances WHERE id = p_instance) THEN
        RAISE EXCEPTION 'edge_prepared_mark: no such instance' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('external-contour:' || p_instance, 0));
    INSERT INTO edge_prepared (instance_id, marked_via) VALUES (p_instance, p_via) ON CONFLICT (instance_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION edge_prepared_mark(text, text) FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON edge_prepared FROM memory_gateway, memory_worker, memory_admin_plane;
GRANT SELECT ON edge_prepared TO memory_gateway, memory_worker, memory_admin_plane;
GRANT EXECUTE ON FUNCTION edge_prepared_mark(text, text) TO memory_gateway;

ALTER TABLE mail_outbox ADD COLUMN IF NOT EXISTS transport_fp text;
ALTER TABLE mail_outbox DROP CONSTRAINT IF EXISTS mail_outbox_transport_fp_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_transport_fp_check CHECK (transport_fp IS NULL OR transport_fp ~ '^[0-9a-f]{64}$');

-- [1b]

-- [1c]

-- [1d]
ALTER TABLE admin_alerts ADD COLUMN IF NOT EXISTS subject text CONSTRAINT admin_alerts_subject_check CHECK (char_length(subject) BETWEEN 1 AND 128);
ALTER TABLE admin_alerts ADD COLUMN IF NOT EXISTS count integer NOT NULL DEFAULT 1 CONSTRAINT admin_alerts_count_check CHECK (count >= 1);
ALTER TABLE admin_alerts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE admin_alerts ADD COLUMN IF NOT EXISTS first_at timestamptz;
ALTER TABLE admin_alerts ADD COLUMN IF NOT EXISTS last_at timestamptz;
SELECT memory_check_extend('admin_alerts', 'admin_alerts_level_check', 'level', ARRAY['page', 'metric']);
SELECT memory_check_finish('admin_alerts', 'admin_alerts_level_check');
SELECT memory_check_extend('admin_alerts', 'admin_alerts_status_check', 'status', ARRAY['open', 'acked', 'closed']);
SELECT memory_check_finish('admin_alerts', 'admin_alerts_status_check');

CREATE OR REPLACE FUNCTION admin_alerts_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    NEW.first_at := COALESCE(NEW.first_at, NEW.at);
    IF NEW.last_at IS NULL OR NEW.last_at < NEW.first_at THEN
        NEW.last_at := NEW.first_at;
    END IF;
    IF NEW.acked_at IS NOT NULL AND NEW.status = 'open' THEN
        NEW.status := 'acked';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION admin_alerts_fill() FROM PUBLIC;
CREATE OR REPLACE TRIGGER admin_alerts_fill BEFORE INSERT OR UPDATE ON admin_alerts FOR EACH ROW EXECUTE FUNCTION admin_alerts_fill();
UPDATE admin_alerts SET first_at = COALESCE(first_at, at)
 WHERE first_at IS NULL OR last_at IS NULL OR (acked_at IS NOT NULL AND status = 'open');
ALTER TABLE admin_alerts ALTER COLUMN first_at SET NOT NULL;
ALTER TABLE admin_alerts ALTER COLUMN last_at SET NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'admin_alerts'::regclass AND conname = 'admin_alerts_acked_check') THEN
        ALTER TABLE admin_alerts ADD CONSTRAINT admin_alerts_acked_check CHECK (status <> 'acked' OR acked_at IS NOT NULL);
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS admin_alerts_open_subject_idx ON admin_alerts (instance_id, code, subject)
    WHERE status = 'open' AND subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS alert_feed_cursor (
    instance_id       text PRIMARY KEY,
    after_received_at timestamptz,
    after_id          uuid,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT alert_feed_cursor_pair_check CHECK ((after_received_at IS NULL) = (after_id IS NULL))
);
ALTER TABLE alert_feed_cursor ADD COLUMN IF NOT EXISTS detectors jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT alert_feed_cursor_detectors_check CHECK (jsonb_typeof(detectors) = 'object' AND octet_length(detectors::text) <= 16384);

CREATE TABLE IF NOT EXISTS connection_networks (
    instance_id   text NOT NULL,
    connection_id uuid NOT NULL,
    prefix16      cidr NOT NULL,
    asn           bigint CONSTRAINT connection_networks_asn_check CHECK (asn BETWEEN 0 AND 4294967295),
    country       text CONSTRAINT connection_networks_country_check CHECK (country ~ '^[A-Z]{2}$'),
    first_seen    timestamptz NOT NULL DEFAULT now(),
    last_seen     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connection_id, prefix16),
    CONSTRAINT connection_networks_prefix_check CHECK ((family(prefix16) = 4 AND masklen(prefix16) = 16)
                                                       OR (family(prefix16) = 6 AND masklen(prefix16) = 32)),
    CONSTRAINT connection_networks_seen_check CHECK (last_seen >= first_seen)
);
CREATE INDEX IF NOT EXISTS connection_networks_seen_idx ON connection_networks (instance_id, last_seen);
ALTER TABLE connection_networks ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
CREATE INDEX IF NOT EXISTS connection_networks_new_idx ON connection_networks (instance_id, first_seen) WHERE alerted_at IS NULL;

CREATE OR REPLACE FUNCTION connection_network_seen(p_instance text, p_connection uuid, p_prefix cidr, p_asn bigint, p_country text,
                                                   p_at timestamptz DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_at  timestamptz := LEAST(COALESCE(p_at, now()), now());
    v_len int;
    v_net cidr;
    v_new boolean;
BEGIN
    IF p_instance IS NULL OR p_connection IS NULL OR p_prefix IS NULL THEN
        RAISE EXCEPTION 'connection_network_seen: instance, connection and network are required' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_len := CASE family(p_prefix) WHEN 4 THEN 16 ELSE 32 END;
    v_net := CASE WHEN masklen(p_prefix) >= v_len THEN network(set_masklen(p_prefix::inet, v_len)) ELSE p_prefix END;
    INSERT INTO connection_networks AS n (instance_id, connection_id, prefix16, asn, country, first_seen, last_seen)
    VALUES (p_instance, p_connection, v_net, p_asn, p_country, v_at, v_at)
    ON CONFLICT (connection_id, prefix16) DO UPDATE
       SET first_seen = LEAST(n.first_seen, EXCLUDED.first_seen),
           last_seen  = GREATEST(n.last_seen, EXCLUDED.last_seen),
           asn        = CASE WHEN EXCLUDED.last_seen >= n.last_seen THEN COALESCE(EXCLUDED.asn, n.asn) ELSE COALESCE(n.asn, EXCLUDED.asn) END,
           country    = CASE WHEN EXCLUDED.last_seen >= n.last_seen THEN COALESCE(EXCLUDED.country, n.country) ELSE COALESCE(n.country, EXCLUDED.country) END
     WHERE n.instance_id = EXCLUDED.instance_id
    RETURNING (n.xmax = 0) INTO v_new;
    RETURN COALESCE(v_new, false);
END $$;
REVOKE ALL ON FUNCTION connection_network_seen(text, uuid, cidr, bigint, text, timestamptz) FROM PUBLIC;

GRANT UPDATE (status, acked_by, acked_at) ON admin_alerts TO memory_admin_plane;
GRANT UPDATE (count, last_at, status) ON admin_alerts TO memory_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_feed_cursor TO memory_worker;
GRANT SELECT, DELETE ON connection_networks TO memory_worker;
GRANT UPDATE (alerted_at) ON connection_networks TO memory_worker;
REVOKE ALL ON connection_networks FROM memory_intake;
GRANT EXECUTE ON FUNCTION connection_network_seen(text, uuid, cidr, bigint, text, timestamptz) TO memory_intake;

-- [1e]

GRANT SELECT (person_id, disabled_at) ON admin_webauthn_credentials TO memory_authcheck;

-- [1f]

GRANT EXECUTE ON FUNCTION approval_consume(uuid, text, bytea) TO memory_authcheck;

SELECT memory_check_extend('admin_approvals', 'admin_approvals_decision_check', 'decision', ARRAY['basic_auto']);
SELECT memory_check_finish('admin_approvals', 'admin_approvals_decision_check');
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'admin_approvals'::regclass AND conname = 'admin_approvals_decided_by_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%basic_auto%') THEN
        ALTER TABLE admin_approvals DROP CONSTRAINT admin_approvals_decided_by_check,
            ADD CONSTRAINT admin_approvals_decided_by_check CHECK (decision IS NULL OR decided_by IS NOT NULL OR decision = 'basic_auto');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'admin_approvals'::regclass AND conname = 'admin_approvals_executed_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%basic_auto%') THEN
        ALTER TABLE admin_approvals DROP CONSTRAINT admin_approvals_executed_check,
            ADD CONSTRAINT admin_approvals_executed_check CHECK (executed_at IS NULL OR decision IN ('approved', 'basic_auto'));
    END IF;
END $$;

CREATE OR REPLACE FUNCTION approval_basic_auto(p_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r admin_approvals%ROWTYPE;
BEGIN
    IF p_id IS NULL THEN RETURN false; END IF;
    SELECT * INTO r FROM admin_approvals WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF r.action <> 'mfa.factor_reset' OR r.requested_by IS NULL OR r.subject_hash IS NULL THEN RETURN false; END IF;
    IF r.subject_hash = sha256(convert_to('mfa.factor_reset' || E'\n' || r.requested_by::text, 'UTF8')) THEN RETURN false; END IF;
    IF r.decision IS NOT NULL OR r.cancelled_at IS NOT NULL OR r.executed_at IS NOT NULL OR r.expires_at <= now() THEN RETURN false; END IF;
    IF to_regprocedure('security_mode(text)') IS NULL THEN RETURN false; END IF;
    IF security_mode(r.instance_id) IS DISTINCT FROM 'basic' THEN RETURN false; END IF;
    IF to_regprocedure('security_mode_is_admin(text,uuid)') IS NULL THEN RETURN false; END IF;
    IF NOT security_mode_is_admin(r.instance_id, r.requested_by) THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM admin_sessions s
                    WHERE s.id = r.requested_session AND s.instance_id = r.instance_id AND s.person_id = r.requested_by
                      AND s.role = 'memory_admin' AND s.auth_method IN ('sso', 'sso_webauthn') AND s.breakglass_window_id IS NULL
                      AND s.revoked_at IS NULL AND s.expires_at > now()) THEN
        RETURN false;
    END IF;
    UPDATE admin_approvals SET decision = 'basic_auto', decided_at = now(), executed_at = now(), body_enc = NULL WHERE id = p_id;
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION approval_basic_auto(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval_basic_auto(uuid) TO memory_admin_plane;

CREATE OR REPLACE FUNCTION admin_approvals_basic_auto_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    owner text;
BEGIN
    IF NEW.decision = 'basic_auto' AND (TG_OP = 'INSERT' OR OLD.decision IS DISTINCT FROM 'basic_auto') THEN
        SELECT pg_get_userbyid(p.proowner) INTO owner FROM pg_proc p WHERE p.oid = to_regprocedure('approval_basic_auto(uuid)');
        IF NOT (COALESCE(current_user = owner, false) OR COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false)) THEN
            RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'admin_approvals_basic_auto',
                MESSAGE = 'admin_approvals: the decision basic_auto is set only by approval_basic_auto (second-factor reset in basic)';
        END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION admin_approvals_basic_auto_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS admin_approvals_basic_auto ON admin_approvals;
CREATE TRIGGER admin_approvals_basic_auto BEFORE INSERT OR UPDATE ON admin_approvals FOR EACH ROW
    EXECUTE FUNCTION admin_approvals_basic_auto_guard();

CREATE OR REPLACE FUNCTION approval_reset_decision(p_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.decision FROM admin_approvals a WHERE a.id = p_id AND a.action = 'mfa.factor_reset' AND a.consumed_at IS NOT NULL
$$;
REVOKE ALL ON FUNCTION approval_reset_decision(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval_reset_decision(uuid) TO memory_authcheck;

CREATE OR REPLACE FUNCTION mfa_mode_approval(p_instance text, p_raw text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v uuid;
BEGIN
    IF p_raw IS NULL OR p_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
    IF to_regclass('admin_approvals') IS NULL THEN RETURN NULL; END IF;
    UPDATE admin_approvals a SET consumed_at = now()
     WHERE a.id = p_raw::uuid AND a.instance_id = p_instance AND a.action = 'admin.settings.put'
       AND a.subject_hash = sha256(convert_to('admin.settings.put' || E'\n' || 'edge.mfa_mode', 'UTF8'))
       AND a.requested_by IS NOT NULL
       AND a.decision = 'approved' AND a.decided_by IS NOT NULL AND a.cancelled_at IS NULL
       AND a.executed_at IS NOT NULL AND a.executed_at <= now() AND a.executed_at > now() - interval '60 seconds'
       AND a.executed_status IS NULL
       AND a.consumed_at IS NULL
    RETURNING a.id INTO v;
    RETURN v;
END $$;
REVOKE ALL ON FUNCTION mfa_mode_approval(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION mfa_anchor_floor_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_raw  jsonb;
    v_set  text;
    v_from text;
    v_to   text;
BEGIN
    IF to_regprocedure('mfa_mode_transition(text,text,text,text,uuid)') IS NULL
       OR to_regprocedure('mfa_mode_floor_without(text,text,bigint)') IS NULL THEN
        RETURN NULL;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('mfa_mode'), hashtext(NEW.instance_id));
    SELECT COALESCE(s.value, s.default_value) INTO v_raw FROM settings s
     WHERE s.instance_id = NEW.instance_id AND s.category = 'edge' AND s.key = 'mfa_mode';
    v_set := mfa_mode_of(v_raw);
    v_from := mfa_mode_floor_without(NEW.instance_id, NEW.kind, NEW.serial);
    v_to := mfa_mode_floor(NEW.instance_id);
    IF mfa_mode_rank(v_set) > mfa_mode_rank(v_from) THEN v_from := v_set; END IF;
    IF mfa_mode_rank(v_set) > mfa_mode_rank(v_to) THEN v_to := v_set; END IF;
    PERFORM mfa_mode_transition(NEW.instance_id, v_from, v_to, 'anchors:' || NEW.serial, NULL);
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mfa_anchor_floor_apply() FROM PUBLIC;
CREATE OR REPLACE TRIGGER anchors_applied_mfa_floor AFTER INSERT ON anchors_applied FOR EACH ROW
    WHEN (NEW.mfa_mode_min IS NOT NULL) EXECUTE FUNCTION mfa_anchor_floor_apply();

CREATE OR REPLACE FUNCTION mfa_anchor_floor_applied(p_instance text, p_serial bigint, p_sha256 bytea, p_signers text[], p_floor text, p_via text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    last_serial bigint;
    last_sha    bytea;
    last_floor  text;
    n           int;
BEGIN
    IF p_instance IS NULL OR NOT EXISTS (SELECT 1 FROM instances WHERE id = p_instance) THEN
        RAISE EXCEPTION 'mfa_anchor_floor_applied: no such instance' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_serial IS NULL OR p_serial < 1 THEN
        RAISE EXCEPTION 'mfa_anchor_floor_applied: the anchors serial is an integer of at least 1' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_sha256 IS NULL OR octet_length(p_sha256) <> 32 THEN
        RAISE EXCEPTION 'mfa_anchor_floor_applied: the document sha256 is 32 bytes' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_signers IS NULL OR cardinality(p_signers) NOT BETWEEN 1 AND 16
       OR EXISTS (SELECT 1 FROM unnest(p_signers) s WHERE s IS NULL OR s !~ '^SHA256:[A-Za-z0-9+/=_-]{1,100}$') THEN
        RAISE EXCEPTION 'mfa_anchor_floor_applied: signers — from 1 to 16 fingerprints SHA256:…' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_floor IS NULL THEN
        RAISE EXCEPTION 'mfa_anchor_floor_applied: the mode floor is required (off, optional, required)' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('mfa_anchor_floor_applied'), hashtext(p_instance));
    SELECT a.serial, a.sha256, a.mfa_mode_min INTO last_serial, last_sha, last_floor FROM anchors_applied a
     WHERE a.instance_id = p_instance AND a.kind = 'edge' ORDER BY a.serial DESC LIMIT 1;
    IF last_serial IS NOT NULL AND p_serial < last_serial THEN
        RAISE EXCEPTION 'anchors_rollback: edge anchors serial % is older than the applied one (%)', p_serial, last_serial USING ERRCODE = 'check_violation';
    END IF;
    IF last_serial = p_serial THEN
        IF last_sha IS DISTINCT FROM p_sha256 THEN
            RAISE EXCEPTION 'anchors_serial_reused: serial % has already been applied with a different document', p_serial USING ERRCODE = 'check_violation';
        END IF;
        IF last_floor IS DISTINCT FROM p_floor THEN
            RAISE EXCEPTION 'anchors_floor_mismatch: document serial % has mode floor %, not %', p_serial, COALESCE(last_floor, 'not set'), p_floor
                  USING ERRCODE = 'check_violation';
        END IF;
        RETURN false;
    END IF;
    INSERT INTO anchors_applied (instance_id, kind, serial, sha256, signers, applied_via, mfa_mode_min)
    VALUES (p_instance, 'edge', p_serial, p_sha256, p_signers, p_via, p_floor)
    ON CONFLICT (instance_id, kind, serial) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
        RETURN true;
    END IF;
    SELECT a.sha256, a.mfa_mode_min INTO last_sha, last_floor FROM anchors_applied a
     WHERE a.instance_id = p_instance AND a.kind = 'edge' AND a.serial = p_serial;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'anchors_state: the edge anchors row with serial % was neither written nor found', p_serial USING ERRCODE = 'check_violation';
    END IF;
    IF last_sha IS DISTINCT FROM p_sha256 THEN
        RAISE EXCEPTION 'anchors_serial_reused: serial % has already been applied with a different document', p_serial USING ERRCODE = 'check_violation';
    END IF;
    IF last_floor IS DISTINCT FROM p_floor THEN
        RAISE EXCEPTION 'anchors_floor_mismatch: document serial % has mode floor %, not %', p_serial, COALESCE(last_floor, 'not set'), p_floor
              USING ERRCODE = 'check_violation';
    END IF;
    RETURN false;
END $$;
REVOKE ALL ON FUNCTION mfa_anchor_floor_applied(text, bigint, bytea, text[], text, text) FROM PUBLIC, memory_authcheck;
GRANT EXECUTE ON FUNCTION mfa_anchor_floor_applied(text, bigint, bytea, text[], text, text) TO memory_gateway;

DO $$
DECLARE
    r      record;
    v_raw  jsonb;
    v_eff  text;
    v_fl   text;
    v_last text;
    v_lat  timestamptz;
    v_ser  bigint;
    v_sat  timestamptz;
BEGIN
    IF to_regprocedure('mfa_mode_transition(text,text,text,text,uuid)') IS NULL OR to_regprocedure('mfa_mode_floor(text)') IS NULL THEN
        RETURN;
    END IF;
    FOR r IN SELECT s.instance_id FROM settings s WHERE s.category = 'edge' AND s.key = 'mfa_mode' ORDER BY s.instance_id LOOP
        PERFORM pg_advisory_xact_lock(hashtext('mfa_mode'), hashtext(r.instance_id));
        SELECT COALESCE(s.value, s.default_value) INTO v_raw FROM settings s
         WHERE s.instance_id = r.instance_id AND s.category = 'edge' AND s.key = 'mfa_mode';
        v_eff := mfa_mode_of(v_raw);
        v_fl := mfa_mode_floor(r.instance_id);
        IF mfa_mode_rank(v_fl) > mfa_mode_rank(v_eff) THEN v_eff := v_fl; END IF;
        v_last := NULL; v_lat := NULL; v_ser := NULL; v_sat := NULL;
        SELECT c.to_mode, c.at INTO v_last, v_lat FROM mfa_mode_changes c
         WHERE c.instance_id = r.instance_id ORDER BY c.at DESC, c.id DESC LIMIT 1;
        IF COALESCE(v_last, 'off') = v_eff THEN CONTINUE; END IF;
        SELECT a.serial, a.applied_at INTO v_ser, v_sat FROM anchors_applied a
         WHERE a.instance_id = r.instance_id AND a.mfa_mode_min IS NOT NULL ORDER BY a.applied_at DESC, a.serial DESC LIMIT 1;
        PERFORM mfa_mode_transition(r.instance_id, COALESCE(v_last, 'off'), v_eff,
                                    CASE WHEN v_ser IS NOT NULL AND (v_lat IS NULL OR v_sat > v_lat) THEN 'anchors:' || v_ser ELSE 'system' END, NULL);
    END LOOP;
END $$;

-- [S2-3]

-- [4]

-- [E2]

-- [5]
