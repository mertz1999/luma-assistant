import { z } from "zod";

export const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  instructions: z.string().max(12000).default(""),
  allowAgentMemory: z.boolean().default(true),
});
export const projectUpdateSchema = projectInputSchema.extend({ expectedRevision: z.number().int().positive() });
export type Project = z.infer<typeof projectInputSchema> & { id: string; revision: number; createdAt: number; updatedAt: number; sessionCount: number; memoryCount: number };
export const memoryCategorySchema = z.enum(["fact", "decision", "preference", "lesson"]);
export const memoryInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(8000),
  category: memoryCategorySchema.default("fact"),
  reason: z.string().trim().min(1).max(1000),
});
export const memoryUpdateSchema = memoryInputSchema.extend({ expectedRevision: z.number().int().positive() });
export const memoryRemoveSchema = z.object({ expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1).max(1000) });
export const memoryUndoSchema = memoryRemoveSchema.extend({ restoreRevision: z.number().int().positive().optional() });
const memoryIdSchema = z.object({ id: z.string().min(1) });
export const memoryToolSchemas = {
  memory_search: z.object({ query: z.string().max(2000).default("") }).strict(),
  memory_get: memoryIdSchema.strict(),
  memory_history: memoryIdSchema.strict(),
  memory_add: memoryInputSchema.strict(),
  memory_update: memoryUpdateSchema.extend(memoryIdSchema.shape).strict(),
  memory_remove: memoryRemoveSchema.extend(memoryIdSchema.shape).strict(),
  memory_undo: memoryUndoSchema.extend(memoryIdSchema.shape).strict(),
};
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type MemoryItem = Omit<MemoryInput, "reason"> & { id: string; projectId: string; revision: number; createdAt: number; updatedAt: number; deletedAt: number | null };
export type MemoryActor = { kind: "user" | "session"; sessionId?: string; runId?: string };
export type MemoryRevision = { id: string; memoryId: string; projectId: string; revision: number; action: "add" | "update" | "remove" | "undo" | "restore"; reason: string; actor: MemoryActor; before: MemoryItem | null; after: MemoryItem; createdAt: number };
export type ProjectRunContext = { runId: string; projectId: string; sessionId: string; instructionsRevision: number; memories: Array<{ id: string; revision: number }>; createdAt: number };
