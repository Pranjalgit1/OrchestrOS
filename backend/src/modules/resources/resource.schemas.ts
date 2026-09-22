import { AllocationStatus } from "@prisma/client";
import { z } from "zod";

export const reserveResourcesSchema = z.object({ jobId: z.uuid() }).strict();

export const releaseResourcesSchema = z.object({ jobId: z.uuid() }).strict();

export const listAllocationsQuerySchema = z
  .object({
    jobId: z.uuid().optional(),
    workerId: z.uuid().optional(),
    status: z.nativeEnum(AllocationStatus).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type ReserveResourcesInput = z.infer<typeof reserveResourcesSchema>;
export type ReleaseResourcesInput = z.infer<typeof releaseResourcesSchema>;
export type ListAllocationsQuery = z.infer<typeof listAllocationsQuerySchema>;
