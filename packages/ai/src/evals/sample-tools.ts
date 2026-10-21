import type { LlmToolDefinition } from '@pepper/contracts';
import { z } from 'zod';
import { strictToolParameters } from '../strict-schema.js';

// Stand-in tools for the S22 eval skeleton (ADR-0027). They only describe arguments: nothing
// runs them. The tool registry (S24) replaces them with the real tools and their handlers.

const LocalDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('A date in the business time zone, YYYY-MM-DD, read from the date table');

export const SAMPLE_TOOLS = {
  find_clients: {
    description:
      'Look up the business’s clients by name or part of a name. Use it before any action on a client; never guess who someone is.',
    schema: z.strictObject({
      query: z.string().min(1).max(80).describe('The name as the user said it'),
    }),
  },
  get_day: {
    description: 'The schedule of one day: bookings, staff hours and open time.',
    schema: z.strictObject({ date: LocalDateSchema }),
  },
  create_booking: {
    description:
      'Book a client (by id from find_clients) for a service on a date and time in the business time zone.',
    schema: z.strictObject({
      clientId: z.uuid(),
      serviceName: z.string().min(1).max(80),
      staffName: z.string().min(1).max(80).nullable().describe('null: anyone free'),
      date: LocalDateSchema,
      time: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .describe('Local time, 24-hour HH:MM'),
    }),
  },
  email_clients: {
    description:
      'Email one or more clients (by id). Messages to clients always need the owner’s OK.',
    schema: z.strictObject({
      clientIds: z.array(z.uuid()).min(1).max(500),
      subject: z.string().min(1).max(120),
      body: z.string().min(1).max(4_000),
    }),
  },
} as const satisfies Record<string, { description: string; schema: z.ZodType }>;

export type SampleToolName = keyof typeof SAMPLE_TOOLS;

const isSampleTool = (name: string): name is SampleToolName => name in SAMPLE_TOOLS;

/** The definitions of `names` for a request, and their schemas for grading. */
export function sampleTools(names: readonly string[]): {
  definitions: LlmToolDefinition[];
  schemas: Map<string, z.ZodType>;
} {
  const definitions: LlmToolDefinition[] = [];
  const schemas = new Map<string, z.ZodType>();
  for (const name of names) {
    if (!isSampleTool(name)) throw new Error(`Unknown eval tool ${name}`);
    const tool = SAMPLE_TOOLS[name];
    definitions.push({
      name,
      description: tool.description,
      parameters: strictToolParameters(tool.schema),
    });
    schemas.set(name, tool.schema);
  }
  return { definitions, schemas };
}
