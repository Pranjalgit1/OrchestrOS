import assert from "node:assert/strict";
import test from "node:test";
import { jobAge, selectQueueJobs } from "./job-queue.view.js";

const makeJob = (id, overrides = {}) => ({ id, name: `job-${id}`, status: "COMPLETED", workloadType: "CPU_INTENSIVE",
  assignedWorkerId: "w1", assignedWorkerName: "worker-1", cpuRequiredMillicores: 100, ...overrides });

test("queue search composes with status and worker filters without changing API rows", () => {
  const jobs = [makeJob("2"), makeJob("10", { status: "RUNNING" }), makeJob("3", { assignedWorkerId: null, assignedWorkerName: null })];
  const before = structuredClone(jobs);
  assert.deepEqual(selectQueueJobs(jobs, { query: " CPU intensive ", filter: "COMPLETED", worker: "w1" }).map((job) => job.id), ["2"]);
  assert.deepEqual(selectQueueJobs(jobs, { worker: "UNASSIGNED" }).map((job) => job.id), ["3"]);
  assert.equal(selectQueueJobs(jobs, { query: "does not exist" }).length, 0);
  assert.deepEqual(jobs, before);
});

test("queue sorting handles numeric job names, resource values, age and missing dates", () => {
  const jobs = [makeJob("10", { cpuRequiredMillicores: 1000, createdAt: "2026-10-11T10:00:00Z" }),
    makeJob("2", { cpuRequiredMillicores: 200, createdAt: "2026-10-11T11:00:00Z" }), makeJob("3")];
  const sorted = (key, direction) => selectQueueJobs(jobs, { sort: { key, direction } }).map((job) => job.id);
  assert.deepEqual(sorted("name", "asc"), ["2", "3", "10"]);
  assert.deepEqual(sorted("cpuRequiredMillicores", "desc"), ["10", "2", "3"]);
  assert.deepEqual(sorted("age", "asc"), ["2", "10", "3"]);
  assert.deepEqual(sorted("age", "desc"), ["10", "2", "3"]);
  const timestamps = [makeJob("old", { updatedAt: "2026-10-11T10:00:00Z" }), makeJob("new", { updatedAt: "2026-10-11T12:00:00Z" })];
  assert.equal(selectQueueJobs(timestamps)[0].id, "new");
});

test("job age uses creation time and safely handles missing or future timestamps", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(jobAge("2026-10-11T11:59:55Z", now), "5s");
  assert.equal(jobAge("2026-10-11T11:58:00Z", now), "2m");
  assert.equal(jobAge("2026-10-11T10:00:00Z", now), "2h");
  assert.equal(jobAge("2026-10-09T12:00:00Z", now), "2d");
  assert.equal(jobAge("2026-10-12T12:00:00Z", now), "0s");
  assert.equal(jobAge(undefined, now), "—");
  assert.equal(jobAge("invalid", now), "—");
});
