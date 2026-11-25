-- ============================================================================
-- Roles of the PostgreSQL cluster (run once per cluster)
-- Design: two databases by data class, one gateway, an append-only audit log.
-- Passwords are set at deployment (ALTER ROLE ... PASSWORD); here the roles are created without login.
-- ============================================================================

-- Owner of the schemas and migrations. The only role that changes the structure.
CREATE ROLE memory_admin NOLOGIN;

-- Gateway: reads and writes records (control, open, closed); in audit — INSERT only.
CREATE ROLE memory_gateway NOLOGIN;

-- Queue workers: indexing, summaries, extraction, class transfer, cleanup; in audit — INSERT only.
CREATE ROLE memory_worker NOLOGIN;

-- Reading the audit log: the memory administrator and the information security role.
CREATE ROLE memory_audit_reader NOLOGIN;

-- Audit maintenance service: blanks the text of queries older than 90 days, detaches old partitions.
CREATE ROLE memory_audit_maint NOLOGIN;

-- Owner of the functions that delete test data for good (tp_*): no login, EXECUTE only for memory_worker.
-- The tail of 05-access-model.sql creates it idempotently; it is here for clean clusters and restores.
CREATE ROLE memory_test_purge NOLOGIN;

COMMENT ON ROLE memory_gateway IS 'Single entry point to the memory: the only path to the data';
COMMENT ON ROLE memory_worker IS 'Processing pipeline: the pg-boss queue in control, stages on records';
COMMENT ON ROLE memory_audit_reader IS 'Full log: the memory administrator and the information security role';
COMMENT ON ROLE memory_test_purge IS 'Owner of the tp_* functions: no login, rights only through the functions';

-- Network rule (pg_hba.conf, outside SQL): only memory_gateway and memory_worker connect to the memory_closed
-- database, from the addresses of the gateway and the workers; memory_audit accepts only the INSERT roles and
-- memory_audit_reader. Check at instance start (fail-closed): the gateway runs SELECT 1 against memory_closed
-- as a service role from another address and expects a refusal.
