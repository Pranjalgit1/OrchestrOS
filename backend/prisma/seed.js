import { PrismaClient } from "@prisma/client";
import { ensureStudyWorkers, STUDY_WORKERS } from "../src/modules/workers/worker.defaults.js";
const prisma = new PrismaClient();
export async function seedInitialWorkers() {
  await ensureStudyWorkers(prisma);
}
async function main() {
  await seedInitialWorkers();
  console.log(`Ensured ${STUDY_WORKERS.length} study workers use the built-in budgets when idle`);
}
main()
  .catch((error) => {
    console.error("Failed to seed initial workers", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
