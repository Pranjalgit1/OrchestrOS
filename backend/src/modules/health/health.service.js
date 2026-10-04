import { prisma } from "../../lib/prisma.js";
export async function getHealthStatus() {
  let database = "down";
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
