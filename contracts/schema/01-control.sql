CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE instances (
    id            text PRIMARY KEY,                       -- 'core', 'foreign-1'
    name          text NOT NULL,
    root_readme   text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
    instance_id  text NOT NULL REFERENCES instances(id),
    category     text NOT NULL CHECK (category IN ('models','retrieval','storage','integrations','processing','limits','search','access','ldap','oidc','oauth','smtp','meetings','open_check','observability','onboarding','topics','approvals')),
    key          text NOT NULL,
    value        jsonb,
    secret       boolean NOT NULL DEFAULT false,
    enc_kid      text,
    required     boolean NOT NULL DEFAULT false,
    description  text,
    default_value jsonb,
    updated_by   uuid,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, category, key),
    CHECK (NOT secret OR value IS NULL OR enc_kid IS NOT NULL)
);
COMMENT ON COLUMN settings.value IS 'For secret = true — {"ct": <base64 AES-256-GCM>, "iv": <base64>}; key = HKDF(PG_APP_PASSWORD, "memory-settings", enc_kid)';

CREATE TABLE people (
    id             uuid PRIMARY KEY,
    login          text NOT NULL UNIQUE,
    employee_id    text UNIQUE NULLS DISTINCT,
    display_name   text NOT NULL,
    department     text,
    manager_login  text,
    role           text,
    instance_id    text NOT NULL REFERENCES instances(id),
    sso_subject    text UNIQUE,
    active         boolean NOT NULL DEFAULT true,
    attrs          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX people_instance_idx ON people (instance_id) WHERE active;

CREATE TABLE services (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL UNIQUE,
    kind         text NOT NULL CHECK (kind IN ('transcriber','chat','meeting_assistant','converter','audio_agent','pipeline','other')),
    obo_allowed  boolean NOT NULL DEFAULT false,
    obo_read     boolean NOT NULL DEFAULT false,
    allowed_ops  text[] NOT NULL DEFAULT '{}',
    tier         text NOT NULL CHECK (tier IN ('T0','T1')),
    instance_id  text NOT NULL REFERENCES instances(id),
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key_prefix      text NOT NULL,
    key_hash        bytea NOT NULL UNIQUE,
    principal_type  text NOT NULL CHECK (principal_type IN ('person','service','system')),
    principal_id    uuid,
    kind            text NOT NULL CHECK (kind IN ('personal','service','extended','system')),
    tier            text NOT NULL CHECK (tier IN ('T0','T1','T2')),
    instance_id     text NOT NULL REFERENCES instances(id),
    ops_override    text[],
    client_label    text,
    client_kind     text CONSTRAINT api_keys_client_kind_check CHECK (client_kind IN ('claude_code','codex','cursor','cloud_other','script')),
    basis           text,                                 -- issue basis of a key for a person: a request or decision number; 'self_service' for self-issued keys
    preview         boolean NOT NULL DEFAULT false,
    net_cidrs       cidr[],
    expires_at      timestamptz,
    created_by      uuid REFERENCES people(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    last_used_at    timestamptz,
    last_used_ip    inet,
    paused_until    timestamptz,
    open_write      boolean NOT NULL DEFAULT false,
    CHECK ((principal_type = 'system') = (principal_id IS NULL)),
    CHECK (kind <> 'personal' OR tier = 'T2'),
    CHECK (kind <> 'extended' OR principal_type = 'person'),
    CHECK (kind <> 'service' OR principal_type = 'service'),
    CONSTRAINT api_keys_client_kind_person CHECK (client_kind IS NULL OR principal_type = 'person'),
    CONSTRAINT api_keys_open_write_extended CHECK (NOT open_write OR kind = 'extended')
);
CREATE INDEX api_keys_prefix_idx ON api_keys (key_prefix) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_principal_idx ON api_keys (principal_type, principal_id);

CREATE TABLE spaces (
    id             uuid PRIMARY KEY,
    slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    kind           text NOT NULL CHECK (kind IN ('personal','team','org','project')),
    name           text NOT NULL,
    description    text,
    owner_id       uuid REFERENCES people(id),
    instance_id    text NOT NULL REFERENCES instances(id),
    default_class  text NOT NULL CHECK (default_class IN ('open','closed')),
    readme         text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    created_by     uuid REFERENCES people(id),
    created_via    text CHECK (created_via IN ('workplace','mcp','admin','org_table')),
    archived_at    timestamptz,
    archived_by    uuid REFERENCES people(id),
    CONSTRAINT spaces_owner_required CHECK (kind = 'org' OR owner_id IS NOT NULL),
    CONSTRAINT spaces_archived_by_check CHECK (archived_by IS NULL OR archived_at IS NOT NULL)
);
CREATE UNIQUE INDEX spaces_one_org_per_instance ON spaces (instance_id) WHERE kind = 'org';
CREATE UNIQUE INDEX spaces_one_personal_per_person ON spaces (owner_id) WHERE kind = 'personal';

CREATE TABLE space_members (
    space_id   uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    person_id  uuid NOT NULL REFERENCES people(id),
    role       text NOT NULL CHECK (role IN ('owner','member')),
    added_by   uuid REFERENCES people(id),
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (space_id, person_id)
);
CREATE INDEX space_members_person_idx ON space_members (person_id);

CREATE TABLE never_open_rules (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL CHECK (kind IN ('domain_tag','entity_kind','space','pattern')),
    pattern     text NOT NULL,
    reason      text NOT NULL,
    instance_id text NOT NULL REFERENCES instances(id),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entities (
    id               uuid PRIMARY KEY,                    -- uuid5('<kind>:<external_system>:<external_id>')
    kind             text NOT NULL CHECK (kind IN ('person','company','deal','contact','task','project','document','other')),
    external_system  text,                                -- 'b24', 'people', 'memory'
    external_id      text,
    display_name     text NOT NULL,
    attrs            jsonb NOT NULL DEFAULT '{}'::jsonb,
    instance_id      text NOT NULL REFERENCES instances(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, external_system, external_id)
);
CREATE INDEX entities_name_search_idx ON entities USING gin (to_tsvector('simple'::regconfig, display_name));

CREATE TABLE embedders (
    id                 text PRIMARY KEY,                  -- e.g. 'text-embedding-3-small-1536'
    model              text NOT NULL,                     -- name on the wire, e.g. 'text-embedding-3-small'
    revision           text,
    quantization       text,                              -- e.g. 'fp16'
    dims               int  NOT NULL,
    query_instruction  text,                              -- 'Instruct: ...\nQuery: '
    max_tokens         int  NOT NULL,                     -- 512
    chunk_tokens       int  NOT NULL DEFAULT 480,
    active             boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    -- embedder profile (the same columns come to an earlier install from 06-embedder-platform.sql, which also
    -- creates the trigger that keeps the vector space of a row unchanged): NULL — a row of an earlier version
    profile            jsonb,
    connection_slot    text NOT NULL DEFAULT 'a' CONSTRAINT embedders_connection_slot_check CHECK (connection_slot IN ('a', 'b')),
    index_kind         text NOT NULL DEFAULT 'halfvec' CONSTRAINT embedders_index_kind_check CHECK (index_kind IN ('halfvec', 'bit')),
    candidate          boolean NOT NULL DEFAULT false,    -- the next model being prepared (at most one)
    activated_at       timestamptz,
    retire_at          timestamptz,                       -- set: kept after a switch until then
    closed_at          timestamptz,                       -- tombstone: a cancelled candidate or a purged old model
    vector_generation  integer NOT NULL DEFAULT 0,        --: part of a reusable vector's identity; raised → stored vectors are not reused
    CONSTRAINT embedders_state_check CHECK (NOT (active AND candidate) AND (closed_at IS NULL OR NOT (active OR candidate)))
);
CREATE UNIQUE INDEX embedders_one_active ON embedders (active) WHERE active;
CREATE UNIQUE INDEX embedders_one_candidate ON embedders (candidate) WHERE candidate;

CREATE TABLE record_locations (
    record_id   uuid PRIMARY KEY,
    class       text NOT NULL CHECK (class IN ('open','closed')),
    space_id    uuid NOT NULL REFERENCES spaces(id),
    type        text NOT NULL,
    owner_id    uuid NOT NULL REFERENCES people(id),
    deleted     boolean NOT NULL DEFAULT false,
    source_hash bytea,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,
    deleted_by    uuid,
    purge_after   timestamptz,
    deleted_batch uuid,
    open_check    jsonb
);
CREATE INDEX record_locations_space_idx ON record_locations (space_id, class);
CREATE INDEX record_locations_owner_hash_idx ON record_locations (owner_id, source_hash) WHERE source_hash IS NOT NULL;
CREATE INDEX record_locations_trash_idx ON record_locations (deleted_batch) WHERE deleted;

CREATE TABLE class_moves (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id     uuid NOT NULL,
    from_class    text NOT NULL CHECK (from_class IN ('open','closed')),
    to_class      text NOT NULL CHECK (to_class IN ('open','closed')),
    requested_by  uuid NOT NULL REFERENCES people(id),
    requested_at  timestamptz NOT NULL DEFAULT now(),
    via           text NOT NULL DEFAULT 'person',
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','copying','verifying','done','failed')),
    error         text,
    finished_at   timestamptz,
    accepted_rules text[],
    confirmation  text,
    accepted_print text,
    accepted_aud  text,
    accepted_space_id uuid,
    accepted_scope text,
    text_only     boolean NOT NULL DEFAULT false,
    CHECK (from_class <> to_class),
    CONSTRAINT class_moves_confirmation_check CHECK (confirmation IS NULL OR confirmation IN ('human_workplace','agent_relayed')),
    CONSTRAINT class_moves_accepted_check CHECK (accepted_rules IS NULL OR (from_class = 'closed' AND to_class = 'open' AND confirmation IS NOT NULL
                                                 AND cardinality(accepted_rules) BETWEEN 1 AND 64 AND NOT ('nda' = ANY (accepted_rules)))),
    CONSTRAINT class_moves_accepted_scope_check CHECK (accepted_scope IS NULL OR accepted_scope IN ('solo','shared')),
    CONSTRAINT class_moves_accepted_whitelist CHECK (accepted_rules IS NULL OR accepted_rules <@
                                                     ARRAY['phone','email_near_name','inn','passport','snils','card','amount','contract_number']::text[]),
    CONSTRAINT class_moves_shared_pii_check CHECK (accepted_scope IS DISTINCT FROM 'shared' OR accepted_rules IS NULL
                                                   OR NOT (accepted_rules && ARRAY['passport','snils','card']::text[])),
    CONSTRAINT class_moves_text_only_check CHECK (NOT text_only OR (from_class = 'closed' AND to_class = 'open' AND confirmation = 'human_workplace'
                                                  AND accepted_print IS NOT NULL)),
    CONSTRAINT class_moves_consent_check CHECK (confirmation IS DISTINCT FROM 'human_workplace' OR (accepted_rules IS NULL AND NOT text_only)
                                                OR (accepted_print IS NOT NULL AND accepted_aud IS NOT NULL AND accepted_space_id IS NOT NULL AND accepted_scope IS NOT NULL))
);
CREATE INDEX class_moves_pending_idx ON class_moves (status) WHERE status IN ('pending','copying','verifying');
CREATE INDEX class_moves_record_requested_idx ON class_moves (record_id, requested_at DESC, id DESC);

CREATE TABLE maintenance_state (
    instance_id  text NOT NULL REFERENCES instances(id),
    key          text NOT NULL,
    value        jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, key)
);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER people_touch   BEFORE UPDATE ON people   FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER entities_touch BEFORE UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO memory_gateway, memory_worker;
GRANT DELETE ON space_members, api_keys, never_open_rules, record_locations, settings TO memory_gateway;
GRANT DELETE ON record_locations, class_moves TO memory_worker;
GRANT CREATE ON DATABASE memory_control TO memory_worker;

CREATE TABLE IF NOT EXISTS record_links (
    id           uuid PRIMARY KEY,
    src_id       uuid NOT NULL REFERENCES record_locations(record_id) ON DELETE CASCADE,
    dst_id       uuid NOT NULL REFERENCES record_locations(record_id) ON DELETE CASCADE,
    src_class    text NOT NULL CHECK (src_class IN ('open','closed')),
    dst_class    text NOT NULL CHECK (dst_class IN ('open','closed')),
    src_key      uuid,
    dst_key      uuid,
    relation     text NOT NULL CHECK (relation IN ('same','refines','replaces','contradicts','resolves','derived_from','echo_of','corrects')),
    status       text NOT NULL CHECK (status IN ('proposed','active','confirmed','rejected','orphaned')),
    method       text NOT NULL CHECK (method IN ('extracted_by_model','stated_by_human','inferred_by_agent')),
    confidence   real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    detail_class text NOT NULL CHECK (detail_class IN ('open','closed')),
    processor    jsonb,
    created_by   uuid REFERENCES people(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    decided_by   uuid REFERENCES people(id),
    decided_at   timestamptz,
    CONSTRAINT record_links_not_self      CHECK (src_id <> dst_id),
    CONSTRAINT record_links_detail_strict CHECK (detail_class = 'closed' OR (src_class = 'open' AND dst_class = 'open')),
    CONSTRAINT record_links_decided       CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
    CONSTRAINT record_links_verdict       CHECK (status NOT IN ('confirmed','rejected') OR decided_by IS NOT NULL),
    CONSTRAINT record_links_model         CHECK (method <> 'extracted_by_model' OR processor IS NOT NULL),
    CONSTRAINT record_links_pair_key      UNIQUE (src_id, dst_id, relation)
);
CREATE INDEX IF NOT EXISTS record_links_dst_idx ON record_links (dst_id);
CREATE INDEX IF NOT EXISTS record_links_keys_idx ON record_links (src_key, dst_key, relation) WHERE src_key IS NOT NULL AND dst_key IS NOT NULL;

CREATE OR REPLACE FUNCTION record_links_ends_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE endpoint record; actual_src text; actual_dst text;
BEGIN
    FOR endpoint IN SELECT record_id, class FROM record_locations
                    WHERE record_id IN (NEW.src_id, NEW.dst_id) ORDER BY record_id FOR SHARE LOOP
        IF endpoint.record_id = NEW.src_id THEN actual_src := endpoint.class; END IF;
        IF endpoint.record_id = NEW.dst_id THEN actual_dst := endpoint.class; END IF;
    END LOOP;
    IF actual_src IS NULL OR actual_dst IS NULL THEN
        RAISE EXCEPTION 'link end is missing from the locators' USING ERRCODE = '23503';
    END IF;
    IF NEW.src_class IS DISTINCT FROM actual_src OR NEW.dst_class IS DISTINCT FROM actual_dst THEN
        RAISE EXCEPTION 'link end classes do not match the locators' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS record_links_ends_match ON record_links;
CREATE TRIGGER record_links_ends_match BEFORE INSERT OR UPDATE OF src_id, dst_id, src_class, dst_class
    ON record_links FOR EACH ROW EXECUTE FUNCTION record_links_ends_match();

CREATE OR REPLACE FUNCTION record_links_detail_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.detail_class = 'closed' AND NEW.detail_class = 'open' THEN
        RAISE EXCEPTION 'the class of link details cannot be lowered' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS record_links_detail_monotonic ON record_links;
CREATE TRIGGER record_links_detail_monotonic BEFORE UPDATE ON record_links
    FOR EACH ROW EXECUTE FUNCTION record_links_detail_monotonic();
DROP TRIGGER IF EXISTS record_links_touch ON record_links;
CREATE TRIGGER record_links_touch BEFORE UPDATE ON record_links FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

REVOKE UPDATE, DELETE ON record_links FROM memory_gateway;
GRANT SELECT, INSERT ON record_links TO memory_gateway;
GRANT UPDATE (status, decided_by, decided_at, updated_at) ON record_links TO memory_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON record_links TO memory_worker;
