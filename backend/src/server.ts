import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { executionService } from "./modules/executions/execution.service.js";

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`OrchestrOS backend listening on http://${env.HOST}:${env.PORT}`);
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`${signal} received; shutting down OrchestrOS backend`);

  server.close(async (error) => {
    // Let running containers finish being recorded, otherwise their executions
    // would stay RUNNING and keep holding reservations.
    await executionService.awaitPendingSettlements();
    await prisma.$disconnect();

    if (error) {
      console.error("Backend shutdown failed", error);
      process.exit(1);
    }

    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
