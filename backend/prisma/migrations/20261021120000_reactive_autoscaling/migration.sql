-- Reactive autoscaling of logical workers.

ALTER TABLE `workers`
  MODIFY `status` ENUM('STARTING', 'ACTIVE', 'IDLE', 'BUSY', 'STOPPING', 'FAILED', 'RETIRED') NOT NULL DEFAULT 'IDLE',
  ADD COLUMN `autoscaled` BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX `workers_autoscaled_status_idx` ON `workers`(`autoscaled`, `status`);

ALTER TABLE `worker_samples`
  MODIFY `status` ENUM('STARTING', 'ACTIVE', 'IDLE', 'BUSY', 'STOPPING', 'FAILED', 'RETIRED') NOT NULL;

-- CreateTable
CREATE TABLE `scaling_events` (
    `id` CHAR(36) NOT NULL,
    `action` ENUM('SCALE_UP', 'SCALE_DOWN') NOT NULL,
    `workerId` CHAR(36) NOT NULL,
    `workerName` VARCHAR(64) NOT NULL,
    `reason` TEXT NOT NULL,
    `queuedJobs` INTEGER NOT NULL,
    `cpuUtilization` DOUBLE NOT NULL,
    `memoryUtilization` DOUBLE NOT NULL,
    `workerCount` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `scaling_events_createdAt_idx`(`createdAt`),
    INDEX `scaling_events_workerId_idx`(`workerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scaling_events` ADD CONSTRAINT `scaling_events_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `workers`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Domain invariants.
ALTER TABLE `scaling_events`
  ADD CONSTRAINT `scaling_events_queued_jobs_nonnegative` CHECK (`queuedJobs` >= 0),
  ADD CONSTRAINT `scaling_events_worker_count_nonnegative` CHECK (`workerCount` >= 0),
  ADD CONSTRAINT `scaling_events_utilization_range`
    CHECK (`cpuUtilization` BETWEEN 0 AND 1 AND `memoryUtilization` BETWEEN 0 AND 1);

-- A retired worker holds nothing, so capacity can never be stranded on it.
ALTER TABLE `workers`
  ADD CONSTRAINT `workers_retired_holds_nothing`
    CHECK (`status` <> 'RETIRED' OR (`cpuAllocatedMillicores` = 0 AND `memoryAllocatedMiB` = 0));
