-- CreateEnum
CREATE TYPE "WorkloadPattern" AS ENUM (
  'LIGHT',
  'MEDIUM',
  'HEAVY',
  'CONSTANT',
  'BURST',
  'INCREASING',
  'DECREASING',
  'PERIODIC',
  'CUSTOM'
);

-- CreateTable
CREATE TABLE "workload_batches" (
  "id" UUID NOT NULL,
  "seed" INTEGER NOT NULL,
  "jobCount" INTEGER NOT NULL,
  "pattern" "WorkloadPattern" NOT NULL,
  "generatorVersion" VARCHAR(16) NOT NULL,
  "parameters" JSONB NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "sourceBatchId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workload_batches_pkey" PRIMARY KEY ("id")
);

-- AlterTable: defaults safely backfill any existing manually-created jobs.
ALTER TABLE "jobs"
  ADD COLUMN "workloadSize" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "workloadBatchId" UUID,
  ADD COLUMN "batchSequence" INTEGER,
  ADD COLUMN "arrivalOffsetSeconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "arrivalAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Replace the queue-support index with planned-arrival ordering.
DROP INDEX "jobs_status_createdAt_id_idx";
CREATE INDEX "jobs_status_arrivalAt_createdAt_id_idx"
  ON "jobs"("status", "arrivalAt", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_workloadBatchId_batchSequence_key"
  ON "jobs"("workloadBatchId", "batchSequence");
CREATE INDEX "jobs_workloadBatchId_idx" ON "jobs"("workloadBatchId");
CREATE INDEX "workload_batches_sourceBatchId_idx" ON "workload_batches"("sourceBatchId");
CREATE INDEX "workload_batches_createdAt_idx" ON "workload_batches"("createdAt");

-- AddForeignKey
ALTER TABLE "workload_batches"
  ADD CONSTRAINT "workload_batches_sourceBatchId_fkey"
  FOREIGN KEY ("sourceBatchId") REFERENCES "workload_batches"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_workloadBatchId_fkey"
  FOREIGN KEY ("workloadBatchId") REFERENCES "workload_batches"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Workload generation and arrival invariants.
ALTER TABLE "workload_batches"
  ADD CONSTRAINT "workload_batches_seed_range"
    CHECK ("seed" BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT "workload_batches_job_count_allowed"
    CHECK ("jobCount" IN (10, 25, 50, 100));

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_workload_size_range"
    CHECK ("workloadSize" BETWEEN 1 AND 100000000),
  ADD CONSTRAINT "jobs_arrival_offset_range"
    CHECK ("arrivalOffsetSeconds" BETWEEN 0 AND 86400),
  ADD CONSTRAINT "jobs_batch_sequence_positive"
    CHECK ("batchSequence" IS NULL OR "batchSequence" > 0),
  ADD CONSTRAINT "jobs_batch_identity_complete"
    CHECK (("workloadBatchId" IS NULL) = ("batchSequence" IS NULL)),
  ADD CONSTRAINT "jobs_cpu_required_upper_bound"
    CHECK ("cpuRequiredMillicores" <= 64000),
  ADD CONSTRAINT "jobs_memory_required_upper_bound"
    CHECK ("memoryRequiredMiB" <= 131072),
  ADD CONSTRAINT "jobs_estimated_duration_upper_bound"
    CHECK ("estimatedDurationSeconds" <= 86400);
