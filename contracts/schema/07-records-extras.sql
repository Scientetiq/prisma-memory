CREATE INDEX IF NOT EXISTS records_title_raw_idx ON records USING gin (to_tsvector('simple', title))  WHERE title IS NOT NULL;

ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS duration_ms integer;
COMMENT ON COLUMN record_stages.duration_ms IS 'Milliseconds from the claim of a stage to done/skipped/failed; NULL — has not finished yet';

DO $$
DECLARE
    fk  record;
    n   int;
BEGIN
    FOR fk IN SELECT * FROM (VALUES ('records_supersedes_id_fkey', 'supersedes_id'), ('records_superseded_by_id_fkey', 'superseded_by_id')) v(name, col) LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'records'::regclass AND conname = fk.name AND contype = 'f' AND confdeltype = 'n') THEN
            CONTINUE;
        END IF;
        EXECUTE format('ALTER TABLE records DROP CONSTRAINT IF EXISTS %I', fk.name);
        EXECUTE format($q$UPDATE records r SET attrs = COALESCE(r.attrs, '{}'::jsonb) || jsonb_build_object(%L, r.%I), %I = NULL
                          WHERE r.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM records p WHERE p.id = r.%I)$q$,
                       fk.col || '_missing', fk.col, fk.col, fk.col, fk.col);
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN RAISE NOTICE 'records.%: dangling version references cleared — %', fk.col, n; END IF;
        EXECUTE format('ALTER TABLE records ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES records(id) ON DELETE SET NULL', fk.name, fk.col);
    END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION mark_deleted(uuid, uuid, interval) TO memory_worker;

ALTER TYPE stage_name ADD VALUE IF NOT EXISTS 'converted' BEFORE 'indexed';

ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS terminal boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN record_stages.terminal IS 'A refusal that a retry will not fix; cleared at the next claim of the stage';

ALTER TABLE records ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
CREATE OR REPLACE VIEW records_live AS
    SELECT * FROM records WHERE deleted_at IS NULL AND is_current AND hidden_at IS NULL;

ALTER TABLE records ADD COLUMN IF NOT EXISTS deleted_batch uuid;
CREATE INDEX IF NOT EXISTS records_batch_idx ON records (deleted_batch) WHERE deleted_batch IS NOT NULL;
CREATE OR REPLACE VIEW records_live AS
    SELECT * FROM records WHERE deleted_at IS NULL AND is_current AND hidden_at IS NULL;
CREATE OR REPLACE FUNCTION mark_deleted(p_record uuid, p_by uuid, p_grace interval DEFAULT interval '7 days')
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    WITH RECURSIVE tree AS (
        SELECT id FROM records WHERE id = p_record
        UNION ALL
        SELECT r.id FROM records r JOIN tree t ON r.parent_id = t.id
    )
    UPDATE records SET deleted_at = now(), deleted_by = p_by, purge_after = now() + p_grace, deleted_batch = p_record
    WHERE id IN (SELECT id FROM tree) AND deleted_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

GRANT DELETE ON record_tombstones TO memory_worker;
CREATE OR REPLACE FUNCTION purge_due(p_limit int DEFAULT 500)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    WITH due AS (
        SELECT id, source_hash FROM records
        WHERE deleted_at IS NOT NULL AND purge_after <= now()
        ORDER BY purge_after LIMIT p_limit
    ), ts AS (
        INSERT INTO record_tombstones (id, source_hash, reason)
        SELECT id, source_hash, 'purged' FROM due
        ON CONFLICT (id) DO UPDATE SET reason = 'purged', moved_to_class = NULL, source_hash = EXCLUDED.source_hash, at = now()
    )
    DELETE FROM records WHERE id IN (SELECT id FROM due);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

ALTER TABLE records ADD COLUMN IF NOT EXISTS event_key uuid;
CREATE OR REPLACE FUNCTION records_event_key_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.type = 'event' AND NEW.event_key IS NULL THEN NEW.event_key := NEW.id; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS records_event_key_default ON records;
CREATE TRIGGER records_event_key_default BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION records_event_key_default();
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'records_event_key_check' AND conrelid = 'records'::regclass) THEN
        ALTER TABLE records ADD CONSTRAINT records_event_key_check CHECK (type <> 'event' OR event_key IS NOT NULL) NOT VALID;
    END IF;
END $$;
UPDATE records SET event_key = id WHERE type = 'event' AND event_key IS NULL;
ALTER TABLE records VALIDATE CONSTRAINT records_event_key_check;
CREATE INDEX IF NOT EXISTS records_event_key_idx ON records (event_key) WHERE type = 'event';
CREATE OR REPLACE VIEW records_live AS
    SELECT * FROM records WHERE deleted_at IS NULL AND is_current AND hidden_at IS NULL;

CREATE TABLE IF NOT EXISTS record_link_details (
    link_id    uuid PRIMARY KEY,                          -- memory_control.record_links.id
    class      data_class NOT NULL,
    src_quote  text CHECK (char_length(src_quote) BETWEEN 1 AND 600),
    dst_quote  text CHECK (char_length(dst_quote) BETWEEN 1 AND 600),
    rationale  text CHECK (char_length(rationale) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT record_link_details_not_empty CHECK (src_quote IS NOT NULL OR dst_quote IS NOT NULL OR rationale IS NOT NULL)
);
CREATE OR REPLACE FUNCTION row_class_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE db_class text := current_setting('memory.class', true);
BEGIN
    IF db_class IS NULL OR db_class = '' THEN RAISE EXCEPTION 'memory.class is not set for the database'; END IF;
    IF NEW.class::text <> db_class THEN
        RAISE EXCEPTION 'link details of class % cannot be stored in a database of class %', NEW.class, db_class;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS record_link_details_class_guard ON record_link_details;
CREATE TRIGGER record_link_details_class_guard BEFORE INSERT OR UPDATE ON record_link_details
    FOR EACH ROW EXECUTE FUNCTION row_class_guard();
GRANT SELECT, INSERT, DELETE ON record_link_details TO memory_gateway, memory_worker;

ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS retry_at timestamptz;
ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS busy_retries int NOT NULL DEFAULT 0;
ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS slow_retries smallint NOT NULL DEFAULT 0;
ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS first_busy_at timestamptz;
ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE record_stages ADD COLUMN IF NOT EXISTS claimed_by text;
CREATE INDEX IF NOT EXISTS record_stages_retry_idx ON record_stages (retry_at) WHERE status IN ('pending','failed') AND retry_at IS NOT NULL;
COMMENT ON COLUMN record_stages.retry_at IS 'Retry of a stage with the model not earlier than this time; NULL — immediately';
COMMENT ON COLUMN record_stages.busy_retries IS 'How many times the model was busy since the last success or reset — for display and for the patience of the “now” lane';
COMMENT ON COLUMN record_stages.slow_retries IS 'Outcomes “the model did not respond in time” in a row — the pause before a retry and the sign of a “too long” record';
COMMENT ON COLUMN record_stages.first_busy_at IS 'Start of the current wait for the model (“waiting since 10:12”); NULL — not waiting';
COMMENT ON COLUMN record_stages.claim_token IS 'Claim token of a stage: final writes only with it (a late process does not overwrite another’s result)';
COMMENT ON COLUMN record_stages.claimed_by IS 'Name of the model slot connection of the claiming process: the scheduler uses it to recognize an orphaned stage';

ALTER TYPE source_kind ADD VALUE IF NOT EXISTS 'correction';
CREATE TABLE IF NOT EXISTS record_corrections (
    id          uuid PRIMARY KEY,
    target_id   uuid NOT NULL,
    kind        text NOT NULL CHECK (kind IN ('extraction_error','wrong','outdated','own_note')),
    status      text NOT NULL CHECK (status IN ('planned','proposed','applied','rejected','withdrawn','superseded','cancelled')),
    origin      origin_kind NOT NULL,
    via         text NOT NULL CHECK (via IN ('mcp','workplace','plan')),
    by_person   uuid NOT NULL,
    by_role     text NOT NULL CHECK (by_role IN ('author','participant','space_owner','space_member','reader')),
    key_id      uuid,
    text        text CHECK (text IS NULL OR char_length(text) BETWEEN 1 AND 40000),
    fields      jsonb CHECK (fields IS NULL OR jsonb_typeof(fields) = 'object'),
    quote       text CHECK (quote IS NULL OR char_length(quote) BETWEEN 1 AND 1000),
    quote_match jsonb CHECK (quote_match IS NULL OR jsonb_typeof(quote_match) = 'object'),
    newer_id    uuid,
    result_id   uuid,
    link_id     uuid,
    target_fp   text NOT NULL CHECK (target_fp ~ '^[0-9a-f]{64}$'),
    dedupe      text NOT NULL CHECK (dedupe ~ '^[0-9a-f]{64}$'),
    plan_id     uuid,
    created_at  timestamptz NOT NULL DEFAULT now(),
    decided_by  uuid,
    decided_at  timestamptz,
    CONSTRAINT record_corrections_decided CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
    CONSTRAINT record_corrections_content CHECK (status IN ('planned','proposed') OR (text IS NULL AND fields IS NULL AND quote IS NULL))
);
COMMENT ON TABLE record_corrections IS 'Memory corrections: proposals and applied ones; a person’s words only until applied';
CREATE INDEX IF NOT EXISTS record_corrections_target_idx   ON record_corrections (target_id, status);
CREATE INDEX IF NOT EXISTS record_corrections_result_idx   ON record_corrections (result_id) WHERE result_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS record_corrections_by_idx       ON record_corrections (by_person, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS record_corrections_proposed_idx ON record_corrections (created_at DESC, id DESC) WHERE status = 'proposed';
CREATE UNIQUE INDEX IF NOT EXISTS record_corrections_dedupe_idx ON record_corrections (dedupe) WHERE status IN ('proposed','applied');
GRANT SELECT, INSERT, UPDATE ON record_corrections TO memory_gateway;
GRANT SELECT, INSERT, UPDATE, DELETE ON record_corrections TO memory_worker;
CREATE OR REPLACE FUNCTION mark_deleted_chain(p_record uuid, p_by uuid, p_grace interval DEFAULT interval '7 days')
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
    WITH RECURSIVE chain AS (
        SELECT id, parent_id, supersedes_id, superseded_by_id, source_kind FROM records WHERE id = p_record
        UNION
        SELECT r.id, r.parent_id, r.supersedes_id, r.superseded_by_id, r.source_kind FROM records r JOIN chain c
          ON r.id IN (c.supersedes_id, c.superseded_by_id)
             AND (c.parent_id IS NULL AND r.parent_id IS NULL AND ((c.source_kind IN ('agent') AND r.source_kind IN ('agent'))
                  OR (c.source_kind IN ('upload','folder') AND r.source_kind IN ('upload','folder'))))
    ), tree AS (
        SELECT id FROM chain
        UNION
        SELECT r.id FROM records r JOIN tree t ON r.parent_id = t.id
    )
    UPDATE records SET deleted_at = now(), deleted_by = p_by, purge_after = now() + p_grace, deleted_batch = p_record
    WHERE id IN (SELECT id FROM tree) AND deleted_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION mark_deleted_chain(uuid, uuid, interval) TO memory_gateway, memory_worker;

CREATE INDEX IF NOT EXISTS records_organizer_origin_idx ON records ((attrs->'organizer_transfer'->>'origin'))
  WHERE attrs ? 'organizer_transfer';
CREATE INDEX IF NOT EXISTS records_organizer_return_idx ON records (id) WHERE parent_id IS NULL AND attrs ? 'organizer_return';

CREATE INDEX IF NOT EXISTS records_conv_phase_idx ON records ((attrs->'conversion'->>'phase')) WHERE attrs->'conversion' ? 'phase';

CREATE INDEX IF NOT EXISTS records_source_sha_idx ON records ((attrs->>'source_sha256')) WHERE attrs ? 'source_sha256';
