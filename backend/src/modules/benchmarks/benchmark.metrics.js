import { createHash } from "node:crypto";
import { JobStatus } from "@prisma/client";

/**
 * Pure benchmark arithmetic: no Prisma, no clock, no Docker.
 *
 * Definitions follow the usual operating-systems vocabulary so results can be
 * compared with textbook examples:
 * - turnaround = completion time - arrival time
 * - response   = first start      - arrival time
 * - waiting    = turnaround - time actually spent running (all attempts)
 *
 * Waiting, turnaround, and response are measured over completed jobs only. A
 * failed job has no completion to measure from, so it is counted separately
 * instead of distorting the averages.
 */

const seconds = (from, to) => (to.getTime() - from.getTime()) / 1_000;

/** Rounds to three decimals so stored values stay readable. */
export function round3(value) {
  return value === null || value === undefined ? null : Math.round(value * 1_000) / 1_000;
}

/**
 * Linear-interpolation percentile, the same definition the monitoring SQL
 * uses: position 1 + p(n - 1) over the sorted samples.
 */
export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Digest of every completed job's checksum, in batch order. */
export function checksumDigest(entries) {
  if (entries.length === 0) return null;
  const canonical = [...entries]
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => `${entry.sequence}:${entry.checksum}`)
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Measures one finished batch.
 *
 * `jobs` are rows of `{ status, batchSequence, arrivalAt, completedAt,
 * preemptionCount, retryCount, result, executions: [{ startedAt, completedAt }] }`.
 */
export function measureBatch(jobs) {
  const waits = [];
  const turnarounds = [];
  const responses = [];
  const checksums = [];
  let completedJobs = 0;
  let failedJobs = 0;
  let cancelledJobs = 0;
  let preemptions = 0;
  let retries = 0;
  let firstArrival = null;
  let lastCompletion = null;

  for (const job of jobs) {
    preemptions += job.preemptionCount ?? 0;
    retries += job.retryCount ?? 0;
    if (!firstArrival || job.arrivalAt < firstArrival) firstArrival = job.arrivalAt;

    if (job.status === JobStatus.CANCELLED) {
      cancelledJobs += 1;
      continue;
    }
    if (job.status !== JobStatus.COMPLETED) {
      if (job.status === JobStatus.FAILED || job.status === JobStatus.INTERRUPTED) failedJobs += 1;
      continue;
    }

    completedJobs += 1;
    if (!lastCompletion || job.completedAt > lastCompletion) lastCompletion = job.completedAt;

    const attempts = (job.executions ?? []).filter((entry) => entry.startedAt);
    const firstStart = attempts.reduce(
      (earliest, entry) => (!earliest || entry.startedAt < earliest ? entry.startedAt : earliest),
      null,
    );
    // An attempt without a completion time ran until the job completed.
    const ranFor = attempts.reduce(
      (sum, entry) => sum + Math.max(0, seconds(entry.startedAt, entry.completedAt ?? job.completedAt)),
      0,
    );
    const turnaround = Math.max(0, seconds(job.arrivalAt, job.completedAt));
    turnarounds.push(turnaround);
    waits.push(Math.max(0, turnaround - ranFor));
    if (firstStart) responses.push(Math.max(0, seconds(job.arrivalAt, firstStart)));

    const checksum = job.result?.checksum;
    if (typeof checksum === "string") checksums.push({ sequence: job.batchSequence ?? 0, checksum });
  }

  const makespan = firstArrival && lastCompletion ? Math.max(0, seconds(firstArrival, lastCompletion)) : null;
  const allCompleted = jobs.length > 0 && completedJobs === jobs.length;

  return {
    jobCount: jobs.length,
    completedJobs,
    failedJobs,
    cancelledJobs,
    preemptions,
    retries,
    avgWaitSeconds: round3(average(waits)),
    p95WaitSeconds: round3(percentile(waits, 0.95)),
    avgTurnaroundSeconds: round3(average(turnarounds)),
    p95TurnaroundSeconds: round3(percentile(turnarounds, 0.95)),
    avgResponseSeconds: round3(average(responses)),
    p95ResponseSeconds: round3(percentile(responses, 0.95)),
    makespanSeconds: round3(makespan),
    throughputPerMinute: makespan && makespan > 0 ? round3(completedJobs / (makespan / 60)) : null,
    // A digest over a partial batch would compare unlike work.
    checksumDigest: allCompleted && checksums.length === jobs.length ? checksumDigest(checksums) : null,
  };
}

/** Metrics shown in the comparison, and which direction is better. */
export const COMPARED_METRICS = [
  { key: "avgWaitSeconds", label: "Average waiting time", unit: "s", better: "lower" },
  { key: "p95WaitSeconds", label: "p95 waiting time", unit: "s", better: "lower" },
  { key: "avgTurnaroundSeconds", label: "Average turnaround", unit: "s", better: "lower" },
  { key: "p95TurnaroundSeconds", label: "p95 turnaround", unit: "s", better: "lower" },
  { key: "avgResponseSeconds", label: "Average response time", unit: "s", better: "lower" },
  { key: "makespanSeconds", label: "Makespan", unit: "s", better: "lower" },
  { key: "throughputPerMinute", label: "Throughput", unit: "jobs/min", better: "higher" },
  { key: "preemptions", label: "Preemptions", unit: "", better: "lower" },
];

/**
 * Compares the finished runs of one suite.
 *
 * Results are only called comparable when every run saw the same cluster
 * capacity and produced byte-identical work; otherwise the comparison still
 * renders but says why it should be read with care.
 */
export function comparePolicies(runs) {
  const finished = runs.filter((run) => run.status === "COMPLETED");
  const metrics = COMPARED_METRICS.map((metric) => {
    const values = finished.map((run) => ({ policy: run.policy, value: run[metric.key] ?? null }));
    const measured = values.filter((entry) => entry.value !== null);
    let best = [];
    if (measured.length > 1) {
      const target = metric.better === "lower"
        ? Math.min(...measured.map((entry) => entry.value))
        : Math.max(...measured.map((entry) => entry.value));
      // Within a millisecond counts as a tie, so timer noise cannot pick a winner.
      best = measured.filter((entry) => Math.abs(entry.value - target) < 0.001).map((entry) => entry.policy);
      if (best.length === measured.length) best = [];
    }
    return { ...metric, values, best };
  });

  const capacities = new Set(finished.map((run) =>
    `${run.workerCount}/${run.cpuCapacityMillicores}/${run.memoryCapacityMiB}`));
  const digests = finished.map((run) => run.checksumDigest);
  const notes = [];
  const fairCapacity = finished.length > 0 && capacities.size === 1;
  const identicalWork = finished.length > 0 && digests.every((digest) => digest && digest === digests[0]);
  if (finished.length < runs.length) {
    notes.push(`${runs.length - finished.length} run(s) did not complete and are left out.`);
  }
  if (finished.length > 0 && !fairCapacity) {
    notes.push("Cluster capacity differed between runs, so timings are not directly comparable.");
  }
  if (finished.length > 0 && !identicalWork) {
    notes.push("Result checksums differed or some jobs did not complete, so runs did not do identical work.");
  }

  return {
    comparable: finished.length >= 2 && fairCapacity && identicalWork,
    fairCapacity,
    identicalWork,
    finishedRuns: finished.length,
    metrics,
    notes,
  };
}
