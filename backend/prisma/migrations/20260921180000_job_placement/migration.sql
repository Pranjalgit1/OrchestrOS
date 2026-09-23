-- CreateEnum
CREATE TYPE "PlacementStrategy" AS ENUM ('FIRST_FIT', 'LEAST_LOADED', 'RESOURCE_AWARE');

-- AlterTable: advisory placement decision metadata. No existing job has been placed.
ALTER TABLE "jobs"
  ADD COLUMN "placementStrategy" "PlacementStrategy",
  ADD COLUMN "placedAt" TIMESTAMP(3);

-- Placement invariants: a decision is complete, and a placed job names its worker.
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_placement_decision_complete"
    CHECK (("placementStrategy" IS NULL) = ("placedAt" IS NULL)),
  ADD CONSTRAINT "jobs_placement_requires_worker"
    CHECK ("placedAt" IS NULL OR "assignedWorkerId" IS NOT NULL);

-- Supports per-worker advisory load accounting for placed, non-terminal jobs.
CREATE INDEX "jobs_assignedWorkerId_status_idx" ON "jobs"("assignedWorkerId", "status");
