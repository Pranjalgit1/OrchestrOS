-- Multi-policy benchmarks: one seeded workload run once per scheduling policy.

-- CreateTable
CREATE TABLE `benchmark_suites` (
    `id` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED') NOT NULL DEFAULT 'RUNNING',
    `placementStrategy` ENUM('FIRST_FIT', 'LEAST_LOADED', 'RESOURCE_AWARE') NOT NULL,
    `pattern` VARCHAR(16) NOT NULL,
    `seed` INTEGER NOT NULL,
    `jobCount` INTEGER NOT NULL,
    `workloadTypes` JSON NOT NULL,
    `timeQuantumSeconds` INTEGER NOT NULL,
    `jobsPerTick` INTEGER NOT NULL,
    `failureReason` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `benchmark_suites_createdAt_idx`(`createdAt`),
    INDEX `benchmark_suites_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `benchmark_runs` (
    `id` CHAR(36) NOT NULL,
    `suiteId` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `policy` ENUM('FCFS', 'SJF', 'PRIORITY', 'ROUND_ROBIN') NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED') NOT NULL DEFAULT 'PENDING',
    `workloadBatchId` CHAR(36) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `failureReason` TEXT NULL,
    `workerCount` INTEGER NULL,
    `cpuCapacityMillicores` INTEGER NULL,
    `memoryCapacityMiB` INTEGER NULL,
    `jobCount` INTEGER NOT NULL DEFAULT 0,
    `completedJobs` INTEGER NOT NULL DEFAULT 0,
    `failedJobs` INTEGER NOT NULL DEFAULT 0,
    `cancelledJobs` INTEGER NOT NULL DEFAULT 0,
    `preemptions` INTEGER NOT NULL DEFAULT 0,
    `retries` INTEGER NOT NULL DEFAULT 0,
    `avgWaitSeconds` DOUBLE NULL,
    `p95WaitSeconds` DOUBLE NULL,
    `avgTurnaroundSeconds` DOUBLE NULL,
    `p95TurnaroundSeconds` DOUBLE NULL,
    `avgResponseSeconds` DOUBLE NULL,
    `p95ResponseSeconds` DOUBLE NULL,
    `makespanSeconds` DOUBLE NULL,
    `throughputPerMinute` DOUBLE NULL,
    `checksumDigest` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `benchmark_runs_suiteId_position_key`(`suiteId`, `position`),
    UNIQUE INDEX `benchmark_runs_suiteId_policy_key`(`suiteId`, `policy`),
    INDEX `benchmark_runs_workloadBatchId_idx`(`workloadBatchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `benchmark_runs` ADD CONSTRAINT `benchmark_runs_suiteId_fkey` FOREIGN KEY (`suiteId`) REFERENCES `benchmark_suites`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Results outlive their jobs: clearing finished work deletes the batch and
-- leaves the measured run in place with no batch link.
ALTER TABLE `benchmark_runs` ADD CONSTRAINT `benchmark_runs_workloadBatchId_fkey` FOREIGN KEY (`workloadBatchId`) REFERENCES `workload_batches`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- Domain invariants.
ALTER TABLE `benchmark_suites`
  ADD CONSTRAINT `benchmark_suites_job_count_range` CHECK (`jobCount` BETWEEN 1 AND 100),
  ADD CONSTRAINT `benchmark_suites_jobs_per_tick_range` CHECK (`jobsPerTick` BETWEEN 1 AND 25),
  ADD CONSTRAINT `benchmark_suites_quantum_range` CHECK (`timeQuantumSeconds` BETWEEN 1 AND 3600),
  ADD CONSTRAINT `benchmark_suites_seed_nonnegative` CHECK (`seed` >= 0);

ALTER TABLE `benchmark_runs`
  ADD CONSTRAINT `benchmark_runs_position_nonnegative` CHECK (`position` >= 0),
  ADD CONSTRAINT `benchmark_runs_counts_nonnegative`
    CHECK (`jobCount` >= 0 AND `completedJobs` >= 0 AND `failedJobs` >= 0
           AND `cancelledJobs` >= 0 AND `preemptions` >= 0 AND `retries` >= 0),
  ADD CONSTRAINT `benchmark_runs_outcomes_bounded`
    CHECK (`completedJobs` + `failedJobs` + `cancelledJobs` <= `jobCount`),
  ADD CONSTRAINT `benchmark_runs_timings_nonnegative`
    CHECK ((`avgWaitSeconds` IS NULL OR `avgWaitSeconds` >= 0)
       AND (`p95WaitSeconds` IS NULL OR `p95WaitSeconds` >= 0)
       AND (`avgTurnaroundSeconds` IS NULL OR `avgTurnaroundSeconds` >= 0)
       AND (`p95TurnaroundSeconds` IS NULL OR `p95TurnaroundSeconds` >= 0)
       AND (`avgResponseSeconds` IS NULL OR `avgResponseSeconds` >= 0)
       AND (`p95ResponseSeconds` IS NULL OR `p95ResponseSeconds` >= 0)
       AND (`makespanSeconds` IS NULL OR `makespanSeconds` >= 0)
       AND (`throughputPerMinute` IS NULL OR `throughputPerMinute` >= 0));
