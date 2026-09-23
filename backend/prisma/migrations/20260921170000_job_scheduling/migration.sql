-- CreateEnum
CREATE TYPE "SchedulingPolicy" AS ENUM ('FCFS', 'SJF', 'PRIORITY', 'ROUND_ROBIN');

-- AlterTable: scheduling decision metadata. Existing jobs have never been scheduled.
ALTER TABLE "jobs"
  ADD COLUMN "schedulingPolicy" "SchedulingPolicy",
  ADD COLUMN "scheduledAt" TIMESTAMP(3),
  ADD COLUMN "timeQuantumSeconds" INTEGER,
  ADD COLUMN "schedulingRounds" INTEGER NOT NULL DEFAULT 0;

-- Policy-specific selection indexes.
CREATE INDEX "jobs_status_estimatedDurationSeconds_arrivalAt_id_idx"
  ON "jobs"("status", "estimatedDurationSeconds", "arrivalAt", "id");
CREATE INDEX "jobs_status_priority_arrivalAt_id_idx"
  ON "jobs"("status", "priority", "arrivalAt", "id");
CREATE INDEX "jobs_status_schedulingRounds_arrivalAt_id_idx"
  ON "jobs"("status", "schedulingRounds", "arrivalAt", "id");

-- Scheduling invariants.
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_scheduling_rounds_nonnegative"
    CHECK ("schedulingRounds" >= 0),
  ADD CONSTRAINT "jobs_time_quantum_range"
    CHECK ("timeQuantumSeconds" IS NULL OR "timeQuantumSeconds" BETWEEN 1 AND 3600),
  ADD CONSTRAINT "jobs_scheduling_decision_complete"
    CHECK (("schedulingPolicy" IS NULL) = ("scheduledAt" IS NULL));
