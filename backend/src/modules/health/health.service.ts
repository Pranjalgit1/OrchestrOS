import { prisma } from "../../lib/prisma.js";

export type DependencyStatus = "up" | "down";

export interface HealthStatus {
  service: "orchestr-os-backend";
  status: "ok" | "degraded";
  timestamp: string;
  dependencies: {
    database: DependencyStatus;
  };
}

export async function getHealthStatus(): Promise<HealthStatus> {
  let database: DependencyStatus = "down";

  try {
    await prisma.$transaction([
      prisma.job.count(),
      prisma.worker.count(),
      prisma.resourceAllocation.count(),
      prisma.jobExecution.count(),
      prisma.workloadBatch.count(),
    ]);
    database = "up";
  } catch {
    database = "down";
  }

  return {
    service: "orchestr-os-backend",
    status: database === "up" ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    dependencies: {
      database,
    },
  };
}
