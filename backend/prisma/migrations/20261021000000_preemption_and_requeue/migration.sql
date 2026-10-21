-- Round Robin preemption, per-job runtime cancellation, and requeue/retry.

-- The terminal-status check names every terminal value, so it is rebuilt
-- around the enum change to include PREEMPTED.
ALTER TABLE `job_executions` DROP CHECK `job_executions_terminal_has_completed_at`;

ALTER TABLE `job_executions`
  MODIFY `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'PREEMPTED') NOT NULL DEFAULT 'PENDING';

ALTER TABLE `job_executions`
  ADD CONSTRAINT `job_executions_terminal_has_completed_at`
    CHECK (
      `status` NOT IN ('COMPLETED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'PREEMPTED')
      OR `completedAt` IS NOT NULL
    );

ALTER TABLE `jobs`
  ADD COLUMN `preemptionCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `retryCount` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `jobs`
  ADD CONSTRAINT `jobs_preemption_count_nonnegative` CHECK (`preemptionCount` >= 0),
  ADD CONSTRAINT `jobs_retry_count_nonnegative` CHECK (`retryCount` >= 0);
