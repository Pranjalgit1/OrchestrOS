-- Observational utilization history.
-- Worker counters record only the present, so utilization over time cannot be
-- reconstructed later. This is the only metric table: every other metric is
-- derived from the authoritative records at read time and therefore cannot drift.

CREATE TABLE "worker_samples" (
    "id" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "cpuCapacityMillicores" INTEGER NOT NULL,
    "memoryCapacityMiB" INTEGER NOT NULL,
    "cpuAllocatedMillicores" INTEGER NOT NULL,
    "memoryAllocatedMiB" INTEGER NOT NULL,
    "status" "WorkerStatus" NOT NULL,
    "runningExecutions" INTEGER NOT NULL DEFAULT 0,
    "reservedAllocations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_samples_pkey" PRIMARY KEY ("id")
);

-- One row per worker per sampling pass, so a repeated pass cannot double-count.
CREATE UNIQUE INDEX "worker_samples_workerId_capturedAt_key"
  ON "worker_samples"("workerId", "capturedAt");

-- History reads and retention pruning both scan by time.
CREATE INDEX "worker_samples_capturedAt_idx" ON "worker_samples"("capturedAt");

-- Samples are observational, so they are removed with their worker rather than
-- blocking its deletion the way authoritative records do.
ALTER TABLE "worker_samples"
  ADD CONSTRAINT "worker_samples_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "workers"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- A sample is a copy of real accounting, so it obeys the same bounds.
ALTER TABLE "worker_samples"
  ADD CONSTRAINT "worker_samples_cpu_capacity_positive"
    CHECK ("cpuCapacityMillicores" > 0),
  ADD CONSTRAINT "worker_samples_memory_capacity_positive"
    CHECK ("memoryCapacityMiB" > 0),
  ADD CONSTRAINT "worker_samples_cpu_allocated_bounded"
    CHECK ("cpuAllocatedMillicores" >= 0
           AND "cpuAllocatedMillicores" <= "cpuCapacityMillicores"),
  ADD CONSTRAINT "worker_samples_memory_allocated_bounded"
    CHECK ("memoryAllocatedMiB" >= 0
           AND "memoryAllocatedMiB" <= "memoryCapacityMiB"),
  ADD CONSTRAINT "worker_samples_counts_non_negative"
    CHECK ("runningExecutions" >= 0 AND "reservedAllocations" >= 0);
