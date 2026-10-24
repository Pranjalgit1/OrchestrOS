import { JobStatus, SchedulingPolicy } from "@prisma/client";
import { generateWorkloadSpecs } from "../workloads/workload.generator.js";
import { orderByPolicy } from "../scheduler/scheduler.policies.js";

// ---------------------------------------------------------------------------
// Helpers — turn raw specs into pseudo-job objects that policies can sort
// ---------------------------------------------------------------------------

/**
 * Converts a raw workload spec into a minimal object that satisfies the
 * interface expected by orderByPolicy / isEligible.
 *
 * @param {object} spec - From generateWorkloadSpecs
 * @param {Date} baseTime - Simulation start time
 * @returns {object} Pseudo-job
 */
function specToJob(spec, baseTime) {
  const arrivalAt = new Date(baseTime.getTime() + spec.arrivalOffsetSeconds * 1000);
  return {
    id: `sim-${spec.sequence}`,
    status: JobStatus.QUEUED,
    arrivalAt,
    createdAt: arrivalAt,
    batchSequence: spec.sequence,
    estimatedDurationSeconds: spec.estimatedDurationSeconds,
    priority: spec.priority,
    schedulingRounds: 0,
    // Carry originals for metric calculation.
    _spec: spec,
  };
}

// ---------------------------------------------------------------------------
// Core simulation engine
// ---------------------------------------------------------------------------

/**
 * Simulates scheduling of a job list under a given policy.
 *
 * Uses a discrete-event approach:
 *  - clock advances to next arrival or next job completion, whichever is sooner
 *  - scheduler picks the next eligible job at each tick
 *
 * @param {object[]} jobs - Pseudo-job objects (from specToJob)
 * @param {string} policy - SchedulingPolicy enum value
 * @param {number} timeQuantumSeconds - Only used for ROUND_ROBIN
 * @param {object} clusterProfile - Virtual cluster to simulate
 * @returns {object[]} Per-job result records
 */
function simulatePolicy(jobs, policy, timeQuantumSeconds = 10, clusterProfile = { cpuMillicores: 3000 }) {
  // Work on a copy so sorting doesn't mutate the shared list.
  const queue = jobs.map((j) => ({ ...j }));
  const results = [];
  let clock = new Date(Math.min(...queue.map((j) => j.arrivalAt.getTime())));
  const inFlight = []; // { job, startedAt, finishAt, cpuUsed }

  const totalCpuMs = clusterProfile.cpuMillicores;
  let busyCpuMs = 0;

  const MAX_TICKS = jobs.length * 20; // safety guard
  let tick = 0;

  while ((queue.length > 0 || inFlight.length > 0) && tick++ < MAX_TICKS) {
    // Advance clock: to the next event (arrival or finish).
    const nextArrival = queue
      .filter((j) => j.arrivalAt > clock)
      .sort((a, b) => a.arrivalAt - b.arrivalAt)[0]?.arrivalAt;
    const nextFinish = inFlight
      .map((f) => f.finishAt)
      .sort((a, b) => a - b)[0];

    // Determine next clock step.
    const events = [nextArrival, nextFinish].filter(Boolean);
    if (events.length > 0) {
      const nextEvent = new Date(Math.min(...events.map((e) => e.getTime())));
      if (nextEvent > clock) {
        clock = nextEvent;
      }
    }

    // Complete any finished jobs.
    const finished = inFlight.filter((f) => f.finishAt <= clock);
    for (const f of finished) {
      inFlight.splice(inFlight.indexOf(f), 1);
      busyCpuMs -= f.cpuUsed;
      const waitSeconds = (f.startedAt.getTime() - f.job.arrivalAt.getTime()) / 1000;
      const executionSeconds = (f.finishAt.getTime() - f.startedAt.getTime()) / 1000;
      results.push({
        jobId: f.job.id,
        policy,
        arrivalAt: f.job.arrivalAt,
        startedAt: f.startedAt,
        finishAt: f.finishAt,
        waitSeconds: Math.max(0, waitSeconds),
        executionSeconds,
        turnaroundSeconds: Math.max(0, waitSeconds + executionSeconds),
        priority: f.job.priority,
        estimatedDurationSeconds: f.job.estimatedDurationSeconds,
      });
    }

    // Schedule next eligible job if capacity allows.
    const eligible = queue.filter((j) => j.arrivalAt <= clock);
    if (eligible.length === 0) {
      // Nothing arrived yet; jump to next arrival.
      if (nextArrival && nextArrival > clock) clock = nextArrival;
      continue;
    }

    const ordered = orderByPolicy(eligible, policy, clock);
    if (ordered.length === 0) continue;

    const next = ordered[0];
    const cpuNeeded = next._spec.cpuRequiredMillicores;

    // If there's enough virtual CPU capacity, start the job.
    if (busyCpuMs + cpuNeeded <= totalCpuMs || inFlight.length === 0) {
      queue.splice(queue.indexOf(next), 1);
      const duration =
        policy === SchedulingPolicy.ROUND_ROBIN
          ? Math.min(next.estimatedDurationSeconds, timeQuantumSeconds)
          : next.estimatedDurationSeconds;
      const startedAt = new Date(clock);
      const finishAt = new Date(clock.getTime() + duration * 1000);
      busyCpuMs += cpuNeeded;
      inFlight.push({ job: next, startedAt, finishAt, cpuUsed: cpuNeeded });

      // Round Robin: re-queue if not finished.
      if (
        policy === SchedulingPolicy.ROUND_ROBIN &&
        duration < next.estimatedDurationSeconds
      ) {
        const remaining = next.estimatedDurationSeconds - duration;
        queue.push({
          ...next,
          arrivalAt: finishAt,
          estimatedDurationSeconds: remaining,
          schedulingRounds: (next.schedulingRounds ?? 0) + 1,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Metric aggregation
// ---------------------------------------------------------------------------

function avg(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * Count how many high-priority jobs arrived before low-priority jobs
 * that started earlier (i.e., the high-priority job waited behind a lower one).
 */
function countPriorityInversions(results) {
  let inversions = 0;
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i];
      const b = results[j];
      if (
        a.priority > b.priority &&
        a.arrivalAt <= b.arrivalAt &&
        a.startedAt > b.startedAt
      ) {
        inversions++;
      }
    }
  }
  return inversions;
}

function buildMetrics(policy, results, jobCount, totalSimulationSeconds) {
  const waits = results.map((r) => r.waitSeconds);
  const turnarounds = results.map((r) => r.turnaroundSeconds);
  const executions = results.map((r) => r.executionSeconds);
  const throughput =
    totalSimulationSeconds > 0 ? results.length / (totalSimulationSeconds / 60) : 0;
  const totalBusyCpuSeconds = results.reduce((s, r) => s + r.executionSeconds * (r.estimatedDurationSeconds > 0 ? 1 : 0), 0);
  const cpuUtilization = totalSimulationSeconds > 0
    ? Math.min(1, totalBusyCpuSeconds / (totalSimulationSeconds * 3)) // 3 virtual cores
    : 0;

  return {
    policy,
    jobCount,
    completedCount: results.length,
    avgWaitSeconds: round2(avg(waits)),
    avgTurnaroundSeconds: round2(avg(turnarounds)),
    avgExecutionSeconds: round2(avg(executions)),
    minWaitSeconds: round2(Math.min(...waits, 0)),
    maxWaitSeconds: round2(Math.max(...waits, 0)),
    throughputPerMinute: round2(throughput),
    cpuUtilization: round2(cpuUtilization),
    priorityInversions: countPriorityInversions(results),
    totalSimulationSeconds: round2(totalSimulationSeconds),
    /** Per-job breakdown for detailed charts. */
    jobs: results.map((r) => ({
      jobId: r.jobId,
      waitSeconds: round2(r.waitSeconds),
      turnaroundSeconds: round2(r.turnaroundSeconds),
      executionSeconds: round2(r.executionSeconds),
      priority: r.priority,
    })),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Simulate multiple scheduling policies against the same deterministic workload.
 *
 * This is a pure in-memory simulation — nothing is written to the database.
 * The same seed always produces the same job specifications.
 */
export function compareAlgorithms(input) {
  const { seed, count, pattern, policies, timeQuantumSeconds = 10 } = input;

  // Generate the shared workload spec (pure function, no DB involvement).
  const specs = generateWorkloadSpecs({
    seed,
    count,
    pattern,
    workloadTypes: ["SLEEP"], // neutral type for fair comparison
  });

  const baseTime = new Date(0); // t=0 so offsets map cleanly to seconds

  const jobs = specs.map((s) => specToJob(s, baseTime));

  const results = policies.map((policy) => {
    // Each policy gets an independent copy of the job list.
    const jobsCopy = jobs.map((j) => ({ ...j }));
    const rawResults = simulatePolicy(jobsCopy, policy, timeQuantumSeconds);

    const endTimes = rawResults.map((r) => r.finishAt.getTime());
    const startTimes = rawResults.map((r) => r.arrivalAt.getTime());
    const totalSimSecs =
      endTimes.length > 0 && startTimes.length > 0
        ? (Math.max(...endTimes) - Math.min(...startTimes)) / 1000
        : 0;

    return buildMetrics(policy, rawResults, count, totalSimSecs);
  });

  return {
    seed,
    count,
    pattern,
    policies,
    results,
  };
}
