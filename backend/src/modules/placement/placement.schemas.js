import { PlacementStrategy } from "@prisma/client";
import { z } from "zod";
export const assignPlacementSchema = z
  .object({
    jobId: z.uuid(),
    strategy: z.nativeEnum(PlacementStrategy),
  })
  .strict();
export const previewPlacementQuerySchema = z
  .object({
    jobId: z.uuid(),
    strategy: z.nativeEnum(PlacementStrategy),
  })
  .strict();
