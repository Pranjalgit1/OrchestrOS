import assert from "node:assert/strict";
import test from "node:test";
import { reservationChart } from "./reservation.chart.js";

const point = (capturedAt, cpuUtilization = 0.5, memoryUtilization = 0.25) =>
  ({ capturedAt, cpuUtilization, memoryUtilization });

test("a fifteen-second sample gap occupies fifteen seconds on a one-hour chart", () => {
  const chart = reservationChart([
    point("2026-10-11T11:00:00Z"), point("2026-10-11T11:00:15Z"), point("2026-10-11T12:00:00Z"),
  ]);
  assert.equal(chart.coordinates[0].x, 0);
  assert.equal(chart.coordinates[1].x, 2.5);
  assert.equal(chart.coordinates[2].x, 600);
  assert.equal(chart.end - chart.start, 3_600_000);
});

test("zero or one capture has no invented time span or invalid coordinates", () => {
  assert.equal(reservationChart([]), null);
  const chart = reservationChart([point("2026-10-11T11:00:00Z")]);
  assert.equal(chart.start, chart.end);
  assert.equal(chart.coordinates[0].x, 300);
  assert.equal(chart.cpuPath, "M300.0,45.0");
  const repeated = reservationChart([point("2026-10-11T11:00:00Z"), point("2026-10-11T11:00:00Z")]);
  assert.ok(repeated.coordinates.every((entry) => Number.isFinite(entry.x)));
});
