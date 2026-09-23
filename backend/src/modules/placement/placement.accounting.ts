import {
  PlacementStrategy,
  WorkerStatus,
  type Job,
  type Worker,
} from "@prisma/client";

/** Worker states that may receive new work. */
export const SCHEDULABLE_WORKER_STATUSES: readonly WorkerStatus[] = [
  WorkerStatus.IDLE,
  WorkerStatus.ACTIVE,
  WorkerStatus.BUSY,
];

/** Weights for the explainable RESOURCE_AWARE score. */
export const PEAK_WEIGHT = 0.7;
export const IMBALANCE_WEIGHT = 0.3;

export interface WorkerLoad {
  cpuMillicores: number;
  memoryMiB: number;
}

export interface WorkerCapacitySnapshot {
  workerId: string;
  name: string;
  status: WorkerStatus;
  cpuCapacityMillicores: number;
  memoryCapacityMiB: number;
  /** Persisted reservations. Written only by transactional reservation. */
  cpuReservedMillicores: number;
  memoryReservedMiB: number;
  /** Advisory load from jobs already placed on this worker but not yet reserved. */
  cpuAssignedMillicores: number;
  memoryAssignedMiB: number;
  cpuAvailableMillicores: number;
  memoryAvailableMiB: number;
  cpuUtilization: number;
  memoryUtilization: number;
  schedulable: boolean;
}

export interface PlacementCandidate {
  worker: WorkerCapacitySnapshot;
  eligible: boolean;
  reasons: string[];
  score: number | null;
}

export interface PlacementEvaluation {
  strategy: PlacementStrategy;
  candidates: PlacementCandidate[];
  selected: WorkerCapacitySnapshot | null;
}

function ratio(used: number, capacity: number): number {
  return capacity <= 0 ? 1 : Math.min(1, Math.max(0, used / capacity));
}

/**
 * Builds a capacity snapshot. Available capacity subtracts both persisted
 * reservations and the advisory load of jobs already placed on the worker, so
 * repeated placements cannot overcommit the plan before reservation exists.
 */
export function buildSnapshot(worker: Worker, assigned: WorkerLoad): WorkerCapacitySnapshot {
  const cpuUsed = worker.cpuAllocatedMillicores + assigned.cpuMillicores;
  const memoryUsed = worker.memoryAllocatedMiB + assigned.memoryMiB;

  return {
    workerId: worker.id,
    name: worker.name,
    status: worker.status,
    cpuCapacityMillicores: worker.cpuCapacityMillicores,
    memoryCapacityMiB: worker.memoryCapacityMiB,
    cpuReservedMillicores: worker.cpuAllocatedMillicores,
    memoryReservedMiB: worker.memoryAllocatedMiB,
    cpuAssignedMillicores: assigned.cpuMillicores,
    memoryAssignedMiB: assigned.memoryMiB,
    cpuAvailableMillicores: Math.max(0, worker.cpuCapacityMillicores - cpuUsed),
    memoryAvailableMiB: Math.max(0, worker.memoryCapacityMiB - memoryUsed),
    cpuUtilization: ratio(cpuUsed, worker.cpuCapacityMillicores),
    memoryUtilization: ratio(memoryUsed, worker.memoryCapacityMiB),
    schedulable: SCHEDULABLE_WORKER_STATUSES.includes(worker.status),
  };
}

/** A worker is eligible only when it is schedulable and fits both resources. */
export function evaluateEligibility(
  snapshot: WorkerCapacitySnapshot,
  job: Pick<Job, "cpuRequiredMillicores" | "memoryRequiredMiB">,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (!snapshot.schedulable) {
    reasons.push(`Worker status ${snapshot.status} cannot accept work`);
  }
  if (snapshot.cpuAvailableMillicores < job.cpuRequiredMillicores) {
    reasons.push(
      `Insufficient CPU: needs ${job.cpuRequiredMillicores}m, has ${snapshot.cpuAvailableMillicores}m`,
    );
  }
  if (snapshot.memoryAvailableMiB < job.memoryRequiredMiB) {
    reasons.push(
      `Insufficient memory: needs ${job.memoryRequiredMiB}MiB, has ${snapshot.memoryAvailableMiB}MiB`,
    );
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * Lower scores win. FIRST_FIT keeps a stable order, LEAST_LOADED prefers the
 * lowest current peak utilization, and RESOURCE_AWARE prefers the placement
 * that leaves the lowest peak utilization and the most balanced worker.
 */
export function scoreCandidate(
  snapshot: WorkerCapacitySnapshot,
  job: Pick<Job, "cpuRequiredMillicores" | "memoryRequiredMiB">,
  strategy: PlacementStrategy,
): number {
  switch (strategy) {
    case PlacementStrategy.FIRST_FIT:
      return 0;

    case PlacementStrategy.LEAST_LOADED:
      return Math.max(snapshot.cpuUtilization, snapshot.memoryUtilization);

    case PlacementStrategy.RESOURCE_AWARE: {
      const cpuAfter = ratio(
        snapshot.cpuReservedMillicores + snapshot.cpuAssignedMillicores + job.cpuRequiredMillicores,
        snapshot.cpuCapacityMillicores,
      );
      const memoryAfter = ratio(
        snapshot.memoryReservedMiB + snapshot.memoryAssignedMiB + job.memoryRequiredMiB,
        snapshot.memoryCapacityMiB,
      );
      const peak = Math.max(cpuAfter, memoryAfter);
      const imbalance = Math.abs(cpuAfter - memoryAfter);
      return PEAK_WEIGHT * peak + IMBALANCE_WEIGHT * imbalance;
    }

    default:
      return 0;
  }
}

/**
 * Pure placement decision: evaluates every worker and selects one, or none when
 * no worker has enough free CPU and memory.
 */
export function evaluatePlacement(
  snapshots: readonly WorkerCapacitySnapshot[],
  job: Pick<Job, "cpuRequiredMillicores" | "memoryRequiredMiB">,
  strategy: PlacementStrategy,
): PlacementEvaluation {
  const candidates: PlacementCandidate[] = [...snapshots]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((worker) => {
      const { eligible, reasons } = evaluateEligibility(worker, job);
      return {
        worker,
        eligible,
        reasons,
        score: eligible ? scoreCandidate(worker, job, strategy) : null,
      };
    });

  const eligible = candidates.filter((candidate) => candidate.eligible);
  const best = eligible.reduce<PlacementCandidate | undefined>((current, candidate) => {
    if (!current) {
      return candidate;
    }
    const currentScore = current.score ?? Number.POSITIVE_INFINITY;
    const candidateScore = candidate.score ?? Number.POSITIVE_INFINITY;
    return candidateScore < currentScore ? candidate : current;
  }, undefined);

  return {
    strategy,
    candidates,
    selected: best?.worker ?? null,
  };
}
