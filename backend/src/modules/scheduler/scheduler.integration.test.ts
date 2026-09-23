import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { JobStatus, SchedulingPolicy, WorkloadType, type Job } from "@prisma/client";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import {
  prismaSchedulerRepository,
  type SchedulerRepository,
} from "./scheduler.repository.js";
import { SchedulerService } from "./scheduler.service.js";

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

/**
 * The real scheduler intentionally considers every queued job in the database.
 * These tests scope candidate discovery to their own jobs so assertions stay
 * deterministic while still exercising the real conditional claim and writes.
 */
function scopedRepository(prefix: string): SchedulerRepository {
  return {
    async findEligible(now, limit) {
      const jobs = await prismaSchedulerRepository.findEligible(now, 500);
      return jobs.filter((job) => job.name.startsWith(prefix)).slice(0, limit);
    },
    claim: prismaSchedulerRepository.claim,
    findById: prismaSchedulerRepository.findById,
  };
}

test(
  "scheduler persists policy decisions and cannot double-schedule a job",
  { skip: !databaseTestsEnabled },
  async () => {
    const prefix = `scheduler-${randomUUID()}`;
    const past = new Date(Date.now() - 120_000);
    const future = new Date(Date.now() + 3_600_000);
    const base = {
      workloadType: WorkloadType.SORTING,
      workloadSize: 5_000,
      status: JobStatus.QUEUED,
      memoryRequiredMiB: 256,
    };

    try {
      await prisma.job.createMany({
        data: [
          {
            ...base,
            name: `${prefix}-short`,
            cpuRequiredMillicores: 500,
            estimatedDurationSeconds: 5,
            priority: 3,
            arrivalAt: past,
          },
          {
            ...base,
            name: `${prefix}-long-urgent`,
            workloadType: WorkloadType.CPU_INTENSIVE,
            cpuRequiredMillicores: 1_000,
            estimatedDurationSeconds: 90,
            priority: 9,
            arrivalAt: past,
          },
          {
            ...base,
            name: `${prefix}-not-due`,
            workloadType: WorkloadType.SLEEP,
            cpuRequiredMillicores: 500,
            estimatedDurationSeconds: 5,
            priority: 10,
            arrivalAt: future,
          },
        ],
      });

      const service = new SchedulerService(scopedRepository(prefix));

      // Planned arrival gating: the future job is never a candidate.
      const sjfPreview = await service.preview({ policy: SchedulingPolicy.SJF, limit: 100 });
      assert.deepEqual(sjfPreview.jobs.map((job) => job.name), [
        `${prefix}-short`,
        `${prefix}-long-urgent`,
      ]);
      assert.equal(
        await prisma.job.count({ where: { name: { startsWith: prefix }, status: JobStatus.QUEUED } }),
        3,
        "preview must not change persisted state",
      );

      // Priority outranks a shorter job, and the decision is persisted.
      const priorityResult = await service.dispatch({
        policy: SchedulingPolicy.PRIORITY,
        count: 1,
      });
      assert.equal(priorityResult.scheduledCount, 1);
      const urgent = priorityResult.scheduled[0];
      assert.ok(urgent);
      assert.equal(urgent.name, `${prefix}-long-urgent`);

      const persistedUrgent = await prisma.job.findUniqueOrThrow({ where: { id: urgent.id } });
      assert.equal(persistedUrgent.status, JobStatus.SCHEDULED);
      assert.equal(persistedUrgent.schedulingPolicy, SchedulingPolicy.PRIORITY);
      assert.equal(persistedUrgent.schedulingRounds, 1);
      assert.equal(persistedUrgent.timeQuantumSeconds, null);
      assert.ok(persistedUrgent.scheduledAt);

      // Round robin records the quantum on the remaining due job.
      const roundRobinResult = await service.dispatch({
        policy: SchedulingPolicy.ROUND_ROBIN,
        count: 5,
      });
      assert.equal(roundRobinResult.scheduledCount, 1);
      assert.equal(roundRobinResult.timeQuantumSeconds, 10);
      const rotated = roundRobinResult.scheduled[0];
      assert.ok(rotated);
      assert.equal(rotated.name, `${prefix}-short`);
      assert.equal(rotated.timeQuantumSeconds, 10);
      assert.equal(rotated.schedulingRounds, 1);

      // Nothing else is due, so further dispatches schedule nothing.
      const exhausted = await service.dispatch({ policy: SchedulingPolicy.FCFS, count: 5 });
      assert.equal(exhausted.eligibleCount, 0);
      assert.equal(exhausted.scheduledCount, 0);
      assert.equal(
        await prisma.job.count({
          where: { name: { startsWith: prefix }, status: JobStatus.SCHEDULED },
        }),
        2,
      );

      // Concurrency guarantee: parallel claims on one queued job succeed once.
      const contested = await prisma.job.create({
        data: {
          ...base,
          name: `${prefix}-contested`,
          cpuRequiredMillicores: 500,
          estimatedDurationSeconds: 7,
          priority: 5,
          arrivalAt: past,
        },
      });
      const claimAttempts = await Promise.all(
        Array.from({ length: 4 }, () =>
          prismaSchedulerRepository.claim({
            jobId: contested.id,
            policy: SchedulingPolicy.FCFS,
            scheduledAt: new Date(),
            timeQuantumSeconds: null,
          }),
        ),
      );

      assert.equal(
        claimAttempts.filter(Boolean).length,
        1,
        "exactly one concurrent claim may schedule a queued job",
      );
      const persistedContested: Job = await prisma.job.findUniqueOrThrow({
        where: { id: contested.id },
      });
      assert.equal(persistedContested.status, JobStatus.SCHEDULED);
      assert.equal(
        persistedContested.schedulingRounds,
        1,
        "a losing claim must not increment the scheduling round",
      );

      // Route contracts stay stable.
      await withServer(async (baseUrl) => {
        const previewResponse = await fetch(`${baseUrl}/scheduler/preview?policy=FCFS&limit=5`);
        const preview = (await previewResponse.json()) as { policy: string; jobs: unknown[] };
        assert.equal(previewResponse.status, 200);
        assert.equal(preview.policy, "FCFS");
        assert.ok(Array.isArray(preview.jobs));

        const invalidQuantum = await fetch(`${baseUrl}/scheduler/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ policy: "FCFS", timeQuantumSeconds: 20 }),
        });
        assert.equal(invalidQuantum.status, 400);

        const invalidPolicy = await fetch(`${baseUrl}/scheduler/preview?policy=NOPE`);
        assert.equal(invalidPolicy.status, 400);
      });
    } finally {
      await prisma.job.deleteMany({ where: { name: { startsWith: prefix } } });
      await prisma.$disconnect();
    }
  },
);
