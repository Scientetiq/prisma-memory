CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector >= 0.7 (halfvec)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE record_type        AS ENUM ('document','transcript','event','summary','profile','note');
CREATE TYPE data_class         AS ENUM ('open','closed');
CREATE TYPE audience_kind      AS ENUM ('space','people');
CREATE TYPE source_kind        AS ENUM ('transcriber','upload','folder','agent','pipeline','export','correction');
CREATE TYPE acquisition_method AS ENUM ('source_document','extracted_by_model','stated_by_human','inferred_by_agent');
CREATE TYPE origin_kind        AS ENUM ('human','agent');
CREATE TYPE event_kind         AS ENUM ('decision','action','question_risk','fact');
CREATE TYPE stage_name         AS ENUM ('converted','indexed','summary','events','entities','described','moved');
CREATE TYPE stage_status       AS ENUM ('pending','running','done','failed','skipped');

CREATE TABLE records (
    id               uuid PRIMARY KEY,
    type             record_type NOT NULL,
    class            data_class NOT NULL,
    space_id         uuid NOT NULL,
    audience         audience_kind NOT NULL DEFAULT 'space',
    owner_id         uuid NOT NULL,                       -- control.people
    source_kind      source_kind NOT NULL,
    source_ref       text,
    parent_id        uuid REFERENCES records(id) ON DELETE CASCADE,
    locator          jsonb,
    method           acquisition_method NOT NULL,
    origin           origin_kind NOT NULL DEFAULT 'agent',
    confirmed_at     timestamptz,
    confirmed_by     uuid,
    occurred_at      timestamptz NOT NULL,
    ingested_at      timestamptz NOT NULL DEFAULT now(),
    title            text,
    summary_line     text,
    event_kind       event_kind,
    domain_tags      text[] NOT NULL DEFAULT '{}',
    token_count      int,
    source_hash      bytea,
    version          int NOT NULL DEFAULT 1,
    supersedes_id    uuid REFERENCES records(id) ON DELETE SET NULL,
    superseded_by_id uuid REFERENCES records(id) ON DELETE SET NULL,
    is_current       boolean NOT NULL DEFAULT true,
    valid_from       timestamptz,
    valid_to         timestamptz,
    processor        jsonb,                               -- {"model":"...","prompt":"events-v3","embedder":"<embedder id>"}
    attrs            jsonb NOT NULL DEFAULT '{}'::jsonb,
    deleted_at       timestamptz,
    deleted_by       uuid,
    purge_after      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    hidden_at        timestamptz,
    deleted_batch    uuid,
    event_key        uuid,
    CONSTRAINT records_event_key_check CHECK (type <> 'event' OR event_key IS NOT NULL),
    CHECK ((type = 'event') = (event_kind IS NOT NULL)),
    CHECK (deleted_at IS NULL OR purge_after IS NOT NULL),
    CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
    CHECK (version >= 1)
);
COMMENT ON TABLE records IS 'Single record model: six types, a core of nine fields as columns, the rest in attrs';
COMMENT ON COLUMN records.attrs IS 'Optional fields: for events — rationale, alternatives, approved_by, outcome, actors; for transcripts — participants, meeting_id; for documents — pages, source_path';

CREATE INDEX records_space_time_idx     ON records (space_id, type, occurred_at DESC) WHERE deleted_at IS NULL AND is_current;
CREATE INDEX records_owner_idx          ON records (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX records_parent_idx         ON records (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX records_source_hash_idx    ON records (source_hash) WHERE source_hash IS NOT NULL;
CREATE INDEX records_source_ref_idx     ON records (source_kind, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX records_purge_idx          ON records (purge_after) WHERE deleted_at IS NOT NULL;
CREATE INDEX records_batch_idx          ON records (deleted_batch) WHERE deleted_batch IS NOT NULL;
CREATE INDEX records_event_kind_idx     ON records (event_kind, occurred_at DESC) WHERE type = 'event' AND deleted_at IS NULL;
CREATE INDEX records_event_key_idx      ON records (event_key) WHERE type = 'event';
CREATE INDEX records_domain_tags_idx    ON records USING gin (domain_tags);
CREATE INDEX records_title_raw_idx      ON records USING gin (to_tsvector('simple', title))  WHERE title IS NOT NULL;
CREATE INDEX records_organizer_origin_idx ON records ((attrs->'organizer_transfer'->>'origin')) WHERE attrs ? 'organizer_transfer';
CREATE INDEX records_organizer_return_idx ON records (id) WHERE parent_id IS NULL AND attrs ? 'organizer_return';
CREATE INDEX records_conv_phase_idx ON records ((attrs->'conversion'->>'phase')) WHERE attrs->'conversion' ? 'phase';
CREATE INDEX records_source_sha_idx ON records ((attrs->>'source_sha256')) WHERE attrs ? 'source_sha256';

CREATE OR REPLACE FUNCTION records_class_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE db_class text := current_setting('memory.class', true);
BEGIN
    IF db_class IS NULL OR db_class = '' THEN
        RAISE EXCEPTION 'memory.class is not set for the database: ALTER DATABASE ... SET memory.class = ''open''|''closed''';
    END IF;
    IF NEW.class::text <> db_class THEN
        RAISE EXCEPTION 'a record of class % cannot be stored in a database of class %', NEW.class, db_class;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;
CREATE TRIGGER records_class_guard BEFORE INSERT OR UPDATE ON records FOR EACH ROW EXECUTE FUNCTION records_class_guard();

CREATE OR REPLACE FUNCTION records_event_key_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.type = 'event' AND NEW.event_key IS NULL THEN NEW.event_key := NEW.id; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS records_event_key_default ON records;
CREATE TRIGGER records_event_key_default BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION records_event_key_default();


CREATE TABLE record_content (
    record_id      uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
    text           text NOT NULL,
    original_key   text,
    original_mime  text,
    original_bytes bigint,
    pages          int,
    duration_sec   int,
    language       text,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE record_people (
    record_id  uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    person_id  uuid NOT NULL,                             -- control.people
    PRIMARY KEY (record_id, person_id)
);
CREATE INDEX record_people_person_idx ON record_people (person_id);

CREATE TABLE record_placements (
    record_id  uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    space_id   uuid NOT NULL,
    placed_by  uuid,
    placed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (record_id, space_id)
);

CREATE TABLE record_entities (
    record_id   uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    entity_id   uuid NOT NULL,
    role        text NOT NULL DEFAULT 'mentioned',        -- mentioned | customer | deal | participant | owner | author
    method      acquisition_method NOT NULL,
    confidence  real,
    locator     jsonb,
    PRIMARY KEY (record_id, entity_id, role)
);
CREATE INDEX record_entities_entity_idx ON record_entities (entity_id);

CREATE TABLE record_stages (
    record_id   uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    stage       stage_name NOT NULL,
    status      stage_status NOT NULL DEFAULT 'pending',
    version     text,
    attempts    int NOT NULL DEFAULT 0,
    last_error  text,
    duration_ms int,
    terminal    boolean NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    retry_at      timestamptz,
    busy_retries  int NOT NULL DEFAULT 0,
    slow_retries  smallint NOT NULL DEFAULT 0,
    first_busy_at timestamptz,
    claim_token   uuid,
    claimed_by    text,
    PRIMARY KEY (record_id, stage)
);
CREATE INDEX record_stages_todo_idx ON record_stages (stage, status) WHERE status IN ('pending','failed');
CREATE INDEX record_stages_retry_idx ON record_stages (retry_at) WHERE status IN ('pending','failed') AND retry_at IS NOT NULL;
COMMENT ON COLUMN record_stages.retry_at IS 'Retry of a stage with the model not earlier than this time; NULL — immediately';
COMMENT ON COLUMN record_stages.busy_retries IS 'How many times the model was busy since the last success or reset — for display and for the patience of the “now” lane';
COMMENT ON COLUMN record_stages.slow_retries IS 'Outcomes “the model did not respond in time” in a row — the pause before a retry and the sign of a “too long” record';
COMMENT ON COLUMN record_stages.first_busy_at IS 'Start of the current wait for the model (“waiting since 10:12”); NULL — not waiting';
COMMENT ON COLUMN record_stages.claim_token IS 'Claim token of a stage: final writes only with it (a late process does not overwrite another’s result)';
COMMENT ON COLUMN record_stages.claimed_by IS 'Name of the model slot connection of the claiming process: the scheduler uses it to recognize an orphaned stage';

CREATE TABLE chunks (
    id             uuid PRIMARY KEY,
    record_id      uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    ordinal        int  NOT NULL,
    text           text NOT NULL,
    token_count    int  NOT NULL,
    section_path   text,                                  -- '2 > 2.1'
    page_from      int,  page_to int,
    time_from_sec  int,  time_to_sec int,
    space_id       uuid NOT NULL,
    audience       audience_kind NOT NULL,
    type           record_type NOT NULL,
    occurred_at    timestamptz NOT NULL,
    tsv            tsvector,                              -- filled by the trigger chunks_fts_fill (retrieval_config)
    raw_terms      tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (record_id, ordinal)
);
CREATE INDEX chunks_tsv_idx        ON chunks USING gin (tsv);
CREATE INDEX chunks_raw_terms_idx  ON chunks USING gin (raw_terms);
CREATE INDEX chunks_space_time_idx ON chunks (space_id, occurred_at DESC);
-- a chunk without tsv is a defect the health check fts_index counts (cheap: normally the index is empty)
CREATE INDEX chunks_tsv_null_idx   ON chunks (id) WHERE tsv IS NULL;

-- Full-text language of this database: one row. fts_configs — the PostgreSQL text search
-- configurations (1 to 3) the stored chunks.tsv values were built with; the gateway builds its queries only from them.
-- fts_pending — the configurations of a rebuild in progress (new rows get them at once), fts_cursor — how far the
-- rebuild got; stats_* — for the term statistics. A new install searches in English; the setting
-- search.fts_configs changes it (the worker applies it). The same table comes to an upgraded install through
-- 06-embedder-platform.sql, with the configuration its generated column had.
CREATE TABLE retrieval_config (
    one          boolean PRIMARY KEY DEFAULT true CHECK (one),
    fts_configs  text[] NOT NULL CHECK (cardinality(fts_configs) BETWEEN 1 AND 3 AND array_position(fts_configs, NULL) IS NULL
                                        AND array_to_string(fts_configs, ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40}){0,2}$'),
    fts_pending  text[] CHECK (fts_pending IS NULL OR (cardinality(fts_pending) BETWEEN 1 AND 3 AND array_position(fts_pending, NULL) IS NULL
                                        AND array_to_string(fts_pending, ',') ~ '^[a-z_]{1,40}(,[a-z_]{1,40}){0,2}$')),
    fts_cursor   uuid,
    stats_docs   bigint,
    stats_at     timestamptz,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO retrieval_config (fts_configs) VALUES ('{english}');

-- tsv of a chunk: its text in every configuration of the rebuild in progress, else of the applied ones. SECURITY INVOKER:
-- both service roles write chunks and read retrieval_config. No row (a defect) — tsv stays NULL, health reports it.
CREATE FUNCTION chunks_fts_fill() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
    cfgs text[];
    cfg  text;
    v    tsvector;
BEGIN
    SELECT COALESCE(rc.fts_pending, rc.fts_configs) INTO cfgs FROM public.retrieval_config rc LIMIT 1;
    v := NULL;
    FOREACH cfg IN ARRAY coalesce(cfgs, '{}') LOOP
        v := CASE WHEN v IS NULL THEN to_tsvector(cfg::regconfig, NEW.text) ELSE v || to_tsvector(cfg::regconfig, NEW.text) END;
    END LOOP;
    NEW.tsv := v;
    RETURN NEW;
END
$fn$;
CREATE TRIGGER chunks_fts_fill BEFORE INSERT OR UPDATE OF text ON chunks FOR EACH ROW EXECUTE FUNCTION chunks_fts_fill();

CREATE TABLE chunk_embeddings (
    chunk_id     uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    embedder_id  text NOT NULL,                           -- control.embedders.id
    embedding    halfvec NOT NULL,                        -- no fixed dimension: each embedder stores its own
    input_hash   bytea,                                   -- SHA-256 of the vector source and the exact input before the adapter prefix; NULL is not reusable
    source       text,                                    -- the vector source (embedder.ts vectorSource); NULL — stored by an earlier version, the source the worker adopted
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chunk_id, embedder_id)
);
-- The dimension belongs to the embedder. Each embedder gets one partial HNSW index over the expression
-- (embedding::halfvec(N)) WHERE embedder_id = '<id>', made by memory_embedding_index_ensure (06-embedder-platform.sql,
-- records target) before its first vector is stored. A fresh install has no embedder and so no such index.

CREATE TABLE record_tombstones (
    id             uuid PRIMARY KEY,
    source_hash    bytea,
    reason         text NOT NULL CHECK (reason IN ('purged','moved')),
    moved_to_class data_class,
    at             timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW records_live AS
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

GRANT SELECT, INSERT, UPDATE ON records, record_content, record_people, record_placements, record_entities, record_stages, chunks, chunk_embeddings, record_tombstones TO memory_gateway, memory_worker;
GRANT SELECT ON records_live TO memory_gateway, memory_worker;
GRANT SELECT ON retrieval_config TO memory_gateway, memory_worker;   -- the trigger and the queries read it
GRANT UPDATE ON retrieval_config TO memory_worker;                   -- the worker applies search.fts_configs
GRANT DELETE ON record_people, record_placements, record_entities TO memory_gateway;
GRANT DELETE ON records, record_content, record_people, record_placements, record_entities, record_stages, chunks, chunk_embeddings TO memory_worker;
GRANT DELETE ON record_tombstones TO memory_worker;
GRANT EXECUTE ON FUNCTION mark_deleted(uuid, uuid, interval) TO memory_gateway, memory_worker;
GRANT EXECUTE ON FUNCTION purge_due(int) TO memory_worker;

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

CREATE TABLE IF NOT EXISTS record_corrections (
    id          uuid PRIMARY KEY,                                    -- UUIDv7 = correction_id
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
    link_id     uuid,                                                -- control.record_links.id
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

-- Deleting a version chain in one trash batch: the record, its versions (supersedes_id / superseded_by_id) and the trees of
-- derived rows. The chain rule is chainLinkSql of packages/shared/src/version-chain.ts: both rows are roots and both
-- are agent notes or both are documents (upload, folder). For any other record it behaves like mark_deleted.
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
