CREATE TABLE IF NOT EXISTS org_units (
    id           uuid PRIMARY KEY,
    code         text NOT NULL,
    name         text NOT NULL,
    parent_id    uuid REFERENCES org_units(id),
    instance_id  text NOT NULL REFERENCES instances(id),
    active       boolean NOT NULL DEFAULT true,
    attrs        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (instance_id, code)
);
CREATE INDEX IF NOT EXISTS org_units_parent_idx ON org_units (parent_id);

CREATE TABLE IF NOT EXISTS person_org_units (
    person_id    uuid NOT NULL REFERENCES people(id),
    org_unit_id  uuid NOT NULL REFERENCES org_units(id),
    relation     text NOT NULL CHECK (relation IN ('member','head','deputy')),
    source       text NOT NULL DEFAULT 'org_table' CHECK (source IN ('org_table','directory','manual')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, org_unit_id, relation)
);
CREATE INDEX IF NOT EXISTS person_org_units_unit_idx ON person_org_units (org_unit_id);

CREATE TABLE IF NOT EXISTS person_identities (
    system       text NOT NULL CHECK (system IN ('ad','bitrix','sap','telegram','hub','sso','other')),
    external_id  text NOT NULL,
    person_id    uuid NOT NULL REFERENCES people(id),
    verified     boolean NOT NULL DEFAULT false,
    verified_by  uuid REFERENCES people(id),
    verified_at  timestamptz,
    verified_label text,
    source       text,
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system, external_id)
);
CREATE INDEX IF NOT EXISTS person_identities_person_idx ON person_identities (person_id);

CREATE TABLE IF NOT EXISTS roles (
    code           text PRIMARY KEY,
    name           text NOT NULL,
    description    text,
    origin         text NOT NULL CHECK (origin IN ('memory','hub','service','source_system')),
    memory_effect  text NOT NULL CHECK (memory_effect IN ('none','base','space_owner','space_reader','admin','audit')),
    derived        boolean NOT NULL DEFAULT false,
    active         boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS role_grants (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id     uuid NOT NULL REFERENCES people(id),
    role_code     text NOT NULL REFERENCES roles(code),
    actions       text[] NOT NULL DEFAULT '{view}',
    scope_kind    text NOT NULL CHECK (scope_kind IN ('own','org_unit','org_branch','company','space','objects','catalog')),
    scope_ref     text,
    basis_source  text NOT NULL CHECK (basis_source IN ('org_table','directory','bitrix','sap','request','manual')),
    basis_ref     text,
    approved_by   text,
    approved_at   timestamptz,
    valid_from    timestamptz NOT NULL DEFAULT now(),
    valid_to      timestamptz,
    revoked_at    timestamptz,
    revoked_by    uuid REFERENCES people(id),
    instance_id   text NOT NULL REFERENCES instances(id),
    created_by    uuid REFERENCES people(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    CHECK ((scope_kind IN ('org_unit','org_branch','space','objects')) = (scope_ref IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS role_grants_person_idx ON role_grants (person_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS role_grants_expiry_idx ON role_grants (valid_to) WHERE revoked_at IS NULL AND valid_to IS NOT NULL;

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS org_unit_id uuid REFERENCES org_units(id);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_per_org_unit ON spaces (org_unit_id) WHERE org_unit_id IS NOT NULL;

ALTER TABLE space_members ADD COLUMN IF NOT EXISTS source     text NOT NULL DEFAULT 'manual';
ALTER TABLE space_members ADD COLUMN IF NOT EXISTS grant_id   uuid REFERENCES role_grants(id) ON DELETE CASCADE;
ALTER TABLE space_members ADD COLUMN IF NOT EXISTS expires_at timestamptz;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'space_members_source_check') THEN
        ALTER TABLE space_members ADD CONSTRAINT space_members_source_check CHECK (source IN ('manual','org','grant','group'));
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'space_members_role_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%reader%') THEN
        ALTER TABLE space_members DROP CONSTRAINT space_members_role_check;
        ALTER TABLE space_members ADD CONSTRAINT space_members_role_check CHECK (role IN ('owner','member','reader'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS space_members_derived_idx ON space_members (person_id, source) WHERE source <> 'manual';

CREATE OR REPLACE VIEW space_members_effective AS
    SELECT m.space_id, m.person_id, m.role, m.source, m.grant_id, m.expires_at
    FROM space_members m
    JOIN people p ON p.id = m.person_id AND p.active
    WHERE m.expires_at IS NULL OR m.expires_at > now();

CREATE OR REPLACE FUNCTION space_members_no_personal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM spaces s WHERE s.id = NEW.space_id AND s.kind = 'personal') THEN
        RAISE EXCEPTION 'participation in a personal space is not assigned: only its owner reads it';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS space_members_no_personal ON space_members;
CREATE TRIGGER space_members_no_personal BEFORE INSERT OR UPDATE ON space_members FOR EACH ROW EXECUTE FUNCTION space_members_no_personal();
DELETE FROM space_members m USING spaces s WHERE s.id = m.space_id AND s.kind = 'personal';

ALTER TABLE spaces ALTER COLUMN owner_id DROP NOT NULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spaces_owner_required') THEN
        ALTER TABLE spaces ADD CONSTRAINT spaces_owner_required CHECK (kind = 'org' OR owner_id IS NOT NULL);
    END IF;
END $$;

ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_value jsonb;
ALTER TABLE person_identities ADD COLUMN IF NOT EXISTS verified_label text;

CREATE TABLE IF NOT EXISTS admin_users (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    login          text NOT NULL UNIQUE,
    password_hash  text NOT NULL,                         -- 'scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>'
    person_id      uuid REFERENCES people(id),
    instance_id    text NOT NULL REFERENCES instances(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    last_login_at  timestamptz,
    sessions_revoked_at timestamptz,
    disabled_at    timestamptz
);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz;

INSERT INTO roles (code, name, description, origin, memory_effect, derived) VALUES
 ('employee',            'Employee',                          'An active person in the org table: their own records, Company knowledge, their teams and their department space', 'memory', 'base', true),
 ('unit_head',           'Department head',         'Owns their department space; cannot see employees’ personal spaces', 'memory', 'space_owner', true),
 ('unit_deputy',         'Deputy head',           'A department space member; owner rights require an explicit grant', 'memory', 'base', true),
 ('company_management',  'Company management',               'Reads department spaces across the company, by explicit assignment only', 'hub', 'space_reader', false),
 ('branch_reader',       'Department branch reader',         'Reads child departments’ spaces only through an explicit grant', 'memory', 'space_reader', false),
 ('memory_admin',        'Memory administrator',               'People, org units, services, keys, spaces, grants, settings and unprocessed records — without reading record content', 'memory', 'admin', false),
 ('security_auditor',    'Security auditor',                         'Audit log: facts without record content', 'memory', 'audit', false),
 ('org_curator',         'Company knowledge curator',      'Reviews Company knowledge (org) records: confirms, returns to the project or deletes them. Owns org through a grant scoped only to org. Assigned by a memory administrator', 'memory', 'space_owner', false),
 ('domain_owner',        'Domain owner',                    'Effect deferred: opening another person’s domain record requires domain tags in the locator', 'memory', 'none', false),
 ('champion',            'Champion',                            'Access to the company portal’s skills directory, with no additional access to memory data', 'hub', 'none', false),
 ('effect_owner',        'Outcome owner',            'Enter department metrics in the company portal', 'hub', 'none', false),
 ('pm_kam',              'Project manager / key account manager',                           'Projects and clients — the rights of the source systems; in the memory — project spaces with explicit membership', 'source_system', 'none', false),
 ('legal_specialist',    'Legal / domain specialist',      'Specialist skills, with work permissions managed in the source systems', 'hub', 'none', false),
 ('tender_decision',     'Tender decision-maker',                        'Service role for making decisions in the tender process', 'service', 'none', false),
 ('office_booking_user', 'Office booking user', 'Access to the booking service', 'service', 'none', false),
 ('travel_assistant',    'Travel assistant recipient', 'Access by request. The link to the messaging account ID is stored in person_identities', 'service', 'none', false),
 ('contract_digest',     'Contract digest recipient', 'Separate business access to the service, with no automatic grant for management or administrators', 'service', 'none', false)
ON CONFLICT (code) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON org_units, person_org_units, person_identities, roles, role_grants TO memory_gateway, memory_worker;
GRANT DELETE ON person_org_units, person_identities TO memory_gateway;
GRANT SELECT ON space_members_effective TO memory_gateway, memory_worker;
GRANT SELECT, INSERT, UPDATE ON admin_users TO memory_gateway;

DROP TRIGGER IF EXISTS org_units_touch ON org_units;
CREATE TRIGGER org_units_touch BEFORE UPDATE ON org_units FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS basis text;

ALTER TABLE people ADD COLUMN IF NOT EXISTS employee_id text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_employee_id_key') THEN
        ALTER TABLE people ADD CONSTRAINT people_employee_id_key UNIQUE NULLS DISTINCT (employee_id);
    END IF;
END $$;
ALTER TABLE record_locations ADD COLUMN IF NOT EXISTS source_hash bytea;
CREATE INDEX IF NOT EXISTS record_locations_owner_hash_idx ON record_locations (owner_id, source_hash) WHERE source_hash IS NOT NULL;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS preview boolean NOT NULL DEFAULT false;
ALTER TABLE record_locations ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE record_locations SET created_at = updated_at WHERE created_at IS NULL;
ALTER TABLE record_locations ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE record_locations ALTER COLUMN created_at SET NOT NULL;

DELETE FROM settings WHERE category = 'integrations' AND key = 'converter_key';
DELETE FROM settings WHERE category = 'integrations' AND key = 'converter_export_profile';

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'services' AND column_name = 'obo_read') THEN
        ALTER TABLE services ADD COLUMN obo_read boolean NOT NULL DEFAULT false;
        UPDATE services SET obo_read = true
         WHERE obo_allowed AND kind <> 'transcriber' AND allowed_ops && ARRAY['search','read','list','original']::text[];
    END IF;
END $$;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_ip inet;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS paused_until timestamptz;

ALTER TABLE services ADD COLUMN IF NOT EXISTS write_space_id uuid REFERENCES spaces(id);

ALTER TABLE people ADD COLUMN IF NOT EXISTS notebook boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS maintenance_state (
    instance_id  text NOT NULL REFERENCES instances(id),
    key          text NOT NULL,
    value        jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, key)
);
GRANT SELECT, INSERT, UPDATE ON maintenance_state TO memory_gateway, memory_worker;

ALTER TABLE record_locations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE record_locations ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE record_locations ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE record_locations ADD COLUMN IF NOT EXISTS deleted_batch uuid;
CREATE INDEX IF NOT EXISTS record_locations_trash_idx ON record_locations (deleted_batch) WHERE deleted;

UPDATE api_keys SET expires_at = now() + interval '90 days'
 WHERE kind IN ('personal', 'extended') AND expires_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS user_sessions (
    id            uuid PRIMARY KEY,
    token_hash    bytea NOT NULL UNIQUE,
    person_id     uuid NOT NULL REFERENCES people(id),
    instance_id   text NOT NULL REFERENCES instances(id),
    source        text NOT NULL CHECK (source IN ('ldap','oidc','test')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    ended_at      timestamptz,
    ended_reason  text CHECK (ended_reason IN ('logout','ended_by_person','end_all','deactivated','expired','hook_off','idle','config_changed')),
    ip            inet,
    user_agent    text,
    CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS user_sessions_person_idx ON user_sessions (person_id) WHERE ended_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON user_sessions TO memory_gateway;

DO $$
DECLARE
    c record;
BEGIN
    FOR c IN SELECT * FROM (VALUES
        ('settings', 'settings_category_check', 'category',
         ARRAY['models','retrieval','storage','integrations','processing','limits','search','access','ldap','oidc','oauth','smtp','meetings','open_check','observability','onboarding','topics','approvals']),
        ('user_sessions', 'user_sessions_ended_reason_check', 'ended_reason',
         ARRAY['logout','ended_by_person','end_all','deactivated','expired','hook_off','idle','config_changed'])) v(tbl, name, col, want) LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = c.tbl::regclass AND conname = c.name
                   AND pg_get_constraintdef(oid) LIKE ALL (ARRAY(SELECT '%''' || w || '''%' FROM unnest(c.want) w))) THEN
            CONTINUE;
        END IF;
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', c.tbl, c.name);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IN (%s))', c.tbl, c.name, c.col,
                       (SELECT string_agg(quote_literal(w), ',') FROM unnest(c.want) w));
    END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS mail_outbox (
    id              uuid PRIMARY KEY,
    instance_id     text NOT NULL REFERENCES instances(id),
    kind            text NOT NULL CHECK (kind IN ('test','approval','meeting_delete','curator_digest','meeting_new','custody')),
    to_address      text NOT NULL,
    subject         text NOT NULL,
    body_text       text NOT NULL,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
    attempts        int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error_code text,
    last_error      text,
    dedupe_key      text,
    created_by      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    message_id      text,
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mail_outbox_due_idx ON mail_outbox (next_attempt_at) WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS mail_outbox_created_idx ON mail_outbox (instance_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mail_outbox_dedupe_idx ON mail_outbox (instance_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
GRANT SELECT, INSERT, UPDATE ON mail_outbox TO memory_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_outbox TO memory_worker;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_outbox_kind_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%custody%') THEN
        ALTER TABLE mail_outbox DROP CONSTRAINT mail_outbox_kind_check;
        ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_kind_check
          CHECK (kind IN ('test','approval','meeting_delete','curator_digest','meeting_new','custody'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS upload_tickets (
    id           uuid PRIMARY KEY,
    token_hash   bytea NOT NULL UNIQUE,
    instance_id  text NOT NULL REFERENCES instances(id),
    person_id    uuid NOT NULL REFERENCES people(id),
    key_id       uuid NOT NULL REFERENCES api_keys(id),
    channel      text NOT NULL CHECK (channel IN ('agent','script')),
    meeting      jsonb NOT NULL,
    max_bytes    integer NOT NULL CHECK (max_bytes > 0),
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    record_id    uuid,
    CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS upload_tickets_expires_idx ON upload_tickets (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON upload_tickets TO memory_gateway;

CREATE TABLE IF NOT EXISTS deletion_requests (
    id            uuid PRIMARY KEY,
    instance_id   text NOT NULL REFERENCES instances(id),
    record_id     uuid NOT NULL,
    owner_id      uuid NOT NULL REFERENCES people(id),
    requester_id  uuid NOT NULL REFERENCES people(id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    declined_at   timestamptz,
    UNIQUE (record_id, requester_id),
    CHECK (owner_id <> requester_id)
);
CREATE INDEX IF NOT EXISTS deletion_requests_owner_idx ON deletion_requests (owner_id);
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS kept_at timestamptz;
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS kept_by text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deletion_requests_reason_check') THEN
        ALTER TABLE deletion_requests ADD CONSTRAINT deletion_requests_reason_check CHECK (reason IS NULL OR reason IN ('by_mistake','private','no_consent','other'));
    END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON deletion_requests TO memory_gateway;
GRANT SELECT, DELETE ON deletion_requests TO memory_worker;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spaces_kind_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%project%') THEN
        ALTER TABLE spaces DROP CONSTRAINT spaces_kind_check;
        ALTER TABLE spaces ADD CONSTRAINT spaces_kind_check CHECK (kind IN ('personal','team','org','project'));
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'space_members_source_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%group%') THEN
        ALTER TABLE space_members DROP CONSTRAINT space_members_source_check;
        ALTER TABLE space_members ADD CONSTRAINT space_members_source_check CHECK (source IN ('manual','org','grant','group'));
    END IF;
END $$;
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS created_by  uuid REFERENCES people(id);
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS created_via text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spaces_created_via_check') THEN
        ALTER TABLE spaces ADD CONSTRAINT spaces_created_via_check CHECK (created_via IN ('workplace','mcp','admin','org_table'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS spaces_created_idx ON spaces (instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS spaces_created_by_idx ON spaces (created_by) WHERE created_by IS NOT NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS space_groups (
    id               uuid PRIMARY KEY,
    space_id         uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    group_dn         text NOT NULL,
    group_key        text NOT NULL,
    group_guid       text,
    display_name     text NOT NULL,
    role             text NOT NULL DEFAULT 'member' CHECK (role IN ('member','reader')),
    added_by         uuid REFERENCES people(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','missing','too_large','error')),
    members_seen     integer CHECK (members_seen >= 0),
    members_matched  integer CHECK (members_matched >= 0),
    synced_at        timestamptz,
    missing_since    timestamptz,
    last_error       text,
    UNIQUE (space_id, group_key)
);
CREATE INDEX IF NOT EXISTS space_groups_key_idx ON space_groups (group_key);

CREATE TABLE IF NOT EXISTS directory_group_members (
    instance_id  text NOT NULL REFERENCES instances(id),
    group_key    text NOT NULL,
    person_id    uuid NOT NULL REFERENCES people(id),
    source       text NOT NULL CHECK (source IN ('sync','login')),
    seen_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, group_key, person_id)
);
CREATE INDEX IF NOT EXISTS directory_group_members_person_idx ON directory_group_members (person_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON space_groups, directory_group_members TO memory_gateway;
GRANT SELECT ON space_groups, directory_group_members TO memory_worker;

CREATE TABLE IF NOT EXISTS space_invites (
    space_id      uuid NOT NULL,
    login         text NOT NULL CHECK (login = lower(login) AND char_length(login) BETWEEN 3 AND 254),
    instance_id   text NOT NULL REFERENCES instances(id),
    role          text NOT NULL DEFAULT 'member' CHECK (role IN ('member','reader')),
    display_name  text,
    department    text,
    invited_by    uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    PRIMARY KEY (space_id, login)
);
CREATE INDEX IF NOT EXISTS space_invites_login_idx ON space_invites (login);
GRANT SELECT, INSERT, UPDATE, DELETE ON space_invites TO memory_gateway;
GRANT SELECT, DELETE ON space_invites TO memory_worker;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS client_kind text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_client_kind_check' AND conrelid = 'api_keys'::regclass) THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_client_kind_check CHECK (client_kind IN ('claude_code','codex','cursor','cloud_other','script'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_client_kind_person' AND conrelid = 'api_keys'::regclass) THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_client_kind_person CHECK (client_kind IS NULL OR principal_type = 'person');
    END IF;
END $$;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS open_write boolean NOT NULL DEFAULT false;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_open_write_extended' AND conrelid = 'api_keys'::regclass) THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_open_write_extended CHECK (NOT open_write OR kind = 'extended');
    END IF;
END $$;

ALTER TABLE record_locations ADD COLUMN IF NOT EXISTS open_check jsonb;
ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'person';

ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS accepted_rules text[];
ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS confirmation text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_moves_confirmation_check' AND conrelid = 'class_moves'::regclass) THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_confirmation_check CHECK (confirmation IS NULL OR confirmation IN ('human_workplace','agent_relayed'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_moves_accepted_check' AND conrelid = 'class_moves'::regclass) THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_accepted_check CHECK (accepted_rules IS NULL OR (from_class = 'closed' AND to_class = 'open' AND confirmation IS NOT NULL
                                                 AND cardinality(accepted_rules) BETWEEN 1 AND 64 AND NOT ('nda' = ANY (accepted_rules))));
    END IF;
END $$;

ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS accepted_print text;
ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS accepted_aud text;
ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS accepted_space_id uuid;
ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS accepted_scope text;
ALTER TABLE class_moves ADD COLUMN IF NOT EXISTS text_only boolean NOT NULL DEFAULT false;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_moves_accepted_scope_check' AND conrelid = 'class_moves'::regclass) THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_accepted_scope_check CHECK (accepted_scope IS NULL OR accepted_scope IN ('solo','shared'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_moves_accepted_whitelist' AND conrelid = 'class_moves'::regclass) THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_accepted_whitelist CHECK (accepted_rules IS NULL OR accepted_rules <@
            ARRAY['phone','email_near_name','inn','passport','snils','card','amount','contract_number',
                  'phone_intl','date_of_birth','bank_account','national_id']::text[]) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_moves_shared_pii_check' AND conrelid = 'class_moves'::regclass) THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_shared_pii_check CHECK (accepted_scope IS DISTINCT FROM 'shared' OR accepted_rules IS NULL
            OR NOT (accepted_rules && ARRAY['passport','snils','card','bank_account','national_id']::text[]));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_moves_text_only_check' AND conrelid = 'class_moves'::regclass) THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_text_only_check CHECK (NOT text_only OR (from_class = 'closed' AND to_class = 'open'
            AND confirmation = 'human_workplace' AND accepted_print IS NOT NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_moves_consent_check' AND conrelid = 'class_moves'::regclass) THEN
        IF EXISTS (SELECT 1 FROM class_moves WHERE status IN ('pending','copying','verifying') AND confirmation = 'human_workplace'
                      AND accepted_rules IS NOT NULL AND accepted_print IS NULL) THEN
            RAISE NOTICE 'class_moves_consent_check: earlier shows by a person still in progress — % (pending ones the worker will reject with “a new author consent is needed”, started ones it will finish); the constraint will be added the next time the schema is applied',
                (SELECT count(*) FROM class_moves WHERE status IN ('pending','copying','verifying') AND confirmation = 'human_workplace'
                    AND accepted_rules IS NOT NULL AND accepted_print IS NULL);
        ELSE
            ALTER TABLE class_moves ADD CONSTRAINT class_moves_consent_check CHECK (confirmation IS DISTINCT FROM 'human_workplace'
                OR (accepted_rules IS NULL AND NOT text_only)
                OR (accepted_print IS NOT NULL AND accepted_aud IS NOT NULL AND accepted_space_id IS NOT NULL AND accepted_scope IS NOT NULL)) NOT VALID;
        END IF;
    END IF;
END $$;
-- International rules of the open check (pack intl): the author may also show phone_intl and date_of_birth, and
-- bank_account and national_id only where the author alone sees the record (as passport). A narrower constraint of an
-- earlier version — and the one of 01-control.sql on a fresh install — is replaced here: the wider one is added NOT VALID
-- next to it, the old one is dropped and the new one takes its name, in one transaction. The whitelist only widens, so
-- old rows stay valid (the VALIDATE below checks them); the shared-scope ban narrows, but an old row cannot carry the two
-- new names (the old whitelist refused them) — it is validated here, and a hand-made row outside it only leaves the
-- constraint NOT VALID with a notice. A re-run finds the new names in the definitions and alters nothing. The schema is
-- applied before the processes start, so the gateway that accepts the new names never runs against the old ban.
DO $$
DECLARE def text;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'class_moves_accepted_whitelist' AND conrelid = 'class_moves'::regclass;
    IF def IS NOT NULL AND position('''national_id''' IN def) = 0 THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_accepted_whitelist_intl CHECK (accepted_rules IS NULL OR accepted_rules <@
            ARRAY['phone','email_near_name','inn','passport','snils','card','amount','contract_number',
                  'phone_intl','date_of_birth','bank_account','national_id']::text[]) NOT VALID;
        ALTER TABLE class_moves DROP CONSTRAINT class_moves_accepted_whitelist;
        ALTER TABLE class_moves RENAME CONSTRAINT class_moves_accepted_whitelist_intl TO class_moves_accepted_whitelist;
    END IF;
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'class_moves_shared_pii_check' AND conrelid = 'class_moves'::regclass;
    IF def IS NOT NULL AND position('''national_id''' IN def) = 0 THEN
        ALTER TABLE class_moves ADD CONSTRAINT class_moves_shared_pii_check_intl CHECK (accepted_scope IS DISTINCT FROM 'shared' OR accepted_rules IS NULL
            OR NOT (accepted_rules && ARRAY['passport','snils','card','bank_account','national_id']::text[])) NOT VALID;
        ALTER TABLE class_moves DROP CONSTRAINT class_moves_shared_pii_check;
        ALTER TABLE class_moves RENAME CONSTRAINT class_moves_shared_pii_check_intl TO class_moves_shared_pii_check;
        BEGIN
            ALTER TABLE class_moves VALIDATE CONSTRAINT class_moves_shared_pii_check;
        EXCEPTION WHEN check_violation THEN
            RAISE NOTICE 'class_moves_shared_pii_check: old rows accept bank_account or national_id in a shared scope — review them by hand';
        END;
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS class_moves_record_requested_idx ON class_moves (record_id, requested_at DESC, id DESC);
DO $$ BEGIN
    ALTER TABLE class_moves VALIDATE CONSTRAINT class_moves_accepted_whitelist;
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'class_moves_accepted_whitelist: old rows outside the list — sort out by hand';
END $$;

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

CREATE TABLE IF NOT EXISTS action_plans (
    id            uuid PRIMARY KEY,
    instance_id   text NOT NULL REFERENCES instances(id),
    person_id     uuid NOT NULL REFERENCES people(id),
    key_id        uuid,
    created_via   text NOT NULL CHECK (created_via IN ('mcp','workplace')),
    op            text NOT NULL CHECK (op IN ('delete','close','promote','move_space','purge','correct_bulk')),
    params        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object'),
    apply_via     text NOT NULL CHECK (apply_via IN ('mcp','workplace')),
    apply_reason  text CHECK (apply_reason IN ('over_threshold','many_spaces','workplace_only_op','created_in_workplace','script_key','preview_key')),
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applying','applied','partially_applied','expired','cancelled')),
    items_total   int NOT NULL CHECK (items_total >= 1),
    spaces_total  int NOT NULL CHECK (spaces_total >= 1),
    cascade_total int NOT NULL DEFAULT 0 CHECK (cascade_total >= 0),
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    started_at    timestamptz,
    applied_at    timestamptz,
    result        jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    CONSTRAINT action_plans_expiry CHECK (expires_at > created_at),
    CONSTRAINT action_plans_no_query CHECK (
      NOT (params ?| ARRAY['query','query_sha256']) AND
      NOT (COALESCE(params->'criteria','{}'::jsonb) ?| ARRAY['query','query_sha256']))
);
CREATE INDEX IF NOT EXISTS action_plans_person_idx ON action_plans (person_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS action_plans_cleanup_idx ON action_plans (expires_at);
CREATE INDEX IF NOT EXISTS action_plans_key_pending_idx ON action_plans (key_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS action_plan_items (
    plan_id     uuid NOT NULL REFERENCES action_plans(id) ON DELETE CASCADE,
    ord         int NOT NULL CHECK (ord >= 0),
    record_id   uuid NOT NULL,
    class       text NOT NULL CHECK (class IN ('open','closed')),
    space_id    uuid NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    effect      jsonb NOT NULL CHECK (jsonb_typeof(effect) = 'object'),
    status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','excluded','done','skipped')),
    reason      text CHECK (reason IN ('changed','no_rights','gone','in_progress','open_check','never_open','expired','failed','archived','extended_open','derived_wider')),
    done_at     timestamptz,
    applied_via text CHECK (applied_via IN ('mcp','workplace')),
    PRIMARY KEY (plan_id, ord),
    UNIQUE (plan_id, record_id)
);
ALTER TABLE action_plan_items ADD COLUMN IF NOT EXISTS applied_via text;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plan_items_applied_via_check' AND conrelid = 'action_plan_items'::regclass) THEN
        ALTER TABLE action_plan_items ADD CONSTRAINT action_plan_items_applied_via_check CHECK (applied_via IN ('mcp','workplace'));
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plans_op_check' AND conrelid = 'action_plans'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%correct_bulk%') THEN
        ALTER TABLE action_plans DROP CONSTRAINT IF EXISTS action_plans_op_check;
        ALTER TABLE action_plans ADD CONSTRAINT action_plans_op_check CHECK (op IN ('delete','close','promote','move_space','purge','correct_bulk'));
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plan_items_reason_check' AND conrelid = 'action_plan_items'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%extended_open%') THEN
        ALTER TABLE action_plan_items DROP CONSTRAINT IF EXISTS action_plan_items_reason_check;
        ALTER TABLE action_plan_items ADD CONSTRAINT action_plan_items_reason_check
            CHECK (reason IN ('changed','no_rights','gone','in_progress','open_check','never_open','expired','failed','archived','extended_open'));
    END IF;
END $$;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_plan_items_reason_check' AND conrelid = 'action_plan_items'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%derived_wider%') THEN
        ALTER TABLE action_plan_items DROP CONSTRAINT IF EXISTS action_plan_items_reason_check;
        ALTER TABLE action_plan_items ADD CONSTRAINT action_plan_items_reason_check
            CHECK (reason IN ('changed','no_rights','gone','in_progress','open_check','never_open','expired','failed','archived','extended_open','derived_wider'));
    END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON action_plans, action_plan_items TO memory_gateway;
GRANT SELECT, DELETE ON action_plans, action_plan_items TO memory_worker;


ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS auth_method text NOT NULL DEFAULT 'api_key';
ALTER TABLE api_keys ALTER COLUMN key_hash DROP NOT NULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_auth_method_check' AND conrelid = 'api_keys'::regclass) THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_auth_method_check CHECK (auth_method IN ('api_key','oauth'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_oauth_grant_check' AND conrelid = 'api_keys'::regclass) THEN
        ALTER TABLE api_keys ADD CONSTRAINT api_keys_oauth_grant_check CHECK (
            (auth_method = 'api_key' AND key_hash IS NOT NULL) OR
            (auth_method = 'oauth' AND key_hash IS NULL AND principal_type = 'person' AND principal_id IS NOT NULL
             AND kind = 'personal' AND tier = 'T2' AND NOT preview AND key_prefix = 'oauth'
             AND client_kind IS NOT NULL AND client_kind IN ('claude_code','codex','cursor','cloud_other')
             AND expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= created_at + interval '90 days'));
    END IF;
END $$;

CREATE OR REPLACE FUNCTION oauth_grant_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.auth_method = 'oauth' AND
       (ROW(NEW.id,NEW.auth_method,NEW.principal_type,NEW.principal_id,NEW.instance_id,NEW.kind,NEW.tier,NEW.client_kind,NEW.created_at,NEW.expires_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.auth_method,OLD.principal_type,OLD.principal_id,OLD.instance_id,OLD.kind,OLD.tier,OLD.client_kind,OLD.created_at,OLD.expires_at)
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
        RAISE EXCEPTION 'OAuth grant identity, lifetime and revocation are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS api_keys_oauth_immutable ON api_keys;
CREATE TRIGGER api_keys_oauth_immutable BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION oauth_grant_immutable();

CREATE TABLE IF NOT EXISTS oauth_connections (
    id           uuid PRIMARY KEY REFERENCES api_keys(id),
    instance_id  text NOT NULL REFERENCES instances(id),
    issuer       text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 2048 AND issuer = btrim(issuer)),
    subject      text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255 AND subject = btrim(subject)),
    client_id    text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255 AND client_id = btrim(client_id)),
    session_id   text NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 255 AND session_id = btrim(session_id)),
    person_id    uuid NOT NULL REFERENCES people(id),
    resource_url text NOT NULL CHECK (char_length(resource_url) BETWEEN 1 AND 2048 AND resource_url = btrim(resource_url)),
    CONSTRAINT oauth_connections_session_key UNIQUE (instance_id, issuer, subject, client_id, session_id)
);
CREATE INDEX IF NOT EXISTS oauth_connections_person_idx ON oauth_connections (instance_id, person_id, id);

CREATE OR REPLACE FUNCTION oauth_connection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'OAuth connection identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = NEW.id AND k.auth_method = 'oauth'
                    AND k.principal_type = 'person' AND k.principal_id = NEW.person_id AND k.instance_id = NEW.instance_id) THEN
        RAISE EXCEPTION 'OAuth connection must match its OAuth grant' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS oauth_connections_guard ON oauth_connections;
CREATE TRIGGER oauth_connections_guard BEFORE INSERT OR UPDATE ON oauth_connections FOR EACH ROW EXECUTE FUNCTION oauth_connection_guard();
GRANT SELECT, INSERT, UPDATE ON oauth_connections TO memory_gateway;
GRANT SELECT ON oauth_connections TO memory_worker;

CREATE TABLE IF NOT EXISTS space_moves (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    record_id     uuid NOT NULL REFERENCES record_locations(record_id) ON DELETE CASCADE,
    from_space_id uuid NOT NULL,
    to_space_id   uuid NOT NULL,
    from_audience text CHECK (from_audience IN ('space','people')),
    actor_id      uuid,
    op            text NOT NULL CHECK (op IN ('promote','move_space','return')),
    at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT space_moves_changed CHECK (from_space_id <> to_space_id)
);
CREATE INDEX IF NOT EXISTS space_moves_record_idx ON space_moves (record_id, at DESC);
GRANT SELECT, INSERT ON space_moves TO memory_gateway, memory_worker;

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES people(id);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'spaces_archived_by_check' AND conrelid = 'spaces'::regclass) THEN
        ALTER TABLE spaces ADD CONSTRAINT spaces_archived_by_check CHECK (archived_by IS NULL OR archived_at IS NOT NULL);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS org_reviews (
    record_id        uuid PRIMARY KEY REFERENCES record_locations(record_id) ON DELETE CASCADE,
    instance_id      text NOT NULL REFERENCES instances(id),
    state            text NOT NULL CHECK (state IN ('unreviewed','confirmed','community','exempt','returned','deleted','left','superseded')),
    cycle            int  NOT NULL DEFAULT 1 CHECK (cycle >= 1),
    entered_at       timestamptz NOT NULL DEFAULT now(),
    entered_via      text NOT NULL CHECK (entered_via IN ('promote','write','version','legacy','public_profile','space_guide')),
    entered_by       uuid,
    entered_human    boolean NOT NULL DEFAULT false,
    extended         boolean NOT NULL DEFAULT false,
    from_space_id    uuid,
    from_audience    text CHECK (from_audience IN ('space','people')),
    exempt_kind      text CHECK (exempt_kind IN ('public_profile','space_guide','org_card')),
    return_after     timestamptz,
    held_at          timestamptz,
    held_by          uuid,
    disputed_at      timestamptz,
    decided_at       timestamptz,
    decided_by       uuid,
    decided_via      text CHECK (decided_via IN ('curator','community','auto','author','self','system')),
    returned_to      uuid,
    returns          int  NOT NULL DEFAULT 0 CHECK (returns >= 0),
    supersedes_id    uuid,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT org_reviews_due_check     CHECK (state <> 'unreviewed' OR return_after IS NOT NULL),
    CONSTRAINT org_reviews_exempt_check  CHECK (state <> 'exempt' OR exempt_kind IS NOT NULL),
    CONSTRAINT org_reviews_held_by_check CHECK ((held_at IS NULL) = (held_by IS NULL))
);
CREATE INDEX IF NOT EXISTS org_reviews_due_idx   ON org_reviews (return_after) WHERE state = 'unreviewed';
CREATE INDEX IF NOT EXISTS org_reviews_held_idx  ON org_reviews (instance_id, held_at) WHERE held_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_reviews_state_idx ON org_reviews (instance_id, state, entered_at);
DROP TRIGGER IF EXISTS org_reviews_touch ON org_reviews;
CREATE TRIGGER org_reviews_touch BEFORE UPDATE ON org_reviews FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE IF NOT EXISTS org_review_marks (
    record_id      uuid NOT NULL REFERENCES org_reviews(record_id) ON DELETE CASCADE,
    person_id      uuid NOT NULL,
    kind           text NOT NULL CHECK (kind IN ('useful','wrong')),
    reason         text CHECK (reason IN ('wrong','not_for_all')),
    team_id        uuid,
    correction_id  uuid,
    cycle          int  NOT NULL DEFAULT 1 CHECK (cycle >= 1),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (record_id, person_id, kind),
    CONSTRAINT org_review_marks_wrong_reason_check CHECK ((kind = 'wrong') = (reason IS NOT NULL))
);
GRANT SELECT, INSERT, UPDATE ON org_reviews TO memory_gateway, memory_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_review_marks TO memory_gateway;
GRANT SELECT, UPDATE ON org_review_marks TO memory_worker;

-- ---------------------------------------------------------------- department head in the space of their own department
UPDATE space_members m SET source = 'org', grant_id = NULL, expires_at = NULL
FROM spaces s
WHERE s.id = m.space_id AND s.org_unit_id IS NOT NULL AND s.archived_at IS NULL
  AND m.role = 'owner' AND m.source = 'manual'
  AND EXISTS (SELECT 1 FROM person_org_units h JOIN people p ON p.id = h.person_id AND p.active
              WHERE h.org_unit_id = s.org_unit_id AND h.person_id = m.person_id AND h.relation = 'head');

-- ---------------------------------------------------------------- keeper of the personal space of a departed employee
CREATE TABLE IF NOT EXISTS personal_custody (
    space_id         uuid PRIMARY KEY,
    instance_id      text NOT NULL REFERENCES instances(id),
    person_id        uuid NOT NULL UNIQUE,
    custodian_id     uuid,
    basis            text NOT NULL CHECK (basis IN ('manager','department_head','admin','manual')),
    levels           integer NOT NULL DEFAULT 0 CHECK (levels >= 0),
    manager_login    text,
    org_unit_ids     uuid[] NOT NULL DEFAULT '{}',
    created_at       timestamptz NOT NULL DEFAULT now(),
    assigned_at      timestamptz NOT NULL DEFAULT now(),
    assigned_by      text,
    reason           text CHECK (reason IS NULL OR char_length(reason) BETWEEN 3 AND 200),
    meetings_waiting integer NOT NULL DEFAULT 0 CHECK (meetings_waiting >= 0),
    busy_passes      integer NOT NULL DEFAULT 0 CHECK (busy_passes >= 0),
    meetings_conflicts integer NOT NULL DEFAULT 0 CHECK (meetings_conflicts >= 0),
    notified_id      uuid,
    by_operator      text
);
ALTER TABLE personal_custody DROP COLUMN IF EXISTS meetings_moved;
ALTER TABLE personal_custody ADD COLUMN IF NOT EXISTS by_operator text;
CREATE INDEX IF NOT EXISTS personal_custody_custodian_idx ON personal_custody (custodian_id) WHERE custodian_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON personal_custody TO memory_gateway, memory_worker;

DO $$ BEGIN CREATE ROLE memory_test_purge NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$;
COMMENT ON ROLE memory_test_purge IS 'Owner of the tp_* functions: no login, rights only through the functions';

CREATE TABLE IF NOT EXISTS test_purge_marks (
    kind        text NOT NULL CHECK (kind IN ('org_unit', 'service')),
    target_id   uuid NOT NULL,
    instance_id text NOT NULL REFERENCES instances(id),
    plan_sha    text NOT NULL CHECK (plan_sha ~ '^[0-9a-f]{64}$'),
    basis       text NOT NULL CHECK (basis ~ '^approval [0-9]+(; [^\n]{0,80})?$'),
    evidence    text[] NOT NULL CHECK (cardinality(evidence) >= 1),
    marked_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, target_id)
);
GRANT SELECT ON test_purge_marks TO memory_worker, memory_gateway;

GRANT SELECT ON people, spaces, space_members, space_groups, api_keys, oauth_connections, services, user_sessions,
      role_grants, person_identities, person_org_units, org_units, entities, upload_tickets, directory_group_members,
      admin_users, record_locations, record_links, class_moves, deletion_requests, mail_outbox, action_plans,
      action_plan_items, space_moves, settings, roles, never_open_rules, instances, test_purge_marks TO memory_test_purge;
GRANT DELETE ON people, spaces, space_members, api_keys, oauth_connections, services, user_sessions, role_grants,
      person_identities, person_org_units, org_units, entities, upload_tickets, directory_group_members,
      test_purge_marks TO memory_test_purge;
GRANT INSERT, UPDATE (marked_at, plan_sha, basis, evidence) ON test_purge_marks TO memory_test_purge;
GRANT UPDATE (updated_at) ON people, org_units, entities TO memory_test_purge;
GRANT UPDATE (archived_at) ON spaces TO memory_test_purge;
GRANT UPDATE (added_at) ON space_members TO memory_test_purge;
GRANT UPDATE (revoked_at) ON api_keys, role_grants TO memory_test_purge;
GRANT UPDATE (ended_at) ON user_sessions TO memory_test_purge;
GRANT UPDATE (active) ON services, person_identities TO memory_test_purge;
GRANT UPDATE (used_at) ON upload_tickets TO memory_test_purge;

CREATE OR REPLACE FUNCTION tp_test_login(p_login text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT lower(split_part(p_login, '@', 2)) IN ('corp.test', 'test') OR lower(split_part(p_login, '@', 2)) LIKE '%.test' $$;

CREATE OR REPLACE FUNCTION tp_showcase_logins() RETURNS text[]
  LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
  SELECT ARRAY['demo.head@corp.test', 'demo.employee@corp.test'] $$;

CREATE OR REPLACE FUNCTION tp_age(p_instance text, p_age interval) RETURNS interval
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT GREATEST(COALESCE(p_age, interval '0'), interval '60 minutes',
         make_interval(mins => COALESCE((SELECT CASE WHEN jsonb_typeof(COALESCE(value, default_value)) = 'number'
                                                     THEN (COALESCE(value, default_value) #>> '{}')::numeric::int END
                                           FROM settings WHERE instance_id = p_instance AND category = 'access'
                                            AND key = 'test_leftovers_grace_minutes'), 60))) $$;

CREATE OR REPLACE FUNCTION tp_lock_t0(p_instance text, p_people uuid[], p_for_delete boolean DEFAULT false)
  RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid[];
BEGIN
  IF p_for_delete THEN
    SELECT COALESCE(array_agg(x.id), '{}') INTO v FROM (
      SELECT p.id FROM people p WHERE p.id = ANY(p_people) AND p.instance_id = p_instance AND NOT p.active
         AND tp_test_login(p.login) AND lower(p.login) <> ALL (tp_showcase_logins())
       FOR UPDATE SKIP LOCKED) x;
  ELSE
    SELECT COALESCE(array_agg(x.id), '{}') INTO v FROM (
      SELECT p.id FROM people p WHERE p.id = ANY(p_people) AND p.instance_id = p_instance AND NOT p.active
         AND tp_test_login(p.login) AND lower(p.login) <> ALL (tp_showcase_logins())
       FOR SHARE SKIP LOCKED) x;
  END IF;
  SELECT COALESCE(array_agg(t.id), '{}') INTO v FROM unnest(v) AS t(id)
   WHERE NOT EXISTS (SELECT 1 FROM admin_users a WHERE a.person_id = t.id)
     AND NOT EXISTS (SELECT 1 FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id
                      WHERE (s.slug = 'demo-showcase' OR u.code = 'demo')
                        AND (s.owner_id = t.id OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.person_id = t.id)));
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION tp_aged(p_instance text, p_people uuid[], p_age interval) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(p.id), '{}') FROM people p
   WHERE p.id = ANY(p_people) AND p.instance_id = p_instance
     AND GREATEST(p.updated_at,
           (SELECT max(s.archived_at) FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = p.id),
           (SELECT max(k.last_used_at) FROM api_keys k WHERE k.principal_type = 'person' AND k.principal_id = p.id),
           (SELECT max(u.last_seen_at) FROM user_sessions u WHERE u.person_id = p.id)) <= now() - tp_age(p_instance, p_age) $$;

CREATE OR REPLACE FUNCTION tp_fk_blockers(p_target regclass, p_ids uuid[], p_skip text[] DEFAULT '{}')
  RETURNS TABLE (id uuid, ref text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF p_target NOT IN ('people'::regclass, 'spaces'::regclass, 'org_units'::regclass, 'api_keys'::regclass,
                      'services'::regclass, 'entities'::regclass, 'role_grants'::regclass, 'user_sessions'::regclass) THEN
    RAISE EXCEPTION 'tp_fk_blockers: target % is not supported', p_target;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = p_target AND cardinality(c.conkey) > 1) THEN
    RAISE EXCEPTION 'tp_fk_blockers: composite foreign key on %', p_target;
  END IF;
  IF COALESCE(cardinality(p_ids), 0) = 0 THEN RETURN; END IF;
  FOR r IN SELECT c.conrelid::regclass::text AS t, a.attname::text AS col
             FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f' AND c.confrelid = p_target ORDER BY 1, 2 LOOP
    CONTINUE WHEN (r.t || '.' || r.col) = ANY (p_skip);
    RETURN QUERY EXECUTE format('SELECT DISTINCT %I::uuid, %L::text FROM %s WHERE %I = ANY($1)', r.col, r.t || '.' || r.col, r.t, r.col)
      USING p_ids;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION tp_dependents(p_instance text, p_people uuid[], p_age interval, p_keys uuid[] DEFAULT '{}')
  RETURNS TABLE (person_id uuid, kind text, id uuid, key_id uuid, eligible boolean, live boolean, admin_user boolean, last_seen timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id, 'person', p.id, NULL::uuid, NULL::boolean, NULL::boolean,
         EXISTS (SELECT 1 FROM admin_users a WHERE a.person_id = p.id),
         (SELECT max(u.last_seen_at) FROM user_sessions u WHERE u.person_id = p.id)
    FROM people p WHERE p.id = ANY(p_people) AND p.instance_id = p_instance
  UNION ALL
  SELECT u.person_id, 'session', u.id, NULL::uuid,
         LEAST(COALESCE(u.ended_at, 'infinity'::timestamptz), u.expires_at) <= now() - tp_age(p_instance, p_age),
         u.ended_at IS NULL AND u.expires_at > now(), NULL::boolean, u.last_seen_at
    FROM user_sessions u WHERE u.person_id = ANY(p_people) AND u.instance_id = p_instance
  UNION ALL
  SELECT t.person_id, 'ticket', t.id, t.key_id,
         COALESCE(t.used_at, t.expires_at) <= now() - tp_age(p_instance, p_age) AND (t.used_at IS NOT NULL OR t.expires_at < now()),
         t.used_at IS NULL AND t.expires_at > now(), NULL::boolean, COALESCE(t.used_at, t.created_at)
    FROM upload_tickets t WHERE (t.person_id = ANY(p_people) OR t.key_id = ANY(p_keys)) AND t.instance_id = p_instance $$;

CREATE OR REPLACE FUNCTION tp_baseline(p_instance text, p_excl jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE (tbl text, n bigint, sha text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE r record; v_keys text[];
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('people', 't.id::text'), ('spaces', 't.id::text'), ('space_members', 't.space_id::text || '':'' || t.person_id::text'),
      ('space_groups', 't.id::text'), ('api_keys', 't.id::text'), ('oauth_connections', 't.id::text'), ('services', 't.id::text'),
      ('user_sessions', 't.id::text'), ('role_grants', 't.id::text'), ('person_identities', 't.person_id::text'),
      ('person_org_units', 't.person_id::text'), ('org_units', 't.id::text'), ('entities', 't.id::text'),
      ('upload_tickets', 't.id::text'), ('directory_group_members', 't.person_id::text'), ('admin_users', 't.id::text'),
      ('record_locations', 't.record_id::text'), ('record_links', 't.id::text'), ('class_moves', 't.id::text'),
      ('deletion_requests', 't.id::text'), ('mail_outbox', 't.id::text'), ('action_plans', 't.id::text'),
      ('action_plan_items', 't.plan_id::text'), ('space_moves', 't.record_id::text'), ('never_open_rules', 't.id::text'),
      ('test_purge_marks', 't.target_id::text'), ('settings', NULL), ('roles', NULL), ('instances', NULL)) AS x(t, k) LOOP
    v_keys := CASE WHEN r.k IS NULL THEN '{}'::text[]
                   ELSE COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_excl -> r.t, '[]'::jsonb))), '{}') END;
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, count(*)::bigint, encode(sha256(convert_to(COALESCE(string_agg(h, '''' ORDER BY h), ''''), ''UTF8'')), ''hex'')
         FROM (SELECT md5(t::text) AS h FROM %I t WHERE NOT (%s = ANY($1))) x', r.t, r.t, COALESCE(r.k, '''''')) USING v_keys;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION tp_tickets(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_age interval := tp_age(p_instance, p_age); v_t0 uuid[]; v_free uuid[]; v_ok uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_t0 := tp_lock_t0(p_instance, ARRAY(SELECT DISTINCT t.person_id FROM upload_tickets t WHERE t.id = ANY(p_ids)));
  SELECT COALESCE(array_agg(t.id), '{}') INTO v_free FROM upload_tickets t JOIN people p ON p.id = t.person_id
   WHERE t.id = ANY(p_ids) AND t.instance_id = p_instance AND NOT p.active AND tp_test_login(p.login)
     AND COALESCE(t.used_at, t.expires_at) <= now() - v_age AND (t.used_at IS NOT NULL OR t.expires_at < now());
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_ok FROM (
    SELECT t.id FROM upload_tickets t
     WHERE t.id = ANY(p_ids) AND t.instance_id = p_instance AND t.person_id = ANY(v_t0)
       AND COALESCE(t.used_at, t.expires_at) <= now() - v_age AND (t.used_at IS NOT NULL OR t.expires_at < now())
     FOR UPDATE SKIP LOCKED) x;
  IF p_apply THEN
    RETURN QUERY WITH d AS (
      DELETE FROM upload_tickets t WHERE t.id = ANY(v_ok) AND t.person_id = ANY(v_t0)
         AND COALESCE(t.used_at, t.expires_at) <= now() - v_age AND (t.used_at IS NOT NULL OR t.expires_at < now()) RETURNING t.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_keys(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_age interval := tp_age(p_instance, p_age); v_t0 uuid[]; v_svc uuid[]; v_free uuid[]; v_lock uuid[]; v_ok uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_t0 := tp_lock_t0(p_instance, ARRAY(SELECT k.principal_id FROM api_keys k WHERE k.id = ANY(p_ids) AND k.principal_type = 'person'));
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_svc FROM (
    SELECT s.id FROM services s WHERE s.id IN (SELECT k.principal_id FROM api_keys k WHERE k.id = ANY(p_ids) AND k.principal_type = 'service')
       AND s.instance_id = p_instance AND NOT s.active FOR SHARE SKIP LOCKED) x;
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_svc FROM services s
   WHERE s.id = ANY(v_svc)
     AND (EXISTS (SELECT 1 FROM test_purge_marks t WHERE t.kind = 'service' AND t.target_id = s.id AND t.instance_id = p_instance)
          OR tp_run_label(p_instance, s.name));
  SELECT COALESCE(array_agg(k.id), '{}') INTO v_free FROM api_keys k
   WHERE k.id = ANY(p_ids) AND k.instance_id = p_instance AND k.principal_type IN ('person', 'service')
     AND (k.revoked_at <= now() - v_age OR k.expires_at <= now() - v_age)
     AND (EXISTS (SELECT 1 FROM people p WHERE k.principal_type = 'person' AND p.id = k.principal_id AND NOT p.active AND tp_test_login(p.login))
          OR EXISTS (SELECT 1 FROM services s WHERE k.principal_type = 'service' AND s.id = k.principal_id AND NOT s.active
                       AND (EXISTS (SELECT 1 FROM test_purge_marks t WHERE t.kind = 'service' AND t.target_id = s.id AND t.instance_id = p_instance)
                            OR tp_run_label(p_instance, s.name))));
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_lock FROM (
    SELECT k.id FROM api_keys k
     WHERE k.id = ANY(p_ids) AND k.instance_id = p_instance AND k.principal_type IN ('person', 'service')
       AND (k.revoked_at <= now() - v_age OR k.expires_at <= now() - v_age)
       AND ((k.principal_type = 'person' AND k.principal_id = ANY(v_t0)) OR (k.principal_type = 'service' AND k.principal_id = ANY(v_svc)))
     FOR UPDATE SKIP LOCKED) x;
  SELECT COALESCE(array_agg(u), '{}') INTO v_ok FROM unnest(v_lock) u
   WHERE u <> ALL (ARRAY(SELECT b.id FROM tp_fk_blockers('api_keys', v_lock, '{oauth_connections.id}') b));
  IF p_apply THEN
    DELETE FROM oauth_connections o WHERE o.id = ANY(v_ok);
    RETURN QUERY WITH d AS (
      DELETE FROM api_keys k WHERE k.id = ANY(v_ok) AND k.principal_type IN ('person', 'service')
         AND (k.revoked_at <= now() - v_age OR k.expires_at <= now() - v_age)
         AND ((k.principal_type = 'person' AND k.principal_id = ANY(v_t0)) OR (k.principal_type = 'service' AND k.principal_id = ANY(v_svc)))
       RETURNING k.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_lock) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_sessions(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_age interval := tp_age(p_instance, p_age); v_t0 uuid[]; v_free uuid[]; v_ok uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_t0 := tp_lock_t0(p_instance, ARRAY(SELECT DISTINCT s.person_id FROM user_sessions s WHERE s.id = ANY(p_ids)));
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_free FROM user_sessions s JOIN people p ON p.id = s.person_id
   WHERE s.id = ANY(p_ids) AND s.instance_id = p_instance AND NOT p.active AND tp_test_login(p.login)
     AND LEAST(COALESCE(s.ended_at, 'infinity'), s.expires_at) <= now() - v_age;
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_ok FROM (
    SELECT s.id FROM user_sessions s
     WHERE s.id = ANY(p_ids) AND s.instance_id = p_instance AND s.person_id = ANY(v_t0)
       AND LEAST(COALESCE(s.ended_at, 'infinity'), s.expires_at) <= now() - v_age
     FOR UPDATE SKIP LOCKED) x;
  IF p_apply THEN
    RETURN QUERY WITH d AS (
      DELETE FROM user_sessions s WHERE s.id = ANY(v_ok) AND s.person_id = ANY(v_t0)
         AND LEAST(COALESCE(s.ended_at, 'infinity'), s.expires_at) <= now() - v_age RETURNING s.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_grants(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_age interval := tp_age(p_instance, p_age); v_t0 uuid[]; v_aged uuid[]; v_free uuid[]; v_lock uuid[]; v_ok uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_t0 := tp_lock_t0(p_instance, ARRAY(SELECT DISTINCT g.person_id FROM role_grants g WHERE g.id = ANY(p_ids)));
  v_aged := tp_aged(p_instance, v_t0, p_age);
  SELECT COALESCE(array_agg(g.id), '{}') INTO v_free FROM role_grants g JOIN people p ON p.id = g.person_id
   WHERE g.id = ANY(p_ids) AND g.instance_id = p_instance AND NOT p.active AND tp_test_login(p.login);
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_lock FROM (
    SELECT g.id FROM role_grants g
     WHERE g.id = ANY(p_ids) AND g.instance_id = p_instance AND g.person_id = ANY(v_t0)
       AND (g.revoked_at <= now() - v_age OR g.valid_to <= now() - v_age OR g.person_id = ANY(v_aged))
     FOR UPDATE SKIP LOCKED) x;
  SELECT COALESCE(array_agg(g.id), '{}') INTO v_ok FROM role_grants g
   WHERE g.id = ANY(v_lock)
     AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.grant_id = g.id AND m.person_id <> g.person_id)
     AND g.id <> ALL (ARRAY(SELECT b.id FROM tp_fk_blockers('role_grants', v_lock, '{space_members.grant_id}') b));
  IF p_apply THEN
    RETURN QUERY WITH d AS (
      DELETE FROM role_grants g WHERE g.id = ANY(v_ok) AND g.person_id = ANY(v_t0)
         AND (g.revoked_at <= now() - v_age OR g.valid_to <= now() - v_age OR g.person_id = ANY(v_aged)) RETURNING g.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_lock) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_members(p_instance text, p_spaces uuid[], p_people uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (space_id uuid, person_id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_t0 uuid[]; v_aged uuid[]; v_pairs text[]; v_free text[]; v_ok text[];
BEGIN
  IF cardinality(p_spaces) IS DISTINCT FROM cardinality(p_people) THEN RAISE EXCEPTION 'tp_members: pairs of different length'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_pairs := ARRAY(SELECT x.s::text || ':' || x.p::text FROM unnest(p_spaces, p_people) AS x(s, p));
  v_t0 := tp_lock_t0(p_instance, ARRAY(SELECT DISTINCT x.p FROM unnest(p_people) AS x(p)
                                       UNION SELECT s.owner_id FROM spaces s WHERE s.id = ANY(p_spaces) AND s.owner_id IS NOT NULL));
  v_aged := tp_aged(p_instance, v_t0, p_age);
  SELECT COALESCE(array_agg(m.space_id::text || ':' || m.person_id::text), '{}') INTO v_free
    FROM space_members m JOIN spaces s ON s.id = m.space_id JOIN people p ON p.id = m.person_id
   WHERE (m.space_id::text || ':' || m.person_id::text) = ANY(v_pairs) AND s.instance_id = p_instance AND s.kind <> 'personal'
     AND NOT p.active AND tp_test_login(p.login);
  SELECT COALESCE(array_agg(x.k), '{}') INTO v_ok FROM (
    SELECT m.space_id::text || ':' || m.person_id::text AS k FROM space_members m JOIN spaces s ON s.id = m.space_id
     WHERE (m.space_id::text || ':' || m.person_id::text) = ANY(v_pairs) AND s.instance_id = p_instance
       AND m.person_id = ANY(v_t0) AND s.kind <> 'personal'
       AND ((s.archived_at IS NOT NULL AND s.owner_id = ANY(v_t0)) OR m.person_id = ANY(v_aged))
       AND (m.grant_id IS NULL OR EXISTS (SELECT 1 FROM role_grants g WHERE g.id = m.grant_id AND g.person_id = m.person_id))
     FOR UPDATE OF m SKIP LOCKED) x;
  IF p_apply THEN
    RETURN QUERY WITH d AS (
      DELETE FROM space_members m USING spaces s
       WHERE s.id = m.space_id AND (m.space_id::text || ':' || m.person_id::text) = ANY(v_ok) AND m.person_id = ANY(v_t0)
         AND s.kind <> 'personal' AND ((s.archived_at IS NOT NULL AND s.owner_id = ANY(v_t0)) OR m.person_id = ANY(v_aged))
       RETURNING m.space_id, m.person_id)
      SELECT d.space_id, d.person_id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT split_part(k, ':', 1)::uuid, split_part(k, ':', 2)::uuid, 'ok'::text FROM unnest(v_ok) k;
  END IF;
  RETURN QUERY SELECT split_part(k, ':', 1)::uuid, split_part(k, ':', 2)::uuid,
                      CASE WHEN k = ANY(v_free) THEN 'busy' ELSE 'rejected' END
                 FROM unnest(v_pairs) k WHERE k <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_person_attrs(p_instance text, p_people uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_t0 uuid[]; v_ok uuid[]; v_free uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_t0 := tp_lock_t0(p_instance, p_people);
  v_ok := tp_aged(p_instance, v_t0, p_age);
  SELECT COALESCE(array_agg(p.id), '{}') INTO v_free FROM people p WHERE p.id = ANY(p_people) AND p.instance_id = p_instance AND NOT p.active AND tp_test_login(p.login);
  IF p_apply THEN
    DELETE FROM person_identities i WHERE i.person_id = ANY(v_ok);
    DELETE FROM person_org_units o WHERE o.person_id = ANY(v_ok);
    DELETE FROM directory_group_members g WHERE g.person_id = ANY(v_ok) AND g.instance_id = p_instance;
    RETURN QUERY SELECT u, 'deleted'::text FROM unnest(v_ok) u;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_t0) THEN 'busy' ELSE 'rejected' END FROM unnest(p_people) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_run_label(p_instance text, p_name text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT EXISTS (SELECT 1 FROM people p WHERE p.instance_id = p_instance AND tp_test_login(p.login)
                                     AND lower(p.login) <> ALL (tp_showcase_logins())
                                     AND left(lower(p.login), length(l.label) + 1) = l.label || '-')
                     FROM (SELECT substring(lower(p_name) from '^([a-z]+-[0-9a-f]{6,})-') AS label) l WHERE l.label IS NOT NULL), false) $$;

CREATE OR REPLACE FUNCTION tp_services(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_age interval := tp_age(p_instance, p_age); v_t0 uuid[]; v_free uuid[]; v_lock uuid[]; v_ok uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_free FROM services s
   WHERE s.id = ANY(p_ids) AND s.instance_id = p_instance AND NOT s.active AND s.created_at <= now() - v_age;
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_lock FROM (
    SELECT s.id FROM services s WHERE s.id = ANY(v_free) AND s.instance_id = p_instance AND NOT s.active AND s.created_at <= now() - v_age
     FOR UPDATE SKIP LOCKED) x;
  v_t0 := tp_lock_t0(p_instance, ARRAY(SELECT sp.owner_id FROM services s JOIN spaces sp ON sp.id = s.write_space_id WHERE s.id = ANY(v_lock) AND sp.owner_id IS NOT NULL));
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_ok FROM services s
   WHERE s.id = ANY(v_lock)
     AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.principal_type = 'service' AND k.principal_id = s.id)
     AND (s.write_space_id IS NULL OR EXISTS (SELECT 1 FROM spaces sp WHERE sp.id = s.write_space_id AND sp.archived_at IS NOT NULL
                                                AND sp.kind IN ('team', 'project') AND sp.owner_id = ANY(v_t0)))
     AND NOT EXISTS (SELECT 1 FROM settings st WHERE st.instance_id = p_instance
                       AND (strpos(COALESCE(st.value::text, ''), s.id::text) > 0 OR strpos(COALESCE(st.default_value::text, ''), s.id::text) > 0
                            OR strpos(COALESCE(st.value::text, ''), '"' || s.name || '"') > 0 OR strpos(COALESCE(st.default_value::text, ''), '"' || s.name || '"') > 0))
     AND (EXISTS (SELECT 1 FROM test_purge_marks t WHERE t.kind = 'service' AND t.target_id = s.id AND t.instance_id = p_instance)
          OR tp_run_label(p_instance, s.name))
     AND s.id <> ALL (ARRAY(SELECT b.id FROM tp_fk_blockers('services', v_lock) b));
  IF p_apply THEN
    DELETE FROM test_purge_marks t WHERE t.kind = 'service' AND t.target_id = ANY(v_ok);
    RETURN QUERY WITH d AS (
      DELETE FROM services s WHERE s.id = ANY(v_ok) AND NOT s.active AND s.created_at <= now() - v_age RETURNING s.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_lock) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_spaces(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_age interval := tp_age(p_instance, p_age); v_t0 uuid[]; v_lock uuid[]; v_ok uuid[]; v_free uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_t0 := tp_lock_t0(p_instance, ARRAY(SELECT s.owner_id FROM spaces s WHERE s.id = ANY(p_ids) AND s.owner_id IS NOT NULL
                                       UNION SELECT m.person_id FROM space_members m WHERE m.space_id = ANY(p_ids)));
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_free FROM spaces s
   WHERE s.id = ANY(p_ids) AND s.instance_id = p_instance AND s.kind IN ('team', 'project')
     AND s.archived_at <= now() - v_age AND s.slug <> 'demo-showcase';
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_lock FROM (
    SELECT s.id FROM spaces s
     WHERE s.id = ANY(v_free) AND s.kind IN ('team', 'project') AND s.archived_at IS NOT NULL
       AND s.archived_at <= now() - v_age AND s.slug <> 'demo-showcase' AND s.owner_id = ANY(v_t0)
     FOR UPDATE SKIP LOCKED) x;
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_ok FROM spaces s
   WHERE s.id = ANY(v_lock)
     AND NOT EXISTS (SELECT 1 FROM org_units u WHERE u.id = s.org_unit_id AND u.code = 'demo')
     AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.person_id <> ALL (v_t0))
     AND NOT EXISTS (SELECT 1 FROM space_groups g WHERE g.space_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM space_moves mv WHERE mv.from_space_id = s.id OR mv.to_space_id = s.id)
     AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.scope_kind = 'space' AND g.scope_ref = s.slug
                       AND g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now()))
     AND s.id <> ALL (ARRAY(SELECT b.id FROM tp_fk_blockers('spaces', v_lock, '{space_members.space_id}') b));
  IF p_apply THEN
    RETURN QUERY WITH d AS (
      DELETE FROM spaces s WHERE s.id = ANY(v_ok) AND s.kind IN ('team', 'project') AND s.archived_at IS NOT NULL
         AND s.archived_at <= now() - v_age AND s.slug <> 'demo-showcase' AND s.owner_id = ANY(v_t0) RETURNING s.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_lock) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_org_units(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_age interval := tp_age(p_instance, p_age); v_free uuid[]; v_lock uuid[]; v_ok uuid[]; v_prev int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  SELECT COALESCE(array_agg(u.id), '{}') INTO v_free FROM org_units u
   WHERE u.id = ANY(p_ids) AND u.instance_id = p_instance AND u.code <> 'demo' AND COALESCE(u.attrs->>'real', '') <> 'true'
     AND u.updated_at <= now() - v_age;
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_lock FROM (
    SELECT u.id FROM org_units u WHERE u.id = ANY(v_free) AND u.code <> 'demo' AND COALESCE(u.attrs->>'real', '') <> 'true'
       AND u.updated_at <= now() - v_age FOR UPDATE SKIP LOCKED) x;
  SELECT COALESCE(array_agg(u.id), '{}') INTO v_ok FROM org_units u
   WHERE u.id = ANY(v_lock)
     AND (u.attrs->>'origin' = 'test'
          OR EXISTS (SELECT 1 FROM test_purge_marks t WHERE t.kind = 'org_unit' AND t.target_id = u.id AND t.instance_id = p_instance
                       AND t.marked_at >= u.updated_at))
     AND NOT EXISTS (SELECT 1 FROM person_org_units l WHERE l.org_unit_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.org_unit_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.instance_id = p_instance AND g.scope_kind IN ('org_unit', 'org_branch') AND g.scope_ref = u.code
                       AND g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now()))
     AND NOT EXISTS (SELECT 1 FROM people p WHERE p.instance_id = p_instance
                       AND NOT (tp_test_login(p.login) AND lower(p.login) <> ALL (tp_showcase_logins()))
                       AND (p.department = u.name OR p.attrs->>'department_code' = u.code OR p.attrs->>'parent_department_code' = u.code))
     AND u.id <> ALL (ARRAY(SELECT b.id FROM tp_fk_blockers('org_units', v_lock, '{org_units.parent_id}') b));
  LOOP
    v_prev := cardinality(v_ok);
    SELECT COALESCE(array_agg(u), '{}') INTO v_ok FROM unnest(v_ok) u
     WHERE NOT EXISTS (SELECT 1 FROM org_units c WHERE c.parent_id = u AND c.id <> ALL (v_ok));
    EXIT WHEN cardinality(v_ok) = v_prev;
  END LOOP;
  IF p_apply THEN
    DELETE FROM test_purge_marks t WHERE t.kind = 'org_unit' AND t.target_id = ANY(v_ok);
    RETURN QUERY WITH d AS (
      DELETE FROM org_units u WHERE u.id = ANY(v_ok) AND u.code <> 'demo' AND COALESCE(u.attrs->>'real', '') <> 'true'
         AND u.updated_at <= now() - v_age RETURNING u.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_lock) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_people(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_t0 uuid[]; v_aged uuid[]; v_free uuid[]; v_ok uuid[]; v_personal uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  v_t0 := tp_lock_t0(p_instance, p_ids, true);
  v_aged := tp_aged(p_instance, v_t0, p_age);
  SELECT COALESCE(array_agg(p.id), '{}') INTO v_free FROM people p
   WHERE p.id = ANY(p_ids) AND p.instance_id = p_instance AND NOT p.active AND tp_test_login(p.login) AND lower(p.login) <> ALL (tp_showcase_logins());
  v_personal := ARRAY(SELECT s.id FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = ANY(v_aged));
  SELECT COALESCE(array_agg(p.id), '{}') INTO v_ok FROM people p
   WHERE p.id = ANY(v_aged)
     AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.principal_type = 'person' AND k.principal_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM record_locations l WHERE l.deleted_by = p.id)
     AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.owner_id = p.id AND NOT (s.kind = 'personal' AND s.archived_at IS NOT NULL))
     AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.created_by = p.id AND NOT (s.kind = 'personal' AND s.owner_id = p.id))
     AND p.id <> ALL (ARRAY(SELECT b.id FROM tp_fk_blockers('people', v_aged, '{spaces.owner_id,spaces.created_by}') b))
     AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = p.id
                       AND s.id = ANY (ARRAY(SELECT b.id FROM tp_fk_blockers('spaces', v_personal) b)));
  IF p_apply THEN
    DELETE FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = ANY(v_ok) AND s.archived_at IS NOT NULL;
    RETURN QUERY WITH d AS (
      DELETE FROM people p WHERE p.id = ANY(v_ok) AND NOT p.active AND tp_test_login(p.login)
         AND lower(p.login) <> ALL (tp_showcase_logins()) RETURNING p.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_t0) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_entities(p_instance text, p_ids uuid[], p_age interval, p_apply boolean)
  RETURNS TABLE (id uuid, state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_free uuid[]; v_lock uuid[]; v_ok uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  SELECT COALESCE(array_agg(e.id), '{}') INTO v_free FROM entities e
   WHERE e.id = ANY(p_ids) AND e.instance_id = p_instance
     AND ((e.kind = 'person' AND e.external_system = 'people' AND tp_test_login(e.external_id))
          OR (e.kind = 'project' AND e.external_system = 'memory' AND e.attrs ? 'space_id'));
  SELECT COALESCE(array_agg(x.id), '{}') INTO v_lock FROM (
    SELECT e.id FROM entities e WHERE e.id = ANY(v_free) AND e.instance_id = p_instance
       AND ((e.kind = 'person' AND e.external_system = 'people' AND tp_test_login(e.external_id))
            OR (e.kind = 'project' AND e.external_system = 'memory' AND e.attrs ? 'space_id'))
     FOR UPDATE SKIP LOCKED) x;
  SELECT COALESCE(array_agg(e.id), '{}') INTO v_ok FROM entities e
   WHERE e.id = ANY(v_lock)
     AND (e.kind <> 'person' OR NOT EXISTS (SELECT 1 FROM people p WHERE p.id = e.id OR lower(p.login) = lower(e.external_id)))
     AND (e.kind <> 'project' OR (NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id::text = e.attrs->>'space_id')
                                   AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.slug = e.external_id)))
     AND e.id <> ALL (ARRAY(SELECT b.id FROM tp_fk_blockers('entities', v_lock) b));
  IF p_apply THEN
    RETURN QUERY WITH d AS (
      DELETE FROM entities e WHERE e.id = ANY(v_ok) AND e.instance_id = p_instance
         AND ((e.kind = 'person' AND e.external_system = 'people' AND tp_test_login(e.external_id))
              OR (e.kind = 'project' AND e.external_system = 'memory' AND e.attrs ? 'space_id')) RETURNING e.id)
      SELECT d.id, 'deleted'::text FROM d;
  ELSE
    RETURN QUERY SELECT u, 'ok'::text FROM unnest(v_ok) u;
  END IF;
  RETURN QUERY SELECT u, CASE WHEN u = ANY(v_free) AND u <> ALL (v_lock) THEN 'busy' ELSE 'rejected' END FROM unnest(p_ids) u WHERE u <> ALL (v_ok);
END $$;

CREATE OR REPLACE FUNCTION tp_unit_evidence(p_instance text, p_unit uuid) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (SELECT * FROM org_units WHERE id = p_unit AND instance_id = p_instance),
       t AS (SELECT p.* FROM people p WHERE p.instance_id = p_instance AND tp_test_login(p.login) AND lower(p.login) <> ALL (tp_showcase_logins()))
  SELECT COALESCE(array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM t, u WHERE t.attrs->>'department_code' = u.code OR t.attrs->>'parent_department_code' = u.code) THEN 'code_of_T' END,
    CASE WHEN EXISTS (SELECT 1 FROM spaces s JOIN people o ON o.id = s.owner_id, u WHERE s.org_unit_id = u.id AND NOT o.active
                        AND tp_test_login(o.login) AND lower(o.login) <> ALL (tp_showcase_logins())
                        AND NOT EXISTS (SELECT 1 FROM admin_users a WHERE a.person_id = o.id)) THEN 'space_of_T0' END,
    CASE WHEN EXISTS (SELECT 1 FROM role_grants g JOIN t ON t.id = g.person_id, u WHERE g.scope_kind IN ('org_unit', 'org_branch') AND g.scope_ref = u.code) THEN 'grant_of_T' END,
    CASE WHEN EXISTS (SELECT 1 FROM u WHERE tp_run_label(p_instance, u.code)) THEN 'run_label' END,
    CASE WHEN EXISTS (SELECT 1 FROM t, u WHERE t.department = u.name) THEN 'name_of_T' END], NULL), '{}') $$;

CREATE OR REPLACE FUNCTION tp_mark(p_instance text, p_kind text, p_ids uuid[], p_owner_listed uuid[], p_plan_sha text, p_basis text, p_apply boolean)
  RETURNS TABLE (id uuid, evidence text[], state text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE r record; v_ev text[]; v_ok boolean; v_done uuid[] := '{}';
BEGIN
  IF p_basis IS NULL OR p_basis !~ '^approval [0-9]+(; [^\n]{0,80})?$' THEN RAISE EXCEPTION 'tp_mark: the basis does not match the pattern'; END IF;
  IF p_plan_sha IS NULL OR p_plan_sha !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'tp_mark: no plan sha'; END IF;
  IF p_kind NOT IN ('org_unit', 'service') THEN RAISE EXCEPTION 'tp_mark: kind % is not supported', p_kind; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reconcile:' || p_instance));
  IF p_kind = 'org_unit' THEN
    FOR r IN SELECT u.* FROM org_units u WHERE u.id = ANY(p_ids) AND u.instance_id = p_instance ORDER BY u.id FOR UPDATE SKIP LOCKED LOOP
      v_ev := tp_unit_evidence(p_instance, r.id);
      v_ok := r.code <> 'demo' AND COALESCE(r.attrs->>'real', '') <> 'true'
        AND NOT EXISTS (SELECT 1 FROM people p WHERE p.instance_id = p_instance
                          AND NOT (tp_test_login(p.login) AND lower(p.login) <> ALL (tp_showcase_logins()))
                          AND (p.department = r.name OR p.attrs->>'department_code' = r.code OR p.attrs->>'parent_department_code' = r.code))
        AND (v_ev && ARRAY['code_of_T', 'space_of_T0', 'grant_of_T', 'run_label']
             OR (r.id = ANY(COALESCE(p_owner_listed, '{}')) AND NOT r.active AND r.updated_at <= now() - interval '7 days'
                 AND NOT EXISTS (SELECT 1 FROM person_org_units l WHERE l.org_unit_id = r.id)
                 AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.org_unit_id = r.id)
                 AND NOT EXISTS (SELECT 1 FROM tp_fk_blockers('org_units', ARRAY[r.id], '{org_units.parent_id}'))));
      IF r.id = ANY(COALESCE(p_owner_listed, '{}')) AND v_ok THEN v_ev := v_ev || 'owner_listed'::text; END IF;
      IF v_ok AND p_apply THEN
        INSERT INTO test_purge_marks AS t (kind, target_id, instance_id, plan_sha, basis, evidence) VALUES ('org_unit', r.id, p_instance, p_plan_sha, p_basis, v_ev)
          ON CONFLICT (kind, target_id) DO UPDATE SET marked_at = now(), plan_sha = EXCLUDED.plan_sha, basis = EXCLUDED.basis, evidence = EXCLUDED.evidence;
      END IF;
      IF v_ok THEN v_done := v_done || r.id; id := r.id; evidence := v_ev; state := CASE WHEN p_apply THEN 'deleted' ELSE 'ok' END; RETURN NEXT; END IF;
    END LOOP;
  ELSE
    FOR r IN SELECT s.* FROM services s WHERE s.id = ANY(p_ids) AND s.instance_id = p_instance ORDER BY s.id FOR UPDATE SKIP LOCKED LOOP
      v_ev := array_remove(ARRAY[
        CASE WHEN tp_run_label(p_instance, r.name) THEN 'run_label' END,
        CASE WHEN EXISTS (SELECT 1 FROM spaces sp JOIN people o ON o.id = sp.owner_id WHERE sp.id = r.write_space_id AND NOT o.active
                            AND tp_test_login(o.login) AND lower(o.login) <> ALL (tp_showcase_logins())) THEN 'write_space_of_T0' END], NULL);
      v_ok := NOT r.active AND ('run_label' = ANY(v_ev)
               OR (r.id = ANY(COALESCE(p_owner_listed, '{}')) AND r.created_at <= now() - interval '7 days'));
      IF r.id = ANY(COALESCE(p_owner_listed, '{}')) AND v_ok THEN v_ev := v_ev || 'owner_listed'::text; END IF;
      IF v_ok AND p_apply THEN
        INSERT INTO test_purge_marks AS t (kind, target_id, instance_id, plan_sha, basis, evidence) VALUES ('service', r.id, p_instance, p_plan_sha, p_basis, v_ev)
          ON CONFLICT (kind, target_id) DO UPDATE SET marked_at = now(), plan_sha = EXCLUDED.plan_sha, basis = EXCLUDED.basis, evidence = EXCLUDED.evidence;
      END IF;
      IF v_ok THEN v_done := v_done || r.id; id := r.id; evidence := v_ev; state := CASE WHEN p_apply THEN 'deleted' ELSE 'ok' END; RETURN NEXT; END IF;
    END LOOP;
  END IF;
  RETURN QUERY SELECT u, NULL::text[], 'rejected'::text FROM unnest(p_ids) u WHERE u <> ALL (v_done);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname LIKE 'tp\_%' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO memory_test_purge', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO memory_worker', f);
  END LOOP;
END $$;
