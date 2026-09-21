import { PrismaClient, WorkerStatus } from "@prisma/client";

const prisma = new PrismaClient();

const initialWorkers = [
  {
    name: "worker-1",
    cpuCapacityMillicores: 2_000,
    memoryCapacityMiB: 2_048,
  },
  {
    name: "worker-2",
    cpuCapacityMillicores: 4_000,
    memoryCapacityMiB: 4_096,
  },
  {
    name: "worker-3",
    cpuCapacityMillicores: 6_000,
    memoryCapacityMiB: 8_192,
  },
] as const;

export async function seedInitialWorkers(): Promise<void> {
  for (const worker of initialWorkers) {
    await prisma.worker.upsert({
      where: { name: worker.name },
      update: {},
      create: {
        ...worker,
        status: WorkerStatus.IDLE,
      },
    });
  }
}

async function main(): Promise<void> {
  await seedInitialWorkers();
  console.log(`Ensured ${initialWorkers.length} initial logical workers exist`);
}

main()
  .catch((error: unknown) => {
    console.error("Failed to seed initial workers", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
