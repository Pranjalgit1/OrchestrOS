-- Execution records become writable in this phase, so the invariants the
-- application maintains are also enforced by the database.
-- job_executions is empty before this migration, so every constraint is safe to
-- add without backfilling.

-- Listing executions filters by status and orders by creation time.
CREATE INDEX "job_executions_status_createdAt_idx"
  ON "job_executions"("status", "createdAt");

-- Captured output is bounded. The application caps each stream before writing;
-- this keeps a bug from storing an unbounded container log.
ALTER TABLE "job_executions"
  ADD CONSTRAINT "job_executions_stdout_bounded"
    CHECK ("stdout" IS NULL OR char_length("stdout") <= 16384),
  ADD CONSTRAINT "job_executions_stderr_bounded"
    CHECK ("stderr" IS NULL OR char_length("stderr") <= 16384);

-- Container exit codes are a byte; -1 records "the daemon reported no code".
ALTER TABLE "job_executions"
  ADD CONSTRAINT "job_executions_exit_code_range"
    CHECK ("exitCode" IS NULL OR ("exitCode" >= -1 AND "exitCode" <= 255));

-- Container identifiers are daemon-assigned hex digests, never free text.
ALTER TABLE "job_executions"
  ADD CONSTRAINT "job_executions_container_id_format"
    CHECK ("containerId" IS NULL OR "containerId" ~ '^[0-9a-f]{12,128}$');

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_container_id_format"
    CHECK ("containerId" IS NULL OR "containerId" ~ '^[0-9a-f]{12,128}$');

-- A finished execution always records when it finished.
ALTER TABLE "job_executions"
  ADD CONSTRAINT "job_executions_terminal_has_completed_at"
    CHECK (
      "status" NOT IN ('COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED')
      OR "completedAt" IS NOT NULL
    );

-- An execution that reached a container also recorded when it started.
ALTER TABLE "job_executions"
  ADD CONSTRAINT "job_executions_container_implies_started"
    CHECK ("containerId" IS NULL OR "startedAt" IS NOT NULL);
