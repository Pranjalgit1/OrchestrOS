-- CreateTable
CREATE TABLE `workload_batches` (
    `id` CHAR(36) NOT NULL,
    `seed` INTEGER NOT NULL,
    `jobCount` INTEGER NOT NULL,
    `pattern` ENUM('LIGHT', 'MEDIUM', 'HEAVY', 'CONSTANT', 'BURST', 'INCREASING', 'DECREASING', 'PERIODIC', 'CUSTOM') NOT NULL,
    `generatorVersion` VARCHAR(16) NOT NULL,
    `parameters` JSON NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `sourceBatchId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `workload_batches_sourceBatchId_idx`(`sourceBatchId`),
    INDEX `workload_batches_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobs` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `workloadType` ENUM('CPU_INTENSIVE', 'MATRIX_MULTIPLICATION', 'SORTING', 'DATA_PROCESSING', 'SLEEP') NOT NULL,
    `workloadSize` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('CREATED', 'QUEUED', 'WAITING', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `cpuRequiredMillicores` INTEGER NOT NULL,
    `memoryRequiredMiB` INTEGER NOT NULL,
    `estimatedDurationSeconds` INTEGER NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 5,
    `workloadBatchId` CHAR(36) NULL,
    `batchSequence` INTEGER NULL,
    `arrivalOffsetSeconds` INTEGER NOT NULL DEFAULT 0,
    `arrivalAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `schedulingPolicy` ENUM('FCFS', 'SJF', 'PRIORITY', 'ROUND_ROBIN') NULL,
    `scheduledAt` DATETIME(3) NULL,
    `timeQuantumSeconds` INTEGER NULL,
    `schedulingRounds` INTEGER NOT NULL DEFAULT 0,
    `placementStrategy` ENUM('FIRST_FIT', 'LEAST_LOADED', 'RESOURCE_AWARE') NULL,
    `placedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `assignedWorkerId` CHAR(36) NULL,
    `containerId` VARCHAR(128) NULL,
    `result` JSON NULL,
    `failureReason` TEXT NULL,

    UNIQUE INDEX `jobs_containerId_key`(`containerId`),
    INDEX `jobs_status_arrivalAt_createdAt_batchSequence_id_idx`(`status`, `arrivalAt`, `createdAt`, `batchSequence`, `id`),
    INDEX `jobs_status_estimatedDurationSeconds_arrivalAt_id_idx`(`status`, `estimatedDurationSeconds`, `arrivalAt`, `id`),
    INDEX `jobs_status_priority_arrivalAt_id_idx`(`status`, `priority`, `arrivalAt`, `id`),
    INDEX `jobs_status_schedulingRounds_arrivalAt_id_idx`(`status`, `schedulingRounds`, `arrivalAt`, `id`),
    INDEX `jobs_workloadBatchId_idx`(`workloadBatchId`),
    INDEX `jobs_assignedWorkerId_idx`(`assignedWorkerId`),
    INDEX `jobs_assignedWorkerId_status_idx`(`assignedWorkerId`, `status`),
    UNIQUE INDEX `jobs_workloadBatchId_batchSequence_key`(`workloadBatchId`, `batchSequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workers` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `cpuCapacityMillicores` INTEGER NOT NULL,
    `memoryCapacityMiB` INTEGER NOT NULL,
    `cpuAllocatedMillicores` INTEGER NOT NULL DEFAULT 0,
    `memoryAllocatedMiB` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('STARTING', 'ACTIVE', 'IDLE', 'BUSY', 'STOPPING', 'FAILED') NOT NULL DEFAULT 'IDLE',
    `lastHeartbeat` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workers_name_key`(`name`),
    INDEX `workers_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `worker_samples` (
    `id` CHAR(36) NOT NULL,
    `workerId` CHAR(36) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL,
    `cpuCapacityMillicores` INTEGER NOT NULL,
    `memoryCapacityMiB` INTEGER NOT NULL,
    `cpuAllocatedMillicores` INTEGER NOT NULL,
    `memoryAllocatedMiB` INTEGER NOT NULL,
    `status` ENUM('STARTING', 'ACTIVE', 'IDLE', 'BUSY', 'STOPPING', 'FAILED') NOT NULL,
    `runningExecutions` INTEGER NOT NULL DEFAULT 0,
    `reservedAllocations` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `worker_samples_capturedAt_idx`(`capturedAt`),
    UNIQUE INDEX `worker_samples_workerId_capturedAt_key`(`workerId`, `capturedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `resource_allocations` (
    `id` CHAR(36) NOT NULL,
    `jobId` CHAR(36) NOT NULL,
    `workerId` CHAR(36) NOT NULL,
    `cpuMillicores` INTEGER NOT NULL,
    `memoryMiB` INTEGER NOT NULL,
    `status` ENUM('RESERVED', 'RELEASED', 'ROLLED_BACK') NOT NULL DEFAULT 'RESERVED',
    `reservedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releasedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `resource_allocations_jobId_status_idx`(`jobId`, `status`),
    INDEX `resource_allocations_workerId_status_idx`(`workerId`, `status`),
    UNIQUE INDEX `resource_allocations_id_jobId_workerId_key`(`id`, `jobId`, `workerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_executions` (
    `id` CHAR(36) NOT NULL,
    `jobId` CHAR(36) NOT NULL,
    `workerId` CHAR(36) NOT NULL,
    `allocationId` CHAR(36) NOT NULL,
    `attempt` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `containerId` VARCHAR(128) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `exitCode` INTEGER NULL,
    `stdout` MEDIUMTEXT NULL,
    `stderr` MEDIUMTEXT NULL,
    `failureReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `job_executions_allocationId_key`(`allocationId`),
    UNIQUE INDEX `job_executions_containerId_key`(`containerId`),
    INDEX `job_executions_jobId_idx`(`jobId`),
    INDEX `job_executions_workerId_idx`(`workerId`),
    INDEX `job_executions_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `job_executions_jobId_attempt_key`(`jobId`, `attempt`),
    UNIQUE INDEX `job_executions_allocationId_jobId_workerId_key`(`allocationId`, `jobId`, `workerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `workload_batches` ADD CONSTRAINT `workload_batches_sourceBatchId_fkey` FOREIGN KEY (`sourceBatchId`) REFERENCES `workload_batches`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_workloadBatchId_fkey` FOREIGN KEY (`workloadBatchId`) REFERENCES `workload_batches`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_assignedWorkerId_fkey` FOREIGN KEY (`assignedWorkerId`) REFERENCES `workers`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `worker_samples` ADD CONSTRAINT `worker_samples_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `workers`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `resource_allocations` ADD CONSTRAINT `resource_allocations_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `resource_allocations` ADD CONSTRAINT `resource_allocations_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `workers`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `job_executions` ADD CONSTRAINT `job_executions_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `job_executions` ADD CONSTRAINT `job_executions_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `workers`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `job_executions` ADD CONSTRAINT `job_executions_allocationId_jobId_workerId_fkey` FOREIGN KEY (`allocationId`, `jobId`, `workerId`) REFERENCES `resource_allocations`(`id`, `jobId`, `workerId`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Domain invariants enforced by MySQL 8.
ALTER TABLE `jobs`
  ADD CONSTRAINT `jobs_cpu_required_positive` CHECK (`cpuRequiredMillicores` > 0),
  ADD CONSTRAINT `jobs_memory_required_positive` CHECK (`memoryRequiredMiB` > 0),
  ADD CONSTRAINT `jobs_estimated_duration_positive` CHECK (`estimatedDurationSeconds` > 0),
  ADD CONSTRAINT `jobs_priority_range` CHECK (`priority` BETWEEN 1 AND 10);

ALTER TABLE `workers`
  ADD CONSTRAINT `workers_cpu_capacity_positive` CHECK (`cpuCapacityMillicores` > 0),
  ADD CONSTRAINT `workers_memory_capacity_positive` CHECK (`memoryCapacityMiB` > 0),
  ADD CONSTRAINT `workers_cpu_allocated_nonnegative` CHECK (`cpuAllocatedMillicores` >= 0),
  ADD CONSTRAINT `workers_memory_allocated_nonnegative` CHECK (`memoryAllocatedMiB` >= 0),
  ADD CONSTRAINT `workers_cpu_not_overallocated` CHECK (`cpuAllocatedMillicores` <= `cpuCapacityMillicores`),
  ADD CONSTRAINT `workers_memory_not_overallocated` CHECK (`memoryAllocatedMiB` <= `memoryCapacityMiB`);

ALTER TABLE `resource_allocations`
  ADD CONSTRAINT `resource_allocations_cpu_positive` CHECK (`cpuMillicores` > 0),
  ADD CONSTRAINT `resource_allocations_memory_positive` CHECK (`memoryMiB` > 0);

ALTER TABLE `job_executions`
  ADD CONSTRAINT `job_executions_attempt_positive` CHECK (`attempt` > 0);

ALTER TABLE `workload_batches`
  ADD CONSTRAINT `workload_batches_seed_range`
    CHECK (`seed` BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT `workload_batches_job_count_allowed`
    CHECK (`jobCount` IN (10, 25, 50, 100));

ALTER TABLE `jobs`
  ADD CONSTRAINT `jobs_workload_size_range`
    CHECK (`workloadSize` BETWEEN 1 AND 100000000),
  ADD CONSTRAINT `jobs_arrival_offset_range`
    CHECK (`arrivalOffsetSeconds` BETWEEN 0 AND 86400),
  ADD CONSTRAINT `jobs_batch_sequence_positive`
    CHECK (`batchSequence` IS NULL OR `batchSequence` > 0),
  ADD CONSTRAINT `jobs_batch_identity_complete`
    CHECK ((`workloadBatchId` IS NULL) = (`batchSequence` IS NULL)),
  ADD CONSTRAINT `jobs_cpu_required_upper_bound`
    CHECK (`cpuRequiredMillicores` <= 64000),
  ADD CONSTRAINT `jobs_memory_required_upper_bound`
    CHECK (`memoryRequiredMiB` <= 131072),
  ADD CONSTRAINT `jobs_estimated_duration_upper_bound`
    CHECK (`estimatedDurationSeconds` <= 86400);

ALTER TABLE `jobs`
  ADD CONSTRAINT `jobs_cpu_required_lower_bound`
    CHECK (`cpuRequiredMillicores` >= 100),
  ADD CONSTRAINT `jobs_memory_required_lower_bound`
    CHECK (`memoryRequiredMiB` >= 64);

ALTER TABLE `jobs`
  ADD CONSTRAINT `jobs_scheduling_rounds_nonnegative`
    CHECK (`schedulingRounds` >= 0),
  ADD CONSTRAINT `jobs_time_quantum_range`
    CHECK (`timeQuantumSeconds` IS NULL OR `timeQuantumSeconds` BETWEEN 1 AND 3600),
  ADD CONSTRAINT `jobs_scheduling_decision_complete`
    CHECK ((`schedulingPolicy` IS NULL) = (`scheduledAt` IS NULL));

ALTER TABLE `jobs`
  ADD CONSTRAINT `jobs_placement_decision_complete`
    CHECK ((`placementStrategy` IS NULL) = (`placedAt` IS NULL)),
  ADD CONSTRAINT `jobs_placement_requires_worker`
    CHECK (`placedAt` IS NULL OR `assignedWorkerId` IS NOT NULL);

ALTER TABLE `job_executions`
  ADD CONSTRAINT `job_executions_stdout_bounded`
    CHECK (`stdout` IS NULL OR char_length(`stdout`) <= 16384),
  ADD CONSTRAINT `job_executions_stderr_bounded`
    CHECK (`stderr` IS NULL OR char_length(`stderr`) <= 16384);

ALTER TABLE `job_executions`
  ADD CONSTRAINT `job_executions_container_id_format`
    CHECK (`containerId` IS NULL OR REGEXP_LIKE(`containerId`, '^[0-9a-f]{12,128}$', 'c'));

ALTER TABLE `jobs`
  ADD CONSTRAINT `jobs_container_id_format`
    CHECK (`containerId` IS NULL OR REGEXP_LIKE(`containerId`, '^[0-9a-f]{12,128}$', 'c'));

ALTER TABLE `job_executions`
  ADD CONSTRAINT `job_executions_terminal_has_completed_at`
    CHECK (
      `status` NOT IN ('COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED')
      OR `completedAt` IS NOT NULL
    );

ALTER TABLE `job_executions`
  ADD CONSTRAINT `job_executions_container_implies_started`
    CHECK (`containerId` IS NULL OR `startedAt` IS NOT NULL);

ALTER TABLE `worker_samples`
  ADD CONSTRAINT `worker_samples_cpu_capacity_positive`
    CHECK (`cpuCapacityMillicores` > 0),
  ADD CONSTRAINT `worker_samples_memory_capacity_positive`
    CHECK (`memoryCapacityMiB` > 0),
  ADD CONSTRAINT `worker_samples_cpu_allocated_bounded`
    CHECK (`cpuAllocatedMillicores` >= 0
           AND `cpuAllocatedMillicores` <= `cpuCapacityMillicores`),
  ADD CONSTRAINT `worker_samples_memory_allocated_bounded`
    CHECK (`memoryAllocatedMiB` >= 0
           AND `memoryAllocatedMiB` <= `memoryCapacityMiB`),
  ADD CONSTRAINT `worker_samples_counts_non_negative`
    CHECK (`runningExecutions` >= 0 AND `reservedAllocations` >= 0);

-- Historical allocations remain unrestricted; only a live reservation is unique.
CREATE UNIQUE INDEX resource_allocations_one_reserved_per_job
  ON resource_allocations ((CASE WHEN status = 'RESERVED' THEN jobId ELSE NULL END));

ALTER TABLE job_executions
  ADD CONSTRAINT job_executions_exit_code_range
    CHECK (exitCode IS NULL OR exitCode BETWEEN -1 AND 255);
