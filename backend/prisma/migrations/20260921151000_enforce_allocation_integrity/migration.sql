-- Job executions are created only after a resource allocation exists.
-- Existing Phase 1 code does not write either table, so these columns are empty and safe to tighten.
ALTER TABLE "job_executions"
  DROP CONSTRAINT "job_executions_workerId_fkey",
  DROP CONSTRAINT "job_executions_allocationId_fkey",
  ALTER COLUMN "workerId" SET NOT NULL,
  ALTER COLUMN "allocationId" SET NOT NULL;

-- Candidate keys support an identity-safe composite execution/allocation relationship.
CREATE UNIQUE INDEX "resource_allocations_id_jobId_workerId_key"
  ON "resource_allocations"("id", "jobId", "workerId");

CREATE UNIQUE INDEX "job_executions_allocationId_jobId_workerId_key"
  ON "job_executions"("allocationId", "jobId", "workerId");

ALTER TABLE "job_executions"
  ADD CONSTRAINT "job_executions_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "workers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "job_executions_allocation_identity_fkey"
    FOREIGN KEY ("allocationId", "jobId", "workerId")
    REFERENCES "resource_allocations"("id", "jobId", "workerId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- A job can have historical released/rolled-back allocations but only one active reservation.
CREATE UNIQUE INDEX "resource_allocations_one_reserved_per_job"
  ON "resource_allocations"("jobId")
  WHERE "status" = 'RESERVED';
