import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  AllocationStatus,
  ExecutionStatus,
  JobStatus,
  WorkerStatus,
  WorkloadType,
  type Worker,
} from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { utilizationSeries } from "./monitoring.metrics.js";
import { prismaMonitoringRepository } from "./monitoring.repository.js";
import { MonitoringService } from "./monitoring.service.js";

const databaseTestsEnabled = process.env.RUN_DATABASE_TESTS === "true";

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}/api`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function makeWorker(prefix: string, overrides: Partial<Worker> = {}): Promise<Worker> {
  return prisma.worker.create({
    data: {
      name: `${prefix}-${randomUUID().slice(0, 8)}`,
      cpuCapacityMillicores: overrides.cpuCapacityMillicores ?? 2_000,
      memoryCapacityMiB: overrides.memoryCapacityMiB ?? 2_048,
      cpuAllocatedMillicores: overrides.cpuAllocatedMillicores ?? 0,
      memoryAllocatedMiB: overrides.memoryAllocatedMiB ?? 0,
      status: overrides.status ?? WorkerStatus.IDLE,
    },
  });
}

async function cleanup(prefix: string): Promise<void> {
  // Samples cascade with their worker, but jobs and executions must go first.
  await prisma.jobExecution.deleteMany({ where: { job: { name: { startsWith: prefix } } } });
  await prisma.resourceAllocation.deleteMany({
    where: { job: { name: { startsWith: prefix } } },
  });
  await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.worker.deleteMany({ where: { name: { startsWith: prefix } } });
}

test(
  "a sampling pass records one row per worker sharing a timestamp",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `mon-sample-${randomUUID().slice(0, 8)}`;

    try {
      const busy = await makeWorker(prefix, {
        cpuAllocatedMillicores: 800,
        memoryAllocatedMiB: 512,
        status: WorkerStatus.BUSY,
      });
      const idle = await makeWorker(prefix);
      const owned = [busy.id, idle.id];

      // A pass samples every worker in the database, and other test files create
      // their own, so assertions here are scoped to the workers this test owns.
      const capturedAt = new Date();
      const recorded = await prismaMonitoringRepository.captureSample(capturedAt);
      assert.ok(recorded >= owned.length, "a pass samples every worker, not just the busy ones");

      const rows = await prisma.workerSample.findMany({
        where: { capturedAt, workerId: { in: owned } },
      });
      assert.equal(rows.length, owned.length, "both workers were sampled");
      assert.ok(
        rows.every((row) => row.capturedAt.getTime() === capturedAt.getTime()),
        "one pass shares a single timestamp so it can be grouped into a cluster point",
      );

      const busySample = rows.find((row) => row.workerId === busy.id);
      assert.ok(busySample);
      assert.equal(busySample.cpuAllocatedMillicores, 800, "the sample copies real accounting");
      assert.equal(busySample.memoryAllocatedMiB, 512);
      assert.equal(busySample.status, WorkerStatus.BUSY);

      const idleSample = rows.find((row) => row.workerId === idle.id);
      assert.equal(idleSample?.cpuAllocatedMillicores, 0, "an idle worker samples as unclaimed");

      // Repeating the pass at the same instant must not double count.
      await prismaMonitoringRepository.captureSample(capturedAt);
      assert.equal(
        await prisma.workerSample.count({ where: { capturedAt, workerId: { in: owned } } }),
        owned.length,
        "the unique index makes a repeated pass a no-op",
      );

      // A later pass is a distinct point in the series.
      const later = new Date(capturedAt.getTime() + 15_000);
      await prismaMonitoringRepository.captureSample(later);
      const series = utilizationSeries(
        await prisma.workerSample.findMany({
          where: { capturedAt: { in: [capturedAt, later] }, workerId: { in: owned } },
        }),
      );
      assert.equal(series.length, 2, "two passes produce two cluster points");
      assert.equal(series[0]?.workerCount, owned.length, "each point sums that pass's workers");
      assert.ok(
        (series[0]?.capturedAt.getTime() ?? 0) < (series[1]?.capturedAt.getTime() ?? 0),
        "points are ordered oldest first",
      );
      assert.equal(
        series[0]?.cpuAllocatedMillicores,
        800,
        "the cluster point totals the claimed capacity of that pass",
      );

      // The pass also sampled workers this test does not own; leave no trace.
      await prisma.workerSample.deleteMany({ where: { capturedAt: { in: [capturedAt, later] } } });
    } finally {
      await prisma.workerSample.deleteMany({ where: { worker: { name: { startsWith: prefix } } } });
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "retention pruning removes only samples older than the window",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `mon-prune-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix);
      const now = new Date();
      const old = new Date(now.getTime() - 48 * 3_600_000);
      const recent = new Date(now.getTime() - 60_000);

      await prisma.workerSample.createMany({
        data: [old, recent].map((capturedAt) => ({
          workerId: worker.id,
          capturedAt,
          cpuCapacityMillicores: 2_000,
          memoryCapacityMiB: 2_048,
          cpuAllocatedMillicores: 0,
          memoryAllocatedMiB: 0,
          status: WorkerStatus.IDLE,
        })),
      });

      const pruned = await prismaMonitoringRepository.pruneSamples(
        new Date(now.getTime() - 24 * 3_600_000),
      );
      assert.ok(pruned >= 1, "the stale sample is removed");

      const remaining = await prisma.workerSample.findMany({ where: { workerId: worker.id } });
      assert.equal(remaining.length, 1, "the recent sample survives");
      assert.equal(remaining[0]?.capturedAt.getTime(), recent.getTime());
    } finally {
      await prisma.workerSample.deleteMany({ where: { worker: { name: { startsWith: prefix } } } });
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "the database rejects samples that contradict real accounting",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `mon-constraint-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix);
      const base = {
        workerId: worker.id,
        cpuCapacityMillicores: 2_000,
        memoryCapacityMiB: 2_048,
        cpuAllocatedMillicores: 0,
        memoryAllocatedMiB: 0,
        status: WorkerStatus.IDLE,
      };

      await assert.rejects(
        () =>
          prisma.workerSample.create({
            data: { ...base, capturedAt: new Date(), cpuAllocatedMillicores: 2_500 },
          }),
        "a sample cannot claim more CPU than the worker has",
      );

      await assert.rejects(
        () =>
          prisma.workerSample.create({
            data: { ...base, capturedAt: new Date(), memoryAllocatedMiB: 9_999 },
          }),
        "a sample cannot claim more memory than the worker has",
      );

      await assert.rejects(
        () =>
          prisma.workerSample.create({
            data: { ...base, capturedAt: new Date(), runningExecutions: -1 },
          }),
        "counts cannot be negative",
      );

      assert.equal(
        await prisma.workerSample.count({ where: { workerId: worker.id } }),
        0,
        "no invalid sample survived",
      );

      // Samples are observational, so deleting a worker takes them with it.
      await prisma.workerSample.create({ data: { ...base, capturedAt: new Date() } });
      assert.equal(await prisma.workerSample.count({ where: { workerId: worker.id } }), 1);
      await prisma.worker.delete({ where: { id: worker.id } });
      assert.equal(
        await prisma.workerSample.count({ where: { workerId: worker.id } }),
        0,
        "observational rows follow their worker instead of blocking its deletion",
      );
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "lifecycle timings and activity are computed from the real records",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `mon-timing-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix);
      const arrivalAt = new Date(Date.now() - 120_000);
      const scheduledAt = new Date(arrivalAt.getTime() + 10_000);
      const placedAt = new Date(scheduledAt.getTime() + 2_000);
      const startedAt = new Date(placedAt.getTime() + 3_000);
      const completedAt = new Date(startedAt.getTime() + 5_000);

      const job = await prisma.job.create({
        data: {
          name: `${prefix}-job`,
          workloadType: WorkloadType.SORTING,
          workloadSize: 1_000,
          status: JobStatus.COMPLETED,
          cpuRequiredMillicores: 500,
          memoryRequiredMiB: 256,
          estimatedDurationSeconds: 5,
          priority: 5,
          arrivalAt,
          scheduledAt,
          placedAt,
          startedAt,
          completedAt,
          assignedWorkerId: worker.id,
          schedulingPolicy: "FCFS",
          placementStrategy: "FIRST_FIT",
        },
      });

      const allocation = await prisma.resourceAllocation.create({
        data: {
          jobId: job.id,
          workerId: worker.id,
          cpuMillicores: 500,
          memoryMiB: 256,
          status: AllocationStatus.RELEASED,
          releasedAt: completedAt,
        },
      });

      await prisma.jobExecution.create({
        data: {
          jobId: job.id,
          workerId: worker.id,
          allocationId: allocation.id,
          attempt: 1,
          status: ExecutionStatus.COMPLETED,
          containerId: "a".repeat(64),
          startedAt,
          completedAt,
          exitCode: 0,
        },
      });

      const rows = await prismaMonitoringRepository.jobTimings(
        new Date(Date.now() - 10 * 60_000),
      );
      const byMetric = new Map(rows.map((row) => [row.metric, row]));

      assert.equal(byMetric.get("queueWait")?.maximum, 10, "scheduledAt minus arrivalAt");
      assert.equal(byMetric.get("placementDelay")?.maximum, 2, "placedAt minus scheduledAt");
      assert.equal(byMetric.get("startDelay")?.maximum, 3, "startedAt minus placedAt");
      assert.equal(byMetric.get("execution")?.maximum, 5, "completedAt minus startedAt");
      assert.equal(byMetric.get("turnaround")?.maximum, 20, "completedAt minus arrivalAt");
      assert.ok(
        (byMetric.get("turnaround")?.p95 ?? 0) > 0,
        "PostgreSQL computes the percentile rather than the process",
      );

      const terminal = await prismaMonitoringRepository.terminalJobCounts(
        new Date(Date.now() - 10 * 60_000),
      );
      assert.ok((terminal[JobStatus.COMPLETED] ?? 0) >= 1);

      const activity = await prismaMonitoringRepository.workerActivity();
      const mine = activity.find((entry) => entry.workerId === worker.id);
      assert.ok(mine);
      assert.equal(mine.executionsRun, 1);
      assert.equal(mine.jobsCompleted, 1);
      assert.equal(mine.jobsFailed, 0);
      assert.equal(mine.reservedAllocations, 0, "a released allocation is not an active claim");
      assert.equal(mine.runningExecutions, 0);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "the overview reports a running execution and its active reservation",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `mon-overview-${randomUUID().slice(0, 8)}`;

    try {
      const worker = await makeWorker(prefix, {
        cpuAllocatedMillicores: 800,
        memoryAllocatedMiB: 512,
        status: WorkerStatus.BUSY,
      });
      const startedAt = new Date(Date.now() - 4_000);

      const job = await prisma.job.create({
        data: {
          name: `${prefix}-running`,
          workloadType: WorkloadType.CPU_INTENSIVE,
          workloadSize: 5_000,
          status: JobStatus.RUNNING,
          cpuRequiredMillicores: 800,
          memoryRequiredMiB: 512,
          estimatedDurationSeconds: 10,
          priority: 5,
          assignedWorkerId: worker.id,
          // A running job has been through scheduling and placement, and the
          // database enforces that both decisions are recorded completely.
          schedulingPolicy: "FCFS",
          scheduledAt: new Date(startedAt.getTime() - 2_000),
          placementStrategy: "FIRST_FIT",
          placedAt: new Date(startedAt.getTime() - 1_000),
          startedAt,
        },
      });
      const allocation = await prisma.resourceAllocation.create({
        data: {
          jobId: job.id,
          workerId: worker.id,
          cpuMillicores: 800,
          memoryMiB: 512,
          status: AllocationStatus.RESERVED,
        },
      });
      await prisma.jobExecution.create({
        data: {
          jobId: job.id,
          workerId: worker.id,
          allocationId: allocation.id,
          attempt: 1,
          status: ExecutionStatus.RUNNING,
          containerId: "b".repeat(64),
          startedAt,
        },
      });

      const service = new MonitoringService(prismaMonitoringRepository);
      const overview = await service.overview();

      assert.ok(overview.cluster.cpuAllocatedMillicores >= 800);
      assert.ok(overview.cluster.cpuUtilization > 0, "committed capacity shows as utilization");
      assert.equal(overview.queue.active >= 1, true);
      assert.ok(overview.reservations.active >= 1);

      const running = overview.executions.running.find((entry) => entry.jobId === job.id);
      assert.ok(running, "the running execution is listed");
      assert.equal(running.workerName, worker.name);
      assert.equal(running.workloadType, WorkloadType.CPU_INTENSIVE);
      assert.ok(running.elapsedSeconds >= 3, "elapsed time is measured from startedAt");

      const mine = overview.workers.find((entry) => entry.workerId === worker.id);
      assert.ok(mine);
      assert.equal(mine.reservedAllocations, 1);
      assert.equal(mine.runningExecutions, 1);
      assert.equal(mine.cpuAllocatedMillicores, 800);
    } finally {
      await cleanup(prefix);
      await prisma.$disconnect();
    }
  },
);

test(
  "monitoring routes serve metrics and validate their windows",
  { skip: !databaseTestsEnabled },
  async () => {
    try {
      await withServer(async (baseUrl) => {
        const overviewResponse = await fetch(`${baseUrl}/monitoring/overview`);
        const overview = (await overviewResponse.json()) as {
          cluster: { cpuCapacityMillicores: number };
          workers: unknown[];
          capturedAt: string;
        };
        assert.equal(overviewResponse.status, 200);
        assert.ok(overview.cluster.cpuCapacityMillicores > 0, "seeded workers report capacity");
        assert.ok(Array.isArray(overview.workers));
        assert.ok(Date.parse(overview.capturedAt) > 0);

        const jobsResponse = await fetch(`${baseUrl}/monitoring/jobs?windowMinutes=30`);
        const jobs = (await jobsResponse.json()) as {
          windowMinutes: number;
          timings: Record<string, { count: number }>;
        };
        assert.equal(jobsResponse.status, 200);
        assert.equal(jobs.windowMinutes, 30);
        assert.deepEqual(
          Object.keys(jobs.timings).sort(),
          ["execution", "placementDelay", "queueWait", "startDelay", "turnaround"],
          "every stage is reported even when nothing has been measured",
        );

        assert.equal(
          (await fetch(`${baseUrl}/monitoring/jobs?windowMinutes=0`)).status,
          400,
          "a zero window is rejected",
        );
        assert.equal(
          (await fetch(`${baseUrl}/monitoring/jobs?windowMinutes=99999`)).status,
          400,
          "an unbounded window is rejected",
        );
        assert.equal(
          (await fetch(`${baseUrl}/monitoring/jobs?unknown=1`)).status,
          400,
          "unknown query keys are rejected",
        );

        const configResponse = await fetch(`${baseUrl}/monitoring/config`);
        const config = (await configResponse.json()) as {
          sampleIntervalSeconds: number;
          periodicSamplingEnabled: boolean;
        };
        assert.equal(configResponse.status, 200);
        assert.equal(
          config.periodicSamplingEnabled,
          config.sampleIntervalSeconds > 0,
          "the dashboard can explain why history might be empty",
        );

        const captureResponse = await fetch(`${baseUrl}/monitoring/sample`, { method: "POST" });
        const capture = (await captureResponse.json()) as {
          workersRecorded: number;
          capturedAt: string;
        };
        assert.equal(captureResponse.status, 201);
        assert.ok(capture.workersRecorded >= 1, "an on-demand pass records the current workers");

        const samplesResponse = await fetch(
          `${baseUrl}/monitoring/samples?windowMinutes=60&limit=50`,
        );
        const samples = (await samplesResponse.json()) as {
          pointCount: number;
          points: { cpuUtilization: number }[];
        };
        assert.equal(samplesResponse.status, 200);
        assert.ok(samples.pointCount >= 1, "the sample just captured is visible as a point");
        assert.ok(samples.points.every((point) => point.cpuUtilization >= 0));

        assert.equal(
          (await fetch(`${baseUrl}/monitoring/samples?limit=0`)).status,
          400,
        );
        assert.equal(
          (await fetch(`${baseUrl}/monitoring/samples?workerId=nope`)).status,
          400,
        );
      });
    } finally {
      await prisma.$disconnect();
    }
  },
);
