-- CreateEnum
CREATE TYPE "WorkloadType" AS ENUM ('CPU_INTENSIVE', 'MATRIX_MULTIPLICATION', 'SORTING', 'DATA_PROCESSING', 'SLEEP');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('CREATED', 'QUEUED', 'WAITING', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('STARTING', 'ACTIVE', 'IDLE', 'BUSY', 'STOPPING', 'FAILED');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('RESERVED', 'RELEASED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "workloadType" "WorkloadType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "cpuRequiredMillicores" INTEGER NOT NULL,
    "memoryRequiredMiB" INTEGER NOT NULL,
    "estimatedDurationSeconds" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "assignedWorkerId" UUID,
    "containerId" VARCHAR(128),
    "result" JSONB,
    "failureReason" TEXT,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "cpuCapacityMillicores" INTEGER NOT NULL,
    "memoryCapacityMiB" INTEGER NOT NULL,
    "cpuAllocatedMillicores" INTEGER NOT NULL DEFAULT 0,
    "memoryAllocatedMiB" INTEGER NOT NULL DEFAULT 0,
    "status" "WorkerStatus" NOT NULL DEFAULT 'IDLE',
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_allocations" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "cpuMillicores" INTEGER NOT NULL,
    "memoryMiB" INTEGER NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_executions" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "workerId" UUID,
    "allocationId" UUID,
    "attempt" INTEGER NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "containerId" VARCHAR(128),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "stdout" TEXT,
    "stderr" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_containerId_key" ON "jobs"("containerId");

-- CreateIndex
CREATE INDEX "jobs_status_createdAt_id_idx" ON "jobs"("status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "jobs_assignedWorkerId_idx" ON "jobs"("assignedWorkerId");

-- CreateIndex
CREATE UNIQUE INDEX "workers_name_key" ON "workers"("name");

-- CreateIndex
CREATE INDEX "workers_status_idx" ON "workers"("status");

-- CreateIndex
CREATE INDEX "resource_allocations_jobId_status_idx" ON "resource_allocations"("jobId", "status");

-- CreateIndex
CREATE INDEX "resource_allocations_workerId_status_idx" ON "resource_allocations"("workerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "job_executions_allocationId_key" ON "job_executions"("allocationId");

-- CreateIndex
CREATE UNIQUE INDEX "job_executions_containerId_key" ON "job_executions"("containerId");

-- CreateIndex
CREATE INDEX "job_executions_jobId_idx" ON "job_executions"("jobId");

-- CreateIndex
CREATE INDEX "job_executions_workerId_idx" ON "job_executions"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "job_executions_jobId_attempt_key" ON "job_executions"("jobId", "attempt");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assignedWorkerId_fkey" FOREIGN KEY ("assignedWorkerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "resource_allocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Resource and lifecycle invariant checks
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_cpu_required_positive" CHECK ("cpuRequiredMillicores" > 0),
  ADD CONSTRAINT "jobs_memory_required_positive" CHECK ("memoryRequiredMiB" > 0),
  ADD CONSTRAINT "jobs_estimated_duration_positive" CHECK ("estimatedDurationSeconds" > 0),
  ADD CONSTRAINT "jobs_priority_range" CHECK ("priority" BETWEEN 1 AND 10);

ALTER TABLE "workers"
  ADD CONSTRAINT "workers_cpu_capacity_positive" CHECK ("cpuCapacityMillicores" > 0),
  ADD CONSTRAINT "workers_memory_capacity_positive" CHECK ("memoryCapacityMiB" > 0),
  ADD CONSTRAINT "workers_cpu_allocated_nonnegative" CHECK ("cpuAllocatedMillicores" >= 0),
  ADD CONSTRAINT "workers_memory_allocated_nonnegative" CHECK ("memoryAllocatedMiB" >= 0),
  ADD CONSTRAINT "workers_cpu_not_overallocated" CHECK ("cpuAllocatedMillicores" <= "cpuCapacityMillicores"),
  ADD CONSTRAINT "workers_memory_not_overallocated" CHECK ("memoryAllocatedMiB" <= "memoryCapacityMiB");

ALTER TABLE "resource_allocations"
  ADD CONSTRAINT "resource_allocations_cpu_positive" CHECK ("cpuMillicores" > 0),
  ADD CONSTRAINT "resource_allocations_memory_positive" CHECK ("memoryMiB" > 0);

ALTER TABLE "job_executions"
  ADD CONSTRAINT "job_executions_attempt_positive" CHECK ("attempt" > 0);
