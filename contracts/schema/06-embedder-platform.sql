-- ============================================================================
-- Schema · L3 · embedders. Applied on every deploy by a superuser: to memory_control with -v target=control, to
-- memory_open and memory_closed with -v target=records. Idempotent.
-- Run: psql -d <database> -v target=control|records -f 06-embedder-platform.sql
-- The schema registers no embedding model and never changes which one is active: a fresh install has no
-- embedder and searches by keyword until a model is configured; an install upgraded from an earlier version keeps its
-- registry rows and vectors untouched; its vector indexes are rebuilt once in the per-embedder expression form.
-- Each feature adds its own marked block (-- [E:<name>] … -- [/E:<name>]) inside the branch it needs and never
-- reorders the blocks of others.
-- ============================================================================
\if :{?target}
\else
  \set target control
\endif
SELECT :'target' = 'control' AS is_control \gset
\if :is_control
  -- [E:vector-generation] control: the vector generation of a registry row. It is part of the identity of
  -- a reusable vector: raising it (a connection's address or a legacy row's model changed, or an operator's recompute)
  -- makes every stored vector of the row a miss for reuse, so the next indexing asks the model again. Existing rows: 0.
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS vector_generation integer NOT NULL DEFAULT 0;
  -- [/E:vector-generation]
  -- [E:no-model-registration]
  -- retrieval.mode was left by the retrieval-local compose profile: no local models are run, embeddings and rerank go
  -- through the model gateway. The setting had no effect and misled admins, so it is removed.
  DELETE FROM settings WHERE category = 'retrieval' AND key = 'mode';
  -- [/E:no-model-registration]
  -- [E:embedder-profile] control: the embedder profile and the states of a registry row. A row with a profile (JSON: an immutable
  -- "space" — model, dimension, how it is reduced, normalisation, input type, prefixes, instruction — and a mutable
  -- "ops" part) has the id the code derives from its space; a row without one (profile NULL) is a row of an earlier
  -- version and is served as before. connection_slot names the connection the row uses: a = models.embeddings_*,
  -- b = models.embeddings_b_*. candidate — the next model being prepared (at most one); retire_at — kept after a switch;
  -- closed_at — a tombstone: a cancelled candidate or a purged old model keeps its row, so that settings left in a slot
  -- do not register it again. The same columns are in 01-control.sql for a fresh install; here they come to an install
  -- of an earlier version, its rows untouched (defaults: slot a, halfvec, not a candidate). Plain SQL only inside this
  -- block: the tests load it as is.
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS profile jsonb;
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS connection_slot text NOT NULL DEFAULT 'a';
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS index_kind text NOT NULL DEFAULT 'halfvec';
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS candidate boolean NOT NULL DEFAULT false;
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS activated_at timestamptz;
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS retire_at timestamptz;
  ALTER TABLE embedders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
  CREATE UNIQUE INDEX IF NOT EXISTS embedders_one_candidate ON embedders (candidate) WHERE candidate;
  DO $m13$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.embedders'::regclass AND conname = 'embedders_connection_slot_check') THEN
      ALTER TABLE public.embedders ADD CONSTRAINT embedders_connection_slot_check CHECK (connection_slot IN ('a', 'b'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.embedders'::regclass AND conname = 'embedders_index_kind_check') THEN
      ALTER TABLE public.embedders ADD CONSTRAINT embedders_index_kind_check CHECK (index_kind IN ('halfvec', 'bit'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.embedders'::regclass AND conname = 'embedders_state_check') THEN
      ALTER TABLE public.embedders ADD CONSTRAINT embedders_state_check
        CHECK (NOT (active AND candidate) AND (closed_at IS NULL OR NOT (active OR candidate)));
    END IF;
  END
  $m13$;
  -- The vector space of a row never changes: vectors already stored belong to it. Another model, dimension, instruction
  -- or profile space is another embedder with its own id. A new row with a profile names the model and the dimension of
  -- the row in its space; a row of an earlier version (profile NULL) never gets one.
  CREATE OR REPLACE FUNCTION embedders_space_immutable() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $fn$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.profile IS NOT NULL AND (jsonb_typeof(NEW.profile -> 'space') IS DISTINCT FROM 'object'
           OR (NEW.profile -> 'space' ->> 'dims') IS DISTINCT FROM NEW.dims::text
           OR (NEW.profile -> 'space' ->> 'model') IS DISTINCT FROM NEW.model) THEN
        RAISE EXCEPTION 'embedders: the profile space of a new row must name the model and the dimension of the row'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.dims IS DISTINCT FROM OLD.dims OR NEW.model IS DISTINCT FROM OLD.model
       OR NEW.query_instruction IS DISTINCT FROM OLD.query_instruction
       OR (OLD.profile IS NULL) <> (NEW.profile IS NULL)
       OR (OLD.profile -> 'space') IS DISTINCT FROM (NEW.profile -> 'space') THEN
      RAISE EXCEPTION 'embedders: the vector space of embedder % never changes; another model, dimension or profile is a new embedder', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END
  $fn$;
  CREATE OR REPLACE TRIGGER embedders_space_immutable BEFORE INSERT OR UPDATE ON embedders
    FOR EACH ROW EXECUTE FUNCTION embedders_space_immutable();
  -- [/E:embedder-profile]
\else
  -- [E:no-model-registration] records: nothing to do — the vector index of an embedder belongs to its registration, not to
  -- this file.
  -- [/E:no-model-registration]
  -- [E:native-dimension] records: native dimension. The column embedding is halfvec without a dimension: each embedder stores
  -- vectors of its own length, and each embedder with vectors here has one partial HNSW index over the expression
  -- (embedding::halfvec(N)), queried with the same expression. Run-time DDL goes only through the three helpers below
  -- (the worker role has no DDL right on the record tables). Plain SQL only inside this block: the tests load it as is.
  CREATE OR REPLACE FUNCTION memory_embedding_index_ensure(p_embedder text, p_dims int, p_kind text DEFAULT 'halfvec')
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp SET lock_timeout = '5s' AS $fn$
  DECLARE
    v_name text;
    v_pass int;
    v_found boolean := false;
    v_table oid;
    v_am text;
    v_expr boolean;
    v_valid boolean;
    v_pred text;
    v_def text;
  BEGIN
    IF p_embedder IS NULL OR p_embedder !~ '^[a-z0-9][a-z0-9.-]{2,62}$' THEN
      RAISE EXCEPTION 'vector index: invalid embedder id' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_dims IS NULL OR p_dims NOT BETWEEN 8 AND 4000 THEN
      RAISE EXCEPTION 'vector index: dimension must be an integer from 8 to 4000' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_kind IS DISTINCT FROM 'halfvec' THEN
      RAISE EXCEPTION 'vector index: unsupported index kind' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- on a column that still has a fixed dimension the expression folds to the plain column: refuse instead of making a
    -- second plain index (the migration below removes the dimension first)
    IF (SELECT a.atttypmod FROM pg_attribute a
         WHERE a.attrelid = 'public.chunk_embeddings'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped) <> -1 THEN
      RAISE EXCEPTION 'vector index: chunk_embeddings.embedding still has a fixed dimension — apply the schema first'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    v_name := 'chunk_embeddings_hnsw_' || left(md5(p_embedder), 12);
    -- Pass 1 reads the catalog without any lock: an index that is there returns at once, even while another session
    -- builds the index of some embedder. Pass 2 runs under the advisory lock of this embedder (the index queue runs two
    -- jobs at once per worker: one builder per embedder) and looks again before it drops or creates anything; waiting
    -- for that lock obeys the lock timeout of this function.
    FOR v_pass IN 1..2 LOOP
      v_found := false;
      SELECT true, x.indrelid, a.amname, x.indexprs IS NOT NULL, x.indisvalid, pg_get_expr(x.indpred, x.indrelid), pg_get_indexdef(c.oid)
        INTO v_found, v_table, v_am, v_expr, v_valid, v_pred, v_def
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index x ON x.indexrelid = c.oid JOIN pg_am a ON a.oid = c.relam
       WHERE n.nspname = 'public' AND c.relname = v_name;
      IF v_found THEN
        IF v_table <> 'public.chunk_embeddings'::regclass OR v_am <> 'hnsw' OR NOT v_expr THEN
          RAISE EXCEPTION 'vector index: the name of the index is taken by another object' USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        IF v_valid AND v_pred IS NOT DISTINCT FROM format('(embedder_id = %L::text)', p_embedder)
           AND position(format('::halfvec(%s)', p_dims) IN v_def) > 0 THEN
          RETURN v_name;                                        -- already there: no lock on the table was taken
        ELSIF v_valid THEN
          RAISE EXCEPTION 'vector index: the embedder already has an index of another dimension' USING ERRCODE = 'object_not_in_prerequisite_state';
        ELSIF v_pass = 2 THEN
          EXECUTE format('DROP INDEX public.%I', v_name);       -- left by an interrupted build: build again
        END IF;
      END IF;
      IF v_pass = 1 THEN
        PERFORM pg_advisory_xact_lock(hashtext('memory_embedding_index'), hashtext(p_embedder));
      END IF;
    END LOOP;
    EXECUTE format('CREATE INDEX %I ON public.chunk_embeddings USING hnsw ((embedding::halfvec(%s)) halfvec_cosine_ops) '
                   'WITH (m = 16, ef_construction = 128) WHERE embedder_id = %L', v_name, p_dims, p_embedder);
    RETURN v_name;
  END
  $fn$;

  CREATE OR REPLACE FUNCTION memory_embedding_index_drop(p_embedder text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp SET lock_timeout = '5s' AS $fn$
  DECLARE
    v_name text;
  BEGIN
    IF p_embedder IS NULL OR p_embedder !~ '^[a-z0-9][a-z0-9.-]{2,62}$' THEN
      RAISE EXCEPTION 'vector index: invalid embedder id' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_name := 'chunk_embeddings_hnsw_' || left(md5(p_embedder), 12);
    PERFORM pg_advisory_xact_lock(hashtext('memory_embedding_index'), hashtext(p_embedder));
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index x ON x.indexrelid = c.oid
                     JOIN pg_am a ON a.oid = c.relam
                    WHERE n.nspname = 'public' AND c.relname = v_name AND x.indrelid = 'public.chunk_embeddings'::regclass AND a.amname = 'hnsw') THEN
      RETURN false;
    END IF;
    EXECUTE format('DROP INDEX public.%I', v_name);
    RETURN true;
  END
  $fn$;

  CREATE OR REPLACE FUNCTION memory_embedding_index_state(p_embedder text)
  RETURNS TABLE(index_name text, kind text, dims int, valid boolean, size_bytes bigint) LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, public, pg_temp AS $fn$
  BEGIN
    IF p_embedder IS NULL OR p_embedder !~ '^[a-z0-9][a-z0-9.-]{2,62}$' THEN
      RAISE EXCEPTION 'vector index: invalid embedder id' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
      SELECT c.relname::text, 'halfvec'::text, substring(pg_get_indexdef(c.oid) FROM 'halfvec\((\d+)\)')::int, x.indisvalid, pg_relation_size(c.oid)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index x ON x.indexrelid = c.oid JOIN pg_am a ON a.oid = c.relam
       WHERE n.nspname = 'public' AND c.relname = 'chunk_embeddings_hnsw_' || left(md5(p_embedder), 12)
         AND x.indrelid = 'public.chunk_embeddings'::regclass AND a.amname = 'hnsw';
  END
  $fn$;

  REVOKE ALL ON FUNCTION memory_embedding_index_ensure(text, int, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION memory_embedding_index_drop(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION memory_embedding_index_state(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION memory_embedding_index_ensure(text, int, text) TO memory_worker;
  GRANT EXECUTE ON FUNCTION memory_embedding_index_drop(text) TO memory_worker;
  GRANT EXECUTE ON FUNCTION memory_embedding_index_state(text) TO memory_worker;

  -- Step 1, an install upgraded from a fixed dimension (halfvec(2048)): remove the dimension. Only the catalog changes:
  -- no vector is recomputed or rewritten. A plain HNSW index cannot exist on a column without a dimension, so the plain
  -- indexes go first; step 2 builds their expression form. Skipped once the column has no dimension.
  DO $mig$
  DECLARE i record;
  BEGIN
    PERFORM set_config('lock_timeout', '10s', true);
    IF (SELECT a.atttypmod FROM pg_attribute a
         WHERE a.attrelid = 'public.chunk_embeddings'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped) <> -1 THEN
      FOR i IN SELECT c.relname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_am a ON a.oid = c.relam
                WHERE x.indrelid = 'public.chunk_embeddings'::regclass AND a.amname = 'hnsw' AND x.indexprs IS NULL LOOP
        EXECUTE format('DROP INDEX public.%I', i.relname);
      END LOOP;
      ALTER TABLE public.chunk_embeddings ALTER COLUMN embedding TYPE halfvec;
    END IF;
  END
  $mig$;

  -- Step 2, every deploy: each embedder with vectors in this database has its index (a no-op when it is there). Odd old
  -- data of one embedder is a warning and does not stop the deploy: an id outside the rule of the helpers, vectors of
  -- mixed length (SQLSTATE class 22), a refusal of the helper (55000: an index of another dimension, the name taken).
  -- Every other failure stops the deploy — a busy table (lock timeout: apply the schema again), out of shared memory,
  -- memory or disk while the index is built: step 1 has already removed the plain index, so a deploy that went on would
  -- leave the install without any vector index.
  DO $idx$
  DECLARE
    ids text[];
    id text;
    dims int;
  BEGIN
    -- ids and dimension are read by statements of their own: CREATE INDEX refuses a table that a still running query of
    -- this session reads (an open loop over it, or a subquery in the call of the helper)
    SELECT array_agg(DISTINCT embedder_id ORDER BY embedder_id) INTO ids FROM public.chunk_embeddings;
    FOREACH id IN ARRAY coalesce(ids, '{}') LOOP
      IF id !~ '^[a-z0-9][a-z0-9.-]{2,62}$' THEN
        RAISE WARNING 'no vector index for embedder %: the id does not match the rule ^[a-z0-9][a-z0-9.-]{2,62}$ (lower-case letters, digits, dots and hyphens; 3 to 63 characters). Keyword search keeps working, for new records too; vector search and new vectors stop for this embedder until the model is registered under an id that matches the rule', id;
        CONTINUE;
      END IF;
      BEGIN
        SELECT vector_dims(c.embedding) INTO dims FROM public.chunk_embeddings c WHERE c.embedder_id = id LIMIT 1;
        PERFORM memory_embedding_index_ensure(id, dims);
      EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE LIKE '22%' OR SQLSTATE = '55000' THEN
          RAISE WARNING 'no vector index for embedder %: %', id, SQLERRM;
        ELSE
          RAISE;
        END IF;
      END;
    END LOOP;
  END
  $idx$;
  -- [/E:native-dimension]
  -- [E:fts-language] records: the full-text language is a property of the install. One row retrieval_config names the
  -- PostgreSQL text search configurations the stored chunks.tsv were built with; a trigger fills tsv on insert (and on a
  -- change of the text), so the language can differ from install to install and the gateway builds its queries from the
  -- applied value. A new install has the row from 02-records.sql ({english}). An install of an earlier version had
  -- tsv generated in one configuration: the row gets that configuration, the column keeps every stored value (DROP
  -- EXPRESSION changes the catalog only, no table rewrite) — its index and its search results do not change. Plain SQL
  -- only inside this block: the tests load it as is.
  CREATE OR REPLACE FUNCTION chunks_fts_fill() RETURNS trigger LANGUAGE plpgsql
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

  DO $m32$
  DECLARE
    v_cfg text;
  BEGIN
    PERFORM set_config('lock_timeout', '10s', true);
    CREATE TABLE IF NOT EXISTS public.retrieval_config (
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
    -- tsv still generated: an install of an earlier version. Its configuration is read from the expression itself.
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.chunks'::regclass AND a.attname = 'tsv'
                AND NOT a.attisdropped AND a.attgenerated = 's') THEN
      SELECT substring(pg_get_expr(d.adbin, d.adrelid) FROM 'to_tsvector\(''([a-z_]+)''::regconfig') INTO v_cfg
        FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'public.chunks'::regclass AND a.attname = 'tsv';
      IF v_cfg IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_ts_config t WHERE t.cfgname = v_cfg AND pg_catalog.pg_ts_config_is_visible(t.oid)) THEN
        RAISE EXCEPTION 'the configuration of the generated column chunks.tsv is not recognised — nothing changed';
      END IF;
      INSERT INTO public.retrieval_config (fts_configs) VALUES (ARRAY[v_cfg])
        ON CONFLICT (one) DO UPDATE SET fts_configs = EXCLUDED.fts_configs, fts_pending = NULL, fts_cursor = NULL, updated_at = now();
      ALTER TABLE public.chunks ALTER COLUMN tsv DROP EXPRESSION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.retrieval_config) THEN
      RAISE WARNING 'retrieval_config has no row: new chunks get no full-text vector until it is set (health check fts_index)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.chunks'::regclass AND tgname = 'chunks_fts_fill' AND NOT tgisinternal) THEN
      CREATE TRIGGER chunks_fts_fill BEFORE INSERT OR UPDATE OF text ON public.chunks FOR EACH ROW EXECUTE FUNCTION chunks_fts_fill();
    END IF;
  END
  $m32$;
  CREATE INDEX IF NOT EXISTS chunks_tsv_null_idx ON chunks (id) WHERE tsv IS NULL;
  GRANT SELECT ON retrieval_config TO memory_gateway, memory_worker;
  GRANT UPDATE ON retrieval_config TO memory_worker;
  -- the row is written by the schema; a row lost on an empty database is written again by the worker's reconciliation
  GRANT INSERT ON retrieval_config TO memory_worker;

  -- The title index of one configuration: GIN over to_tsvector('<config>', title), the expression the gateway queries.
  -- An index with the same expression under any name counts; a new one is
  -- records_title_fts_<config>_idx. Run-time DDL of the worker goes only through this helper (no DDL right on records):
  -- the name is checked by its rule and must be a configuration of this database; nothing else reaches the SQL text.
  CREATE OR REPLACE FUNCTION memory_fts_title_index_ensure(p_config text)
  RETURNS text LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp SET lock_timeout = '5s' AS $fn$
  DECLARE
    v_name text;
    v_have text;
    v_pass int;
  BEGIN
    IF p_config IS NULL OR p_config !~ '^[a-z_]{1,40}$' OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_ts_config t WHERE t.cfgname = p_config AND pg_catalog.pg_ts_config_is_visible(t.oid)) THEN
      RAISE EXCEPTION 'title index: unknown text search configuration' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_name := 'records_title_fts_' || p_config || '_idx';
    FOR v_pass IN 1..2 LOOP
      SELECT c.relname INTO v_have
        FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_am a ON a.oid = c.relam
       WHERE x.indrelid = 'public.records'::regclass AND a.amname = 'gin' AND x.indisvalid
         AND pg_get_expr(x.indexprs, x.indrelid) = format('to_tsvector(%L::regconfig, title)', p_config)
         AND pg_get_expr(x.indpred, x.indrelid) = '(title IS NOT NULL)'
       ORDER BY c.relname LIMIT 1;
      IF v_have IS NOT NULL THEN
        RETURN v_have;
      END IF;
      IF v_pass = 1 THEN
        PERFORM pg_advisory_xact_lock(hashtext('memory_fts_title_index'), hashtext(p_config));
      END IF;
    END LOOP;
    -- an invalid index of this name is left by an interrupted build: build again
    IF to_regclass(format('public.%I', v_name)) IS NOT NULL THEN
      EXECUTE format('DROP INDEX public.%I', v_name);
    END IF;
    EXECUTE format('CREATE INDEX %I ON public.records USING gin (to_tsvector(%L::regconfig, title)) WHERE title IS NOT NULL', v_name, p_config);
    RETURN v_name;
  END
  $fn$;
  REVOKE ALL ON FUNCTION memory_fts_title_index_ensure(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION memory_fts_title_index_ensure(text) TO memory_worker;

  -- After a change of the language: drop the title index of each configuration that is no longer applied (nor that of a
  -- rebuild in progress), so records is not written into an index nobody queries. Only indexes this file makes — the
  -- name records_title_fts_<config>_idx AND the expression of that configuration; any other index is left alone.
  -- Without a config row nothing is dropped.
  CREATE OR REPLACE FUNCTION memory_fts_title_index_prune()
  RETURNS text[] LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp SET lock_timeout = '5s' AS $fn$
  DECLARE
    v_keep    text[];
    v_name    text;
    v_dropped text[] := '{}';
  BEGIN
    SELECT rc.fts_configs || coalesce(rc.fts_pending, '{}') INTO v_keep FROM public.retrieval_config rc LIMIT 1;
    IF v_keep IS NULL OR cardinality(v_keep) = 0 THEN
      RETURN v_dropped;
    END IF;
    FOR v_name IN
      SELECT c.relname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
       WHERE x.indrelid = 'public.records'::regclass AND c.relname ~ '^records_title_fts_[a-z_]{1,40}_idx$'
         AND pg_get_expr(x.indexprs, x.indrelid) = format('to_tsvector(%L::regconfig, title)', substring(c.relname FROM '^records_title_fts_([a-z_]{1,40})_idx$'))
         AND NOT (substring(c.relname FROM '^records_title_fts_([a-z_]{1,40})_idx$') = ANY (v_keep))
       ORDER BY c.relname
    LOOP
      EXECUTE format('DROP INDEX public.%I', v_name);
      v_dropped := v_dropped || v_name;
    END LOOP;
    RETURN v_dropped;
  END
  $fn$;
  REVOKE ALL ON FUNCTION memory_fts_title_index_prune() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION memory_fts_title_index_prune() TO memory_worker;

  -- every deploy: each applied configuration (and that of a rebuild in progress) has its title index
  DO $m32t$
  DECLARE
    cfgs text[];
    cfg  text;
  BEGIN
    SELECT rc.fts_configs || coalesce(rc.fts_pending, '{}') INTO cfgs FROM public.retrieval_config rc LIMIT 1;
    FOREACH cfg IN ARRAY coalesce(cfgs, '{}') LOOP
      PERFORM memory_fts_title_index_ensure(cfg);
    END LOOP;
  END
  $m32t$;
  -- [/E:fts-language]
  -- [E:vector-generation] Reuse vectors without updating chunks (which would publish records to the edge).
  ALTER TABLE chunk_embeddings ADD COLUMN IF NOT EXISTS input_hash bytea;
  -- The source each vector was computed with; a vector of another source is neither reused nor searched
  ALTER TABLE chunk_embeddings ADD COLUMN IF NOT EXISTS source text;
  -- [/E:vector-generation]
\endif
