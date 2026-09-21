-- Preserve real arrival fidelity for jobs created before planned-arrival metadata existed.
UPDATE "jobs"
SET "arrivalAt" = "createdAt"
WHERE "workloadBatchId" IS NULL
  AND "arrivalOffsetSeconds" = 0;

-- Match the queue listing order, which breaks ties on batch sequence.
DROP INDEX IF EXISTS "jobs_status_arrivalAt_createdAt_id_idx";
CREATE INDEX "jobs_status_arrivalAt_createdAt_batchSequence_id_idx"
  ON "jobs"("status", "arrivalAt", "createdAt", "batchSequence", "id");

-- Align SQL lower bounds with the validated API contract.
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_cpu_required_lower_bound"
    CHECK ("cpuRequiredMillicores" >= 100),
  ADD CONSTRAINT "jobs_memory_required_lower_bound"
    CHECK ("memoryRequiredMiB" >= 64);
