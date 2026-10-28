-- Reactive-vs-ML autoscaling comparisons: one seeded workload run once per
-- autoscaling strategy, with a timeline of load and workers for each run.
-- Only adds tables; nothing existing changes.

-- CreateTable
CREATE TABLE `scaling_comparisons` (
    `id` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED') NOT NULL DEFAULT 'RUNNING',
    `schedulingPolicy` ENUM('FCFS', 'SJF', 'PRIORITY', 'ROUND_ROBIN') NOT NULL,
    `placementStrategy` ENUM('FIRST_FIT', 'LEAST_LOADED', 'RESOURCE_AWARE') NOT NULL,
    `pattern` VARCHAR(16) NOT NULL,
    `seed` INTEGER NOT NULL,
    `jobCount` INTEGER NOT NULL,
    `workloadTypes` JSON NOT NULL,
    `timeQuantumSeconds` INTEGER NOT NULL,
    `jobsPerTick` INTEGER NOT NULL,
    `autoscalerSettings` JSON NOT NULL,
    `failureReason` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scaling_comparisons_createdAt_idx`(`createdAt`),
    INDEX `scaling_comparisons_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scaling_comparison_runs` (
    `id` CHAR(36) NOT NULL,
    `comparisonId` CHAR(36) NOT NULL,
    `position` INTEGER NOT NULL,
    `strategy` ENUM('REACTIVE', 'ML') NOT NULL,
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
    `avgWaitSeconds` DOUBLE NULL,
    `p95WaitSeconds` DOUBLE NULL,
    `avgTurnaroundSeconds` DOUBLE NULL,
    `makespanSeconds` DOUBLE NULL,
    `throughputPerMinute` DOUBLE NULL,
    `checksumDigest` VARCHAR(64) NULL,
    `pressureAt` DATETIME(3) NULL,
    `firstScaleUpAt` DATETIME(3) NULL,
    `reactionSeconds` DOUBLE NULL,
    `backedUpSeconds` DOUBLE NULL,
    `extraWorkerSeconds` DOUBLE NULL,
    `idleExtraWorkerSeconds` DOUBLE NULL,
    `peakWorkers` INTEGER NULL,
    `scaleUps` INTEGER NOT NULL DEFAULT 0,
    `scaleDowns` INTEGER NOT NULL DEFAULT 0,
    `flaps` INTEGER NOT NULL DEFAULT 0,
    `forecastMeanAbsError` DOUBLE NULL,
    `forecastPairs` INTEGER NOT NULL DEFAULT 0,
    `scalingActions` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scaling_comparison_runs_workloadBatchId_idx`(`workloadBatchId`),
    UNIQUE INDEX `scaling_comparison_runs_comparisonId_position_key`(`comparisonId`, `position`),
    UNIQUE INDEX `scaling_comparison_runs_comparisonId_strategy_key`(`comparisonId`, `strategy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scaling_comparison_samples` (
    `id` CHAR(36) NOT NULL,
    `runId` CHAR(36) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `offsetSeconds` DOUBLE NOT NULL,
    `queuedJobs` INTEGER NOT NULL,
    `workersInService` INTEGER NOT NULL,
    `extraWorkers` INTEGER NOT NULL,
    `idleExtraWorkers` INTEGER NOT NULL,
    `peakUtilization` DOUBLE NOT NULL,
    `forecastQueuedJobs` DOUBLE NULL,
    `forecastPeak` DOUBLE NULL,

    INDEX `scaling_comparison_samples_runId_offsetSeconds_idx`(`runId`, `offsetSeconds`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scaling_comparison_runs` ADD CONSTRAINT `scaling_comparison_runs_comparisonId_fkey` FOREIGN KEY (`comparisonId`) REFERENCES `scaling_comparisons`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Results outlive their jobs: clearing finished work deletes the batch and
-- leaves the measured run in place with no batch link.
ALTER TABLE `scaling_comparison_runs` ADD CONSTRAINT `scaling_comparison_runs_workloadBatchId_fkey` FOREIGN KEY (`workloadBatchId`) REFERENCES `workload_batches`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `scaling_comparison_samples` ADD CONSTRAINT `scaling_comparison_samples_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `scaling_comparison_runs`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Domain invariants.
ALTER TABLE `scaling_comparisons`
  ADD CONSTRAINT `scaling_comparisons_job_count_range` CHECK (`jobCount` BETWEEN 1 AND 100),
  ADD CONSTRAINT `scaling_comparisons_jobs_per_tick_range` CHECK (`jobsPerTick` BETWEEN 1 AND 25),
  ADD CONSTRAINT `scaling_comparisons_quantum_range` CHECK (`timeQuantumSeconds` BETWEEN 1 AND 3600),
  ADD CONSTRAINT `scaling_comparisons_seed_nonnegative` CHECK (`seed` >= 0);

ALTER TABLE `scaling_comparison_runs`
  ADD CONSTRAINT `scaling_comparison_runs_position_nonnegative` CHECK (`position` >= 0),
  ADD CONSTRAINT `scaling_comparison_runs_counts_nonnegative`
    CHECK (`jobCount` >= 0 AND `completedJobs` >= 0 AND `failedJobs` >= 0 AND `cancelledJobs` >= 0
           AND `scaleUps` >= 0 AND `scaleDowns` >= 0 AND `flaps` >= 0 AND `forecastPairs` >= 0
           AND (`peakWorkers` IS NULL OR `peakWorkers` >= 0)),
  ADD CONSTRAINT `scaling_comparison_runs_outcomes_bounded`
    CHECK (`completedJobs` + `failedJobs` + `cancelledJobs` <= `jobCount`),
  -- reactionSeconds is the one signed timing: negative means scaled up early.
  ADD CONSTRAINT `scaling_comparison_runs_timings_nonnegative`
    CHECK ((`avgWaitSeconds` IS NULL OR `avgWaitSeconds` >= 0)
       AND (`p95WaitSeconds` IS NULL OR `p95WaitSeconds` >= 0)
       AND (`avgTurnaroundSeconds` IS NULL OR `avgTurnaroundSeconds` >= 0)
       AND (`makespanSeconds` IS NULL OR `makespanSeconds` >= 0)
       AND (`throughputPerMinute` IS NULL OR `throughputPerMinute` >= 0)
       AND (`backedUpSeconds` IS NULL OR `backedUpSeconds` >= 0)
       AND (`extraWorkerSeconds` IS NULL OR `extraWorkerSeconds` >= 0)
       AND (`idleExtraWorkerSeconds` IS NULL OR `idleExtraWorkerSeconds` >= 0)
       AND (`forecastMeanAbsError` IS NULL OR `forecastMeanAbsError` >= 0));

ALTER TABLE `scaling_comparison_samples`
  ADD CONSTRAINT `scaling_comparison_samples_counts_nonnegative`
    CHECK (`offsetSeconds` >= 0 AND `queuedJobs` >= 0 AND `workersInService` >= 0
           AND `extraWorkers` >= 0 AND `idleExtraWorkers` BETWEEN 0 AND `extraWorkers`),
  ADD CONSTRAINT `scaling_comparison_samples_utilization_range`
    CHECK (`peakUtilization` BETWEEN 0 AND 1);
