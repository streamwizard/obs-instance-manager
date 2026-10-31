import { z } from "zod";

// PATCH /instances/:id/files/rename
export const renameFileSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });

// DELETE /instances/:id/files
export const deleteFileSchema = z.object({ path: z.string().min(1) });
