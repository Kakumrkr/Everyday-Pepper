import { z } from 'zod';

// A remembered fact's id and how stored tool answers name one (ADR-0035): apart from
// memory.ts so the chat events can carry the facts an answer used (S32) without an import
// cycle (memory.ts names conversations and turns).

export const MemoryFactIdSchema = z.uuid().toLowerCase().brand<'MemoryFactId'>();
export type MemoryFactId = z.infer<typeof MemoryFactIdSchema>;

const FACT_REF = /"\$fact":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/** The ids of the facts a stored tool answer names by reference, in order, with repeats. */
export function memoryFactRefsIn(content: string): string[] {
  return [...content.matchAll(FACT_REF)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** The most facts one answer is shown with (the "Remembered" chip, S32). */
export const ANSWER_FACTS_MAX = 100;
