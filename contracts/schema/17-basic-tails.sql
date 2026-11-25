
-- [LIM]
CREATE TABLE IF NOT EXISTS upload_daily_usage (
    instance_id text   NOT NULL,
    person_id   uuid   NOT NULL,
    day         date   NOT NULL,
    files       integer NOT NULL DEFAULT 0 CONSTRAINT upload_daily_usage_files_check CHECK (files >= 0),
    bytes       bigint  NOT NULL DEFAULT 0 CONSTRAINT upload_daily_usage_bytes_check CHECK (bytes >= 0),
    noted_at    timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, person_id, day)
);
CREATE INDEX IF NOT EXISTS upload_daily_usage_day_idx ON upload_daily_usage (instance_id, day);
COMMENT ON TABLE upload_daily_usage IS 'Daily upload volume per person (limits.upload_daily): files and bytes per day in the time zone of the night window';
REVOKE ALL ON upload_daily_usage FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON upload_daily_usage TO memory_gateway;

-- [OQ]
-- Open-record rechecks.
-- When the strict NDA list grows, open_recheck scans open records and closes matches through class_moves
-- (via = 'nda_recheck'). The cursor and phase survive restarts. No record text or titles are stored here.
-- names holds list entries only while a run is active; added runs discard removed entries on each batch,
-- and completed runs clear names to []. The panel never shows names. No people foreign keys (tp_fk_blockers).
CREATE TABLE IF NOT EXISTS open_rechecks (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id text NOT NULL,
    reason      text NOT NULL,
    names       jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT open_rechecks_names_check CHECK (jsonb_typeof(names) = 'array'),
    phase       text NOT NULL DEFAULT 'scan',
    cursor_id   uuid,
    tail_from   timestamptz NOT NULL,
    counts      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- checked, held, on_restore, busy, unchecked, failed, released, reopened
    report      jsonb NOT NULL DEFAULT '{}'::jsonb,
    state       text NOT NULL DEFAULT 'running',       -- running | done | cancelled
    created_by  uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    mailed_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS open_rechecks_one_running ON open_rechecks (instance_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS open_rechecks_created_idx ON open_rechecks (instance_id, created_at DESC);
COMMENT ON TABLE open_rechecks IS 'Runs of the open recheck: the NDA list was extended, the whole list, held records, NFD letters (open_recheck)';

CREATE TABLE IF NOT EXISTS open_recheck_holds (
    run_id      uuid NOT NULL REFERENCES open_rechecks(id) ON DELETE CASCADE,
    record_id   uuid NOT NULL,
    instance_id text NOT NULL,
    state       text NOT NULL,
    why         text,
    kinds       text[] NOT NULL DEFAULT '{}',
    rules       text[] NOT NULL DEFAULT '{}',
    move_id     uuid,
    attempts    integer NOT NULL DEFAULT 0 CONSTRAINT open_recheck_holds_attempts_check CHECK (attempts >= 0),
    space_id    uuid,
    owner_id    uuid,
    held_at     timestamptz,
    decided_by  uuid,
    decided_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, record_id)
);
DO $oq_enums$
DECLARE
    c record;
    ext boolean := to_regprocedure('memory_check_extend(text,text,text,text[])') IS NOT NULL;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('open_rechecks',      'open_rechecks_reason_check',     'reason', ARRAY['added', 'full', 'manual', 'held', 'nfd']),
        ('open_rechecks',      'open_rechecks_phase_check',      'phase',  ARRAY['scan', 'tail', 'retry', 'done']),
        ('open_rechecks',      'open_rechecks_state_check',      'state',  ARRAY['running', 'done', 'cancelled']),
        ('open_recheck_holds', 'open_recheck_holds_state_check', 'state',  ARRAY['pending', 'held', 'kept', 'released', 'on_restore', 'failed', 'gone']),
        ('open_recheck_holds', 'open_recheck_holds_why_check',   'why',    ARRAY['nda', 'rules', 'unchecked', 'busy'])
    ) AS v(tbl, con, col, vals) LOOP
        IF ext THEN
            PERFORM memory_check_extend(c.tbl, c.con, c.col, c.vals);
        ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c.tbl::regclass AND conname = c.con) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IN (%s))', c.tbl, c.con, c.col,
                           (SELECT string_agg(quote_literal(x), ',') FROM unnest(c.vals) AS x));
        END IF;
    END LOOP;
END $oq_enums$;
DO $oq_enums_finish$
DECLARE
    c record;
BEGIN
    IF to_regprocedure('memory_check_finish(text,text)') IS NULL THEN RETURN; END IF;
    FOR c IN SELECT * FROM (VALUES ('open_rechecks', 'open_rechecks_reason_check'), ('open_rechecks', 'open_rechecks_phase_check'),
                                   ('open_rechecks', 'open_rechecks_state_check'), ('open_recheck_holds', 'open_recheck_holds_state_check'),
                                   ('open_recheck_holds', 'open_recheck_holds_why_check')) AS v(tbl, con) LOOP
        PERFORM memory_check_finish(c.tbl, c.con);
    END LOOP;
END $oq_enums_finish$;
CREATE INDEX IF NOT EXISTS open_recheck_holds_record_idx ON open_recheck_holds (instance_id, record_id)
    WHERE state IN ('pending','held','kept','on_restore');
CREATE INDEX IF NOT EXISTS open_recheck_holds_state_idx ON open_recheck_holds (instance_id, state, held_at DESC);
COMMENT ON TABLE open_recheck_holds IS 'Records hidden by the open recheck and their fate: held, left, opened again, restore as closed';
REVOKE ALL ON open_rechecks, open_recheck_holds FROM PUBLIC;
REVOKE ALL ON open_rechecks, open_recheck_holds FROM memory_worker, memory_gateway;
GRANT SELECT, INSERT, UPDATE ON open_rechecks TO memory_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON open_recheck_holds TO memory_worker;
GRANT SELECT, INSERT ON open_rechecks TO memory_gateway;
GRANT SELECT, INSERT, UPDATE ON open_recheck_holds TO memory_gateway;

-- [L10N]
-- Settings category locale: locale.mcp_language — the language of what agents see over MCP (04-seed.sql). The value
-- is added by memory_check_extend (09) without recreating the CHECK; a test sandbox without 09 (01, 05, 17) keeps the
-- narrower CHECK, and the seed then creates no locale row — the code serves English. The value is never removed.
DO $l10n$
BEGIN
    IF to_regprocedure('memory_check_extend(text,text,text,text[])') IS NOT NULL THEN
        PERFORM memory_check_extend('settings', 'settings_category_check', 'category', ARRAY['locale']);
    END IF;
END $l10n$;
DO $l10n_finish$
BEGIN
    IF to_regprocedure('memory_check_finish(text,text)') IS NOT NULL THEN
        PERFORM memory_check_finish('settings', 'settings_category_check');
    END IF;
END $l10n_finish$;

-- [AS]
DO $as$
BEGIN
    IF to_regprocedure('memory_check_extend(text,text,text,text[])') IS NULL
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'oauth_connections' AND column_name = 'origin' AND table_schema = current_schema()) THEN
        RAISE NOTICE '17 [AS]: no 09 — part skipped';
        RETURN;
    END IF;
    PERFORM memory_check_extend('settings', 'settings_category_check', 'category', ARRAY['agent_auth']);
    PERFORM memory_check_extend('oauth_connections', 'oauth_connections_origin_check', 'origin', ARRAY['builtin']);

    CREATE TABLE IF NOT EXISTS agent_oauth_tx (
        id            text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{43}$'),
        instance_id   text NOT NULL,
        cookie_hash   bytea NOT NULL CHECK (octet_length(cookie_hash) = 32),
        csrf          bytea NOT NULL CHECK (octet_length(csrf) = 32),
        client_id     text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
        client_source text NOT NULL,                 -- registry | cimd | dcr (agent_oauth_tx_client_source_check)
        client_kind   text NOT NULL,
        client_title  text NOT NULL CHECK (char_length(client_title) BETWEEN 1 AND 120),
        client_name   text CHECK (client_name IS NULL OR char_length(client_name) <= 100),
        client_known  boolean NOT NULL,
        redirect_uri  text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
        redirect_mode text NOT NULL,                 -- redirect | link | custom (agent_oauth_tx_redirect_mode_check)
        state         text CHECK (state IS NULL OR char_length(state) <= 2048),
        code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
        resource      text NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 2048),
        prompt_login  boolean NOT NULL DEFAULT false,
        ip_net        text CHECK (ip_net IS NULL OR char_length(ip_net) <= 64),
        created_at    timestamptz NOT NULL DEFAULT now(),
        expires_at    timestamptz NOT NULL,
        person_id     uuid,
        session_id    uuid,
        claimed_at    timestamptz,
        decision      text,            -- allow | deny (agent_oauth_tx_decision_check)
        decided_at    timestamptz,
        continue_hash bytea CHECK (continue_hash IS NULL OR octet_length(continue_hash) = 32),
        consent_version smallint,
        policy_print  bytea NOT NULL CHECK (octet_length(policy_print) = 32),
        CONSTRAINT agent_oauth_tx_claim_check CHECK ((person_id IS NULL) = (session_id IS NULL)),
        CONSTRAINT agent_oauth_tx_decision_set_check CHECK ((decision IS NULL) = (continue_hash IS NULL)
                                                           AND (decision IS NULL) = (person_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS agent_oauth_tx_expires_idx ON agent_oauth_tx (instance_id, expires_at);
    CREATE INDEX IF NOT EXISTS agent_oauth_tx_net_idx ON agent_oauth_tx (instance_id, ip_net);
    CREATE INDEX IF NOT EXISTS agent_oauth_tx_person_idx ON agent_oauth_tx (person_id) WHERE person_id IS NOT NULL;
    COMMENT ON TABLE agent_oauth_tx IS 'Agent sign-in transactions of the built-in server: the client’s request, the person’s decision, the continuation (10 minutes)';

    CREATE TABLE IF NOT EXISTS agent_oauth_codes (
        code_hash     bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
        instance_id   text NOT NULL,
        grant_id      uuid NOT NULL,
        person_id     uuid NOT NULL,
        session_id    uuid NOT NULL,
        client_id     text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
        client_source text NOT NULL,                 -- agent_oauth_codes_client_source_check
        client_kind   text NOT NULL,
        client_label  text NOT NULL CHECK (char_length(client_label) BETWEEN 1 AND 120),
        redirect_uri  text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
        code_challenge text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
        resource      text NOT NULL,
        consent_version smallint NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        expires_at    timestamptz NOT NULL,
        used_at       timestamptz,
        connection_id uuid,
        policy_print  bytea NOT NULL CHECK (octet_length(policy_print) = 32)
    );
    CREATE INDEX IF NOT EXISTS agent_oauth_codes_expires_idx ON agent_oauth_codes (instance_id, expires_at);
    CREATE INDEX IF NOT EXISTS agent_oauth_codes_person_idx ON agent_oauth_codes (person_id);
    COMMENT ON TABLE agent_oauth_codes IS 'Authorization codes of the built-in sign-in server: single-use, 60 seconds, hash only';

    CREATE TABLE IF NOT EXISTS agent_oauth_tokens (
        token_hash    bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
        instance_id   text NOT NULL,
        kind          text NOT NULL,                 -- at | rt (agent_oauth_tokens_kind_check)
        connection_id uuid NOT NULL,
        generation    integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
        k_rt_kid      smallint CHECK (k_rt_kid IS NULL OR k_rt_kid >= 1),
        rotated_at    timestamptz,
        successor_hash bytea CHECK (successor_hash IS NULL OR octet_length(successor_hash) = 32),
        replays       smallint NOT NULL DEFAULT 0 CHECK (replays BETWEEN 0 AND 5),
        created_at    timestamptz NOT NULL DEFAULT now(),
        expires_at    timestamptz NOT NULL,
        CONSTRAINT agent_oauth_tokens_rt_check CHECK (kind = 'rt' OR (rotated_at IS NULL AND successor_hash IS NULL AND k_rt_kid IS NULL)),
        CONSTRAINT agent_oauth_tokens_rotation_check CHECK ((rotated_at IS NULL) = (successor_hash IS NULL))
    );
    CREATE INDEX IF NOT EXISTS agent_oauth_tokens_connection_idx ON agent_oauth_tokens (connection_id);
    CREATE INDEX IF NOT EXISTS agent_oauth_tokens_expires_idx ON agent_oauth_tokens (instance_id, expires_at);
    COMMENT ON TABLE agent_oauth_tokens IS 'Access and refresh tokens of the connections of the built-in sign-in server: hash only, refresh family';

    CREATE TABLE IF NOT EXISTS agent_oauth_dcr_clients (
        client_id     text PRIMARY KEY CHECK (client_id ~ '^dcr_[a-z2-7]{26}$'),
        instance_id   text NOT NULL,
        client_name   text CHECK (client_name IS NULL OR char_length(client_name) <= 100),
        redirect_uris jsonb NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array' AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 10),
        software_id   text CHECK (software_id IS NULL OR char_length(software_id) <= 255),
        software_version text CHECK (software_version IS NULL OR char_length(software_version) <= 255),
        created_ip_prefix text CHECK (created_ip_prefix IS NULL OR char_length(created_ip_prefix) <= 64),
        created_at    timestamptz NOT NULL DEFAULT now(),
        last_authorize_at timestamptz,
        first_used_at timestamptz,
        last_used_at  timestamptz,
        revoked_at    timestamptz,
        trusted_egress boolean NOT NULL DEFAULT false
    );
    ALTER TABLE agent_oauth_dcr_clients ADD COLUMN IF NOT EXISTS trusted_egress boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS agent_oauth_dcr_clients_created_idx ON agent_oauth_dcr_clients (instance_id, created_at);
    CREATE INDEX IF NOT EXISTS agent_oauth_dcr_clients_net_idx ON agent_oauth_dcr_clients (instance_id, created_ip_prefix, created_at);
    COMMENT ON TABLE agent_oauth_dcr_clients IS 'Clients that registered themselves (DCR): name, return URLs, registration network, usage';

    PERFORM memory_check_extend('agent_oauth_tx',     'agent_oauth_tx_client_source_check',    'client_source', ARRAY['registry','cimd','dcr']);
    PERFORM memory_check_extend('agent_oauth_tx',     'agent_oauth_tx_redirect_mode_check',    'redirect_mode', ARRAY['redirect','link','custom']);
    PERFORM memory_check_extend('agent_oauth_tx',     'agent_oauth_tx_decision_check',         'decision',      ARRAY['allow','deny']);
    PERFORM memory_check_extend('agent_oauth_codes',  'agent_oauth_codes_client_source_check', 'client_source', ARRAY['registry','cimd','dcr']);
    PERFORM memory_check_extend('agent_oauth_tokens', 'agent_oauth_tokens_kind_check',         'kind',          ARRAY['at','rt']);

    REVOKE ALL ON agent_oauth_tx, agent_oauth_codes, agent_oauth_tokens, agent_oauth_dcr_clients FROM PUBLIC;
    REVOKE ALL ON agent_oauth_tx, agent_oauth_codes, agent_oauth_tokens, agent_oauth_dcr_clients FROM memory_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_oauth_tx, agent_oauth_codes, agent_oauth_tokens, agent_oauth_dcr_clients TO memory_gateway;

    EXECUTE $fn$
CREATE OR REPLACE FUNCTION agent_oauth_person_off() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $body$
BEGIN
    DELETE FROM agent_oauth_tx WHERE person_id = NEW.id;
    DELETE FROM agent_oauth_codes WHERE person_id = NEW.id AND used_at IS NULL;
    WITH revoked AS (UPDATE api_keys k SET revoked_at = now() FROM oauth_connections c
                     WHERE c.id = k.id AND c.origin = 'builtin' AND c.person_id = NEW.id AND k.revoked_at IS NULL RETURNING k.id)
    UPDATE action_plans SET status = 'cancelled' WHERE status = 'pending' AND key_id IN (SELECT id FROM revoked);
    RETURN NEW;
END $body$
$fn$;
    REVOKE ALL ON FUNCTION agent_oauth_person_off() FROM PUBLIC;
    DROP TRIGGER IF EXISTS people_agent_oauth_off ON people;
    CREATE TRIGGER people_agent_oauth_off AFTER UPDATE OF active ON people FOR EACH ROW
        WHEN (OLD.active AND NOT NEW.active) EXECUTE FUNCTION agent_oauth_person_off();
END $as$;
DO $as_finish$
DECLARE c record;
BEGIN
    IF to_regclass('agent_oauth_tx') IS NULL OR to_regprocedure('memory_check_finish(text,text)') IS NULL THEN RETURN; END IF;
    FOR c IN SELECT * FROM (VALUES ('settings', 'settings_category_check'), ('oauth_connections', 'oauth_connections_origin_check'),
             ('agent_oauth_tx', 'agent_oauth_tx_client_source_check'), ('agent_oauth_tx', 'agent_oauth_tx_redirect_mode_check'),
             ('agent_oauth_tx', 'agent_oauth_tx_decision_check'), ('agent_oauth_codes', 'agent_oauth_codes_client_source_check'),
             ('agent_oauth_tokens', 'agent_oauth_tokens_kind_check')) AS v(tbl, con) LOOP
        PERFORM memory_check_finish(c.tbl, c.con);
    END LOOP;
END $as_finish$;

-- [AX]
-- Reserved for feedback of agents on search results. No statements yet: the part replaces this line.

-- [LG]
-- Lifecycle of records and people's own defaults.
-- people.upload_default — the person's choice for new records in the personal space ("What my agent sees"); NULL — the
-- instance default (access.personal_upload_default). people.morning_note — false: the person turned the morning e-mail off.
-- A repeated run skips both columns (no rewrite, no scan). The plan operation "open" (bulk show to agents) is added
-- by memory_check_extend (09) without recreating the CHECK; a test sandbox without 09 keeps the base CHECK. Values are never
-- removed. The settings keys of the stream (access.morning_note, access.personal_upload_default and …_choice) are in
-- 04-seed.sql; the seed gives access.morning_note switched off to an install that already has settings rows. The mail kind
-- morning_note (enums.json section 5) is added to mail_outbox_kind_check the same way: without it no morning
-- note can be queued; a sandbox without mail_outbox skips it.
-- A test sandbox that applies 17 to an empty schema (no people table: the [OQ] test) skips the columns with a NOTICE.
DO $lg_people$
BEGIN
    IF to_regclass('people') IS NULL THEN
        RAISE NOTICE '17 [LG]: no people table, the people columns are skipped';
        RETURN;
    END IF;
    ALTER TABLE people ADD COLUMN IF NOT EXISTS upload_default text CONSTRAINT people_upload_default_check CHECK (upload_default IN ('closed', 'open'));
    ALTER TABLE people ADD COLUMN IF NOT EXISTS morning_note boolean;
    COMMENT ON COLUMN people.upload_default IS 'Class of new records the person adds to the personal space in the workspace: closed or open (open — after the open check); NULL — the instance default access.personal_upload_default';
    COMMENT ON COLUMN people.morning_note IS 'Personal morning note by e-mail: false — the person turned it off; NULL or true — as the instance setting access.morning_note says';
END $lg_people$;
DO $lg_enums$
BEGIN
    IF to_regprocedure('memory_check_extend(text,text,text,text[])') IS NOT NULL THEN
        PERFORM memory_check_extend('action_plans', 'action_plans_op_check', 'op', ARRAY['open']);
        IF to_regclass('mail_outbox') IS NOT NULL THEN
            PERFORM memory_check_extend('mail_outbox', 'mail_outbox_kind_check', 'kind', ARRAY['morning_note']);
        END IF;
    END IF;
END $lg_enums$;
DO $lg_enums_finish$
BEGIN
    IF to_regprocedure('memory_check_finish(text,text)') IS NOT NULL THEN
        PERFORM memory_check_finish('action_plans', 'action_plans_op_check');
        IF to_regclass('mail_outbox') IS NOT NULL THEN
            PERFORM memory_check_finish('mail_outbox', 'mail_outbox_kind_check');
        END IF;
    END IF;
END $lg_enums_finish$;

-- [CONN]
-- Connectors to external systems: the connector instances, their encrypted secrets, the replay table of signed
-- webhooks, the staged items, the runs of the scheduler and the daily counters of the delivery. The state rows are the queue (no pg-boss queue): the workers
-- claim due connectors and queued runs by a lease, the gateway claims staged items by a lease. Item bodies (text, files,
-- transcripts) are never stored here — only in the closed bucket under connectors-staging/<connector_id>/<item_id>.
-- No foreign keys to people, spaces or instances (as [LIM] and [OQ]): the final purge of test people (05, tp_fk_blockers)
-- treats every reference to a person as a blocker; a missing run-as person or space is a state at run time
-- (owner_inactive, space_denied). Foreign keys only inside the part, to connectors(id) with ON DELETE CASCADE.
-- The one-time move of the earlier lookup settings into a connector is
-- the last block of this part.
CREATE TABLE IF NOT EXISTS connectors (
    id              uuid PRIMARY KEY,
    instance_id     text NOT NULL,
    kind            text NOT NULL CONSTRAINT connectors_kind_format_check CHECK (kind ~ '^[a-z][a-z0-9_]{1,31}$'),   -- manifest kind
    pack            text CONSTRAINT connectors_pack_format_check CHECK (pack ~ '^[a-z][a-z0-9_]{1,31}$'),   -- preset id; NULL — none
    name            text NOT NULL CONSTRAINT connectors_name_check CHECK (length(name) BETWEEN 1 AND 200),   -- Name of the contract connectors
    scope           text NOT NULL,                       -- instance | person (values: $conn_enums$ below)
    owner_id        uuid,                                -- run-as person (people.id, no foreign key); NULL only for entity-only connectors
    target_space_id uuid,                                -- documents and notes (spaces.id, no foreign key); NULL — the owner's personal space
    data_class      text NOT NULL DEFAULT 'closed',      -- closed | space
    status          text NOT NULL DEFAULT 'draft',       -- draft | active | paused | error | needs_reconfirm | revoked
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- validated against the manifest schema; never a secret
    policy          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- participants, on_change, on_delete, schedule_sec, daily limits
    cursor          text,
    state           jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT connectors_state_size_check CHECK (octet_length(state::text) <= 16384),   -- the text, not the stored (compressed) size
    consent_version text,                                -- meetings: the consent text version the owner acknowledged,
    consent_at      timestamptz,                         -- when,
    consent_by      uuid,                                -- and who did (people.id, no foreign key)
    next_run_at     timestamptz,
    last_run_at     timestamptz,
    last_ok_at      timestamptz,
    lease_until     timestamptz,                         -- run lease of the worker scheduler
    lease_by        text,
    last_error      text,                                -- a code only, never a vendor message
    failures        integer NOT NULL DEFAULT 0 CONSTRAINT connectors_failures_check CHECK (failures >= 0),
    legacy_ref      text,                                -- one-time migrations of earlier settings
    created_by      text NOT NULL,                       -- login as text (no foreign key)
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT connectors_owner_scope CHECK (scope = 'instance' OR owner_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS connectors_legacy_ref_key ON connectors (instance_id, legacy_ref) WHERE legacy_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS connectors_due_idx ON connectors (next_run_at) WHERE status = 'active';
COMMENT ON TABLE connectors IS 'Connector instances: kind, run-as person, target space and data class, status, schedule and run lease; no secrets';

-- Secrets of a connector, encrypted with the settings keyring ({"ct","iv"} as settings.value, enc_kid beside it). The
-- previous value stays valid until prev_until while a webhook secret is rotated.
CREATE TABLE IF NOT EXISTS connector_secrets (
    connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    name         text NOT NULL CONSTRAINT connector_secrets_name_check CHECK (name ~ '^[a-z][a-z0-9_]{0,63}$'),
    enc_kid      text NOT NULL,
    value        jsonb NOT NULL,
    prev_value   jsonb,
    prev_enc_kid text,
    prev_until   timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connector_id, name)
);
COMMENT ON TABLE connector_secrets IS 'Encrypted secrets of connectors (settings keyring); the previous value overlaps while a webhook secret is rotated';

-- Replay protection of signed webhooks: one row per (connector, event id); rows older than 7 days are removed by age.
CREATE TABLE IF NOT EXISTS connector_events (
    connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    event_id     text NOT NULL CONSTRAINT connector_events_event_id_check CHECK (length(event_id) BETWEEN 1 AND 256),   -- webhook-id of the contract
    received_at  timestamptz NOT NULL DEFAULT now(),
    status       text NOT NULL,                          -- received | queued | done | failed
    items        integer NOT NULL DEFAULT 0 CONSTRAINT connector_events_items_check CHECK (items >= 0),
    last_error   text,
    PRIMARY KEY (connector_id, event_id)
);
CREATE INDEX IF NOT EXISTS connector_events_received_idx ON connector_events (received_at);
COMMENT ON TABLE connector_events IS 'Replay protection of signed connector webhooks: event ids by connector, removed by age';

-- Staged items: the single hand-over point for everything that becomes a record. Key — (connector, type, external id);
-- content_hash — SHA-256 of the canonical item; entity items keep only key, hash and status (their rows go to entities).
CREATE TABLE IF NOT EXISTS connector_items (
    id               uuid PRIMARY KEY,
    connector_id     uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    item_type        text NOT NULL,                      -- document | meeting | note | entity
    external_id      text NOT NULL CONSTRAINT connector_items_external_id_check CHECK (length(external_id) BETWEEN 1 AND 200),
    external_version text,
    content_hash     bytea NOT NULL CONSTRAINT connector_items_content_hash_check CHECK (octet_length(content_hash) = 32),
    status           text NOT NULL,                      -- staged | delivering | delivered | unchanged | held | skipped | failed | deleted_at_source
    reason           text,                               -- a code only: class_gate, space_denied, consent_outdated, open_check, upload_daily, …
    attempts         integer NOT NULL DEFAULT 0 CONSTRAINT connector_items_attempts_check CHECK (attempts >= 0),
    next_attempt_at  timestamptz,
    lease_until      timestamptz,
    staged_key       text,                               -- object in the closed bucket; NULL after delivery (entity items: always NULL)
    record_id        uuid,
    record_class     text,
    version          integer NOT NULL DEFAULT 0,
    adopted          boolean NOT NULL DEFAULT false,     -- the record existed before this item: never trashed by on_delete
    seen_run         uuid,                               -- the last complete run that listed the item: deletion detection
    received_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at     timestamptz,
    CONSTRAINT connector_items_key UNIQUE (connector_id, item_type, external_id)
);
CREATE INDEX IF NOT EXISTS connector_items_work_idx ON connector_items (next_attempt_at) WHERE status IN ('staged','delivering');
CREATE INDEX IF NOT EXISTS connector_items_record_idx ON connector_items (record_id) WHERE record_id IS NOT NULL;
COMMENT ON TABLE connector_items IS 'Items staged by connectors: key, content hash, delivery status and the record they became; bodies live in the closed bucket';

-- Runs: admin-requested tests and runs, scheduled syncs, backfills and webhook refetches; counters and a code, no content.
CREATE TABLE IF NOT EXISTS connector_runs (
    id           uuid PRIMARY KEY,
    connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    kind         text NOT NULL,                          -- test | sync | backfill | webhook
    status       text NOT NULL,                          -- queued | running | ok | failed
    requested_by text,                                   -- login as text; NULL — scheduled or webhook
    created_at   timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz,
    finished_at  timestamptz,
    seen         integer NOT NULL DEFAULT 0 CONSTRAINT connector_runs_seen_check CHECK (seen >= 0),
    staged       integer NOT NULL DEFAULT 0 CONSTRAINT connector_runs_staged_check CHECK (staged >= 0),
    error        text,                                   -- a code only
    detail       jsonb
);
CREATE INDEX IF NOT EXISTS connector_runs_queue_idx ON connector_runs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS connector_runs_connector_idx ON connector_runs (connector_id, created_at DESC);
COMMENT ON TABLE connector_runs IS 'Runs of connectors: tests, syncs, backfills and webhook refetches with counters and an error code';

-- Daily counters of the delivery: the items a connector wrote into memory and their bytes, per day of the
-- instance time zone — the connector's own quota (policy daily_items / daily_mb; by default integrations.connectors_daily_items
-- and connectors_daily_mb). The run-as person's limits.upload_daily is counted by the write functions on their own, in
-- upload_daily_usage ([LIM]). The gateway counts, gives back what was not written and removes old days; the workers only
-- read the counters (a pull run may stop when the quota is used up).
CREATE TABLE IF NOT EXISTS connector_daily_usage (
    connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    day          date NOT NULL,
    items        integer NOT NULL DEFAULT 0 CONSTRAINT connector_daily_usage_items_check CHECK (items >= 0),
    bytes        bigint NOT NULL DEFAULT 0 CONSTRAINT connector_daily_usage_bytes_check CHECK (bytes >= 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (connector_id, day)
);
CREATE INDEX IF NOT EXISTS connector_daily_usage_day_idx ON connector_daily_usage (day);
COMMENT ON TABLE connector_daily_usage IS 'Daily counters of connector delivery: items written into memory and their bytes per connector and day (the connector quota)';

-- Enumerations of the tables — extensible constraints (09, memory_check_extend), as [OQ]: a later value is added to
-- the list below, never by an ALTER by hand; values are never removed. With 09 the constraint is extended without
-- recreating it; a test sandbox that applies 17 without 09 (01, 05, 17) gets the same constraint at once, one time. The
-- check of existing rows is a separate statement (memory_check_finish: VALIDATE is not under an exclusive lock)
DO $conn_enums$
DECLARE
    c record;
    ext boolean := to_regprocedure('memory_check_extend(text,text,text,text[])') IS NOT NULL;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('connectors',       'connectors_scope_check',        'scope',      ARRAY['instance', 'person']),
        ('connectors',       'connectors_data_class_check',   'data_class', ARRAY['closed', 'space']),
        ('connectors',       'connectors_status_check',       'status',     ARRAY['draft', 'active', 'paused', 'error', 'needs_reconfirm', 'revoked']),
        ('connector_events', 'connector_events_status_check', 'status',     ARRAY['received', 'queued', 'done', 'failed']),
        ('connector_items',  'connector_items_type_check',    'item_type',  ARRAY['document', 'meeting', 'note', 'entity']),
        ('connector_items',  'connector_items_status_check',  'status',     ARRAY['staged', 'delivering', 'delivered', 'unchanged', 'held', 'skipped', 'failed', 'deleted_at_source']),
        ('connector_runs',   'connector_runs_kind_check',     'kind',       ARRAY['test', 'sync', 'backfill', 'webhook']),
        ('connector_runs',   'connector_runs_status_check',   'status',     ARRAY['queued', 'running', 'ok', 'failed'])
    ) AS v(tbl, con, col, vals) LOOP
        IF ext THEN
            PERFORM memory_check_extend(c.tbl, c.con, c.col, c.vals);
        ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c.tbl::regclass AND conname = c.con) THEN
            EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IN (%s))', c.tbl, c.con, c.col,
                           (SELECT string_agg(quote_literal(x), ',') FROM unnest(c.vals) AS x));
        END IF;
    END LOOP;
END $conn_enums$;
DO $conn_enums_finish$
DECLARE
    c record;
BEGIN
    IF to_regprocedure('memory_check_finish(text,text)') IS NULL THEN RETURN; END IF;
    FOR c IN SELECT * FROM (VALUES ('connectors', 'connectors_scope_check'), ('connectors', 'connectors_data_class_check'),
                                   ('connectors', 'connectors_status_check'), ('connector_events', 'connector_events_status_check'),
                                   ('connector_items', 'connector_items_type_check'), ('connector_items', 'connector_items_status_check'),
                                   ('connector_runs', 'connector_runs_kind_check'), ('connector_runs', 'connector_runs_status_check')) AS v(tbl, con) LOOP
        PERFORM memory_check_finish(c.tbl, c.con);
    END LOOP;
END $conn_enums_finish$;
-- Rights — exactly what the code needs: the gateway alone writes secrets and the daily counters and deletes connectors
-- (admin API, delivery); the workers read secrets (a vendor key to pull) and the counters, claim and update connectors
-- and items but never delete them, and delete only events and runs (cleanup by age)
REVOKE ALL ON connectors, connector_secrets, connector_events, connector_items, connector_runs, connector_daily_usage FROM PUBLIC;
REVOKE ALL ON connectors, connector_secrets, connector_events, connector_items, connector_runs, connector_daily_usage FROM memory_worker, memory_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON connectors, connector_secrets, connector_events, connector_items, connector_runs, connector_daily_usage TO memory_gateway;
GRANT SELECT, INSERT, UPDATE ON connectors, connector_items TO memory_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_events, connector_runs TO memory_worker;
GRANT SELECT ON connector_secrets, connector_daily_usage TO memory_worker;

-- [MU]
-- Usage of the model roles: one row per instance, day (UTC), role, endpoint (host[:port]
-- of the base URL — never a path or a key), model and stage, with the sums of every call. The gateway and the workers add to
-- the sums from memory every 10 s (one upsert per key; concurrent flushes of the two processes add up exactly); the gateway
-- deletes days older than models.usage_retention_days. Tokens and search units are separate columns and are never summed;
-- money is in millionths of the currency of models.prices (a call with usage and no price — unpriced_calls). A database
-- without this table only stops the counting: model calls work. The part references no settings row (17 is applied before
-- the seed).
CREATE TABLE IF NOT EXISTS model_usage_daily (
    instance_id         text   NOT NULL,
    day                 date   NOT NULL,
    role                text   NOT NULL CONSTRAINT model_usage_daily_role_check CHECK (role = ANY (ARRAY['chat', 'embeddings', 'rerank'])),
    endpoint            text   NOT NULL,
    model               text   NOT NULL,
    stage               text   NOT NULL,               -- '' when the call names none (no DEFAULT: drizzle-kit renders DEFAULT '' as invalid code)
    calls               bigint NOT NULL DEFAULT 0,
    failed_calls        bigint NOT NULL DEFAULT 0,
    input_tokens        bigint NOT NULL DEFAULT 0,
    cached_input_tokens bigint NOT NULL DEFAULT 0,
    output_tokens       bigint NOT NULL DEFAULT 0,
    search_units        bigint NOT NULL DEFAULT 0,
    estimated_calls     bigint NOT NULL DEFAULT 0,
    cost_micros         bigint NOT NULL DEFAULT 0,
    unpriced_calls      bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, day, role, endpoint, model, stage)
);
COMMENT ON TABLE model_usage_daily IS 'Usage of the model roles per day (UTC), role, endpoint, model and stage: calls, tokens, search units and cost in millionths of the currency of the prices';
-- both processes call models: they add to the sums; the gateway also reads them and deletes expired days
REVOKE ALL ON model_usage_daily FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON model_usage_daily TO memory_gateway, memory_worker;

-- [SEC]
-- Second factor of the local administrator: one TOTP factor per admin_users login. secret_enc is the secret
-- encrypted with the settings keyring ({kid, ct, iv}; the plaintext names the login, so a row copied to another login does
-- not open). recovery_hashes: lowercase hex SHA-256 of the unused recovery codes, each removed when used. bad_codes and
-- locked_until: five wrong codes lock the factor for 15 minutes. Only the gateway reads or writes the table — the workers
-- get nothing, even after 01 with its GRANT … ON ALL TABLES is applied again (it runs before this file).
-- admin_sessions.second_factor: which factor opened a mem_as_ session (NULL — none); set by the INSERT and never changed,
-- so a stolen session cannot be marked as one with a factor. Without 12 (sandboxes 01 → 05 → 17) that step is skipped
-- with a NOTICE.
CREATE TABLE IF NOT EXISTS admin_totp (
    login              text        PRIMARY KEY REFERENCES admin_users (login) ON DELETE CASCADE,
    instance_id        text        NOT NULL,
    secret_enc         jsonb       NOT NULL CONSTRAINT admin_totp_secret_enc_check CHECK (jsonb_typeof(secret_enc) = 'object'),
    status             text        NOT NULL CONSTRAINT admin_totp_status_check CHECK (status IN ('pending', 'active')),
    last_step          bigint,                  -- last accepted TOTP step: the same code is never taken twice
    pending_expires_at timestamptz,             -- a pending enrolment is confirmed before this time or not at all
    activated_at       timestamptz,
    recovery_hashes    text[]      NOT NULL DEFAULT '{}',
    bad_codes          integer     NOT NULL DEFAULT 0 CONSTRAINT admin_totp_bad_codes_check CHECK (bad_codes >= 0),
    locked_until       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE admin_totp IS 'Second factor (TOTP) of local administrators: encrypted secret, replay step, recovery code hashes, lock-out counter';
REVOKE ALL ON admin_totp FROM PUBLIC, memory_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_totp TO memory_gateway;
CREATE OR REPLACE FUNCTION sec_admin_session_factor_set_once() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $sec_fn$
BEGIN
    IF NEW.second_factor IS DISTINCT FROM OLD.second_factor THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation', CONSTRAINT = 'admin_sessions_second_factor_set_once',
            MESSAGE = 'admin_sessions.second_factor is set when the session is issued and never changed';
    END IF;
    RETURN NEW;
END $sec_fn$;
REVOKE ALL ON FUNCTION sec_admin_session_factor_set_once() FROM PUBLIC;
DO $sec_totp$
BEGIN
    IF to_regclass('admin_sessions') IS NULL THEN
        RAISE NOTICE '17 SEC: no 12, admin_sessions.second_factor skipped';
        RETURN;
    END IF;
    ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS second_factor text;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_sessions_second_factor_check' AND conrelid = 'admin_sessions'::regclass) THEN
        ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_second_factor_check CHECK (second_factor IN ('totp', 'recovery'));
    END IF;
    DROP TRIGGER IF EXISTS admin_sessions_factor_set_once ON admin_sessions;
    CREATE TRIGGER admin_sessions_factor_set_once BEFORE UPDATE OF second_factor ON admin_sessions FOR EACH ROW
        EXECUTE FUNCTION sec_admin_session_factor_set_once();
END $sec_totp$;
-- Audit outbox: an audit event the gateway or a worker could not write to memory_audit is kept here and moved to
-- audit_events by the worker job audit_outbox_drain. id is the event id; payload holds the event columns. The writer roles
-- can only add a row (four columns: occurred_at and created_at are the database's own time, replay_at and rejected_at
-- belong to the drain) and read the queue for health; only the worker deletes a moved row and marks replay_at or a
-- rejection. A compromised gateway can add to the queue but cannot hide, back-date or erase what it spooled. No foreign
-- keys (as [LIM]) and no size limit: a search event with 200 KB of filters must fit.
--
CREATE TABLE IF NOT EXISTS audit_outbox (
    id          uuid        PRIMARY KEY,
    instance_id text        NOT NULL,
    source      text        NOT NULL CONSTRAINT audit_outbox_source_check CHECK (source IN ('gateway', 'workers')),
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    payload     jsonb       NOT NULL CONSTRAINT audit_outbox_payload_check CHECK (jsonb_typeof(payload) = 'object'),
    replay_at   timestamptz,            -- journal time of the event: set once by the drain, kept across retries
    rejected_at timestamptz,            -- the journal refused the row (its data, or its size once a probe insert passed): not taken again
    reject_code text        CONSTRAINT audit_outbox_reject_code_check CHECK (reject_code ~ '^[a-z0-9_]{1,32}$'),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_outbox_pending_idx ON audit_outbox (instance_id, created_at, id) WHERE rejected_at IS NULL;
COMMENT ON TABLE audit_outbox IS 'Audit events not yet written to memory_audit: added by the gateway and the workers, moved and deleted by the worker drain';
-- The privileges are set whole on every apply, in one transaction (a DO block): first everything is revoked from PUBLIC and
-- the writer roles — table and column privileges, also what a repeated GRANT … ON ALL TABLES of 01 gave them (a table-wide
-- INSERT would let the gateway back-date or hide a row, UPDATE would let the worker rewrite one) — then the reviewed grants.
-- A running process sees the old or the new privileges, never the gap between them.
DO $sec_outbox_grants$
BEGIN
    REVOKE ALL ON audit_outbox FROM PUBLIC, memory_gateway, memory_worker;
    GRANT SELECT ON audit_outbox TO memory_gateway, memory_worker;
    GRANT INSERT (id, instance_id, source, payload) ON audit_outbox TO memory_gateway, memory_worker;
    GRANT DELETE ON audit_outbox TO memory_worker;
    GRANT UPDATE (replay_at, rejected_at, reject_code) ON audit_outbox TO memory_worker;
END $sec_outbox_grants$;

-- [ACC]
-- Local accounts: sign-in with an address and a password of the person's own, for an install without a directory.
-- local_credentials: one row per person. password_hash is NULL until the person sets a password through a one-time link;
-- it holds only a scrypt record 'scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>' (the shape of admin_users) and never the password.
-- disabled_at closes the sign-in of the row. auth_links: one-time links in the shape gave the table.
-- Local accounts use the kinds invite (the first password) and reset; magic, confirm and the columns provider_id, subject,
-- address wait for that card. Only the SHA-256 of the whole link, prefix included, is stored; used_at or revoked_at ends a link.
-- This part grants no DELETE on either table: they are the journal of accounts and links. No foreign keys to people (as [LIM]): a row whose
-- person is gone or inactive admits nobody, because every sign-in joins people. Only the gateway reads or writes the
-- tables: the workers get nothing, even after 01 with its GRANT … ON ALL TABLES is applied again (it runs before this file).
-- user_sessions.source gains 'local' through memory_check_extend (09) without recreating the CHECK; a sandbox without 09
-- keeps the base CHECK. Values are never removed.
CREATE TABLE IF NOT EXISTS local_credentials (
    person_id       uuid        PRIMARY KEY,
    instance_id     text        NOT NULL,
    password_hash   text        CONSTRAINT local_credentials_password_hash_check
                                CHECK (password_hash ~ '^scrypt\$[0-9]{1,8}\$[0-9]{1,3}\$[0-9]{1,2}\$[A-Za-z0-9+/]{16,64}={0,2}\$[A-Za-z0-9+/]{32,128}={0,2}$'),
    password_set_at timestamptz,
    disabled_at     timestamptz,
    created_by      text        NOT NULL CONSTRAINT local_credentials_created_by_check CHECK (length(created_by) BETWEEN 1 AND 300),
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT local_credentials_set_check CHECK ((password_hash IS NULL) = (password_set_at IS NULL))
);
COMMENT ON TABLE local_credentials IS 'Local accounts: the scrypt record of a person''s password and the state of the account; the password itself is never stored';
CREATE TABLE IF NOT EXISTS auth_links (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id text NOT NULL,
    kind        text NOT NULL CONSTRAINT auth_links_kind_check CHECK (kind IN ('invite', 'reset', 'magic', 'confirm')),
    token_hash  bytea NOT NULL CONSTRAINT auth_links_token_hash_key UNIQUE
                CONSTRAINT auth_links_token_hash_check CHECK (octet_length(token_hash) = 32),
    person_id   uuid,
    issued_by   uuid,
    issued_at   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    revoked_at  timestamptz,
    provider_id text,
    subject     text,
    address     text,
    CONSTRAINT auth_links_expiry_check CHECK (expires_at > issued_at),
    CONSTRAINT auth_links_confirm_fields_check CHECK (kind = 'confirm' OR (provider_id IS NULL AND subject IS NULL))
);
CREATE INDEX IF NOT EXISTS auth_links_expires_idx ON auth_links (instance_id, expires_at);
CREATE INDEX IF NOT EXISTS auth_links_person_idx ON auth_links (instance_id, person_id) WHERE person_id IS NOT NULL;
-- At most one live link of local accounts per person, whatever the caller does: a second live invite or reset link of the
-- same person is refused (a unique violation). issueLink revokes the earlier live link in the same statement that inserts
-- the new one, so the row it has just revoked does not count. Live here means neither used nor revoked, expired or not:
-- the queries that read or take a link check the expiry, the index does not.
CREATE UNIQUE INDEX IF NOT EXISTS auth_links_one_live_key ON auth_links (instance_id, person_id)
    WHERE kind IN ('invite', 'reset') AND used_at IS NULL AND revoked_at IS NULL;
COMMENT ON TABLE auth_links IS 'One-time links of local accounts (invite, reset): the SHA-256 of the whole link, prefix included, the expiry and how the link ended';
-- The privileges are set whole on every apply, in one transaction (a DO block): first everything is revoked, also what a
-- repeated GRANT … ON ALL TABLES of 01 gave, then the reviewed grants. No DELETE and no TRUNCATE for any role.
DO $acc_grants$
BEGIN
    REVOKE ALL ON local_credentials, auth_links FROM PUBLIC, memory_gateway, memory_worker;
    GRANT SELECT, INSERT, UPDATE ON local_credentials, auth_links TO memory_gateway;
END $acc_grants$;
DO $acc_enums$
BEGIN
    IF to_regclass('user_sessions') IS NULL THEN
        RAISE NOTICE '17 [ACC]: no user_sessions table, the session source is skipped';
        RETURN;
    END IF;
    IF to_regprocedure('memory_check_extend(text,text,text,text[])') IS NOT NULL THEN
        PERFORM memory_check_extend('user_sessions', 'user_sessions_source_check', 'source', ARRAY['local']);
    END IF;
    IF to_regprocedure('memory_check_finish(text,text)') IS NOT NULL THEN
        PERFORM memory_check_finish('user_sessions', 'user_sessions_source_check');
    END IF;
END $acc_enums$;
