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

export type AssignPlacementInput = z.infer<typeof assignPlacementSchema>;
export type PreviewPlacementQuery = z.infer<typeof previewPlacementQuerySchema>;
