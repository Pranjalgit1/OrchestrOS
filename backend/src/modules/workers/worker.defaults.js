/** Small logical budgets sharing one development computer (3 GiB in total). */
export const STUDY_WORKERS = [
  { name: "worker-1", cpuCapacityMillicores: 500, memoryCapacityMiB: 512 },
  { name: "worker-2", cpuCapacityMillicores: 1000, memoryCapacityMiB: 1024 },
  { name: "worker-3", cpuCapacityMillicores: 1500, memoryCapacityMiB: 1536 },
];

/** Apply built-in budgets to idle default workers without shrinking live reservations. */
export async function ensureStudyWorkers(client) {
  return client.$transaction(async (tx) => {
    for (const limits of STUDY_WORKERS) {
      await tx.worker.upsert({ where: { name: limits.name }, update: {}, create: limits });
      await tx.$queryRaw`SELECT \`id\` FROM \`workers\` WHERE \`name\` = ${limits.name} FOR UPDATE`;
      const worker = await tx.worker.findUnique({ where: { name: limits.name } });
      if (worker.cpuCapacityMillicores === limits.cpuCapacityMillicores &&
          worker.memoryCapacityMiB === limits.memoryCapacityMiB) continue;
      const reserved = await tx.resourceAllocation.count({
        where: { workerId: worker.id, status: "RESERVED" },
      });
      if (reserved || worker.cpuAllocatedMillicores || worker.memoryAllocatedMiB) continue;
      await tx.worker.update({ where: { id: worker.id }, data: {
        cpuCapacityMillicores: limits.cpuCapacityMillicores,
        memoryCapacityMiB: limits.memoryCapacityMiB,
      } });
    }
  });
}
