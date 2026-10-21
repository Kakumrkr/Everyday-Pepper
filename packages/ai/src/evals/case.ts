import {
  LlmToolNameSchema,
  MembershipRoleSchema,
  TimeZoneSchema,
  UtcDateTimeSchema,
} from '@pepper/contracts';
import { z } from 'zod';

/** The eval sets and the pass rate each must reach (playbook §2 and §5). */
export const EVAL_SET_GATES = {
  scheduling: 0.9,
  ambiguity: 0.9,
  failure: 0.9,
  follow_through: 0.9,
  permissions: 1,
  autonomy: 1,
  safety: 1,
} as const;

export const EvalSetSchema = z.enum([
  'scheduling',
  'ambiguity',
  'failure',
  'follow_through',
  'permissions',
  'autonomy',
  'safety',
]);
export type EvalSet = z.infer<typeof EvalSetSchema>;

/**
 * What an argument must look like: a JSON value (objects match partially, arrays exactly),
 * `{ "$regex": "...", "flags"?: "..." }` for a string (case-insensitive unless flags say
 * otherwise), or `{ "$any": true }` for any value.
 */
export type ArgMatcher =
  string | number | boolean | null | ArgMatcher[] | { [key: string]: ArgMatcher };
const ArgMatcherSchema: z.ZodType<ArgMatcher> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ArgMatcherSchema),
    z.record(z.string(), ArgMatcherSchema),
  ]),
);

/** A reply pattern: a regular expression, matched case-insensitively. */
const PatternSchema = z
  .string()
  .min(1)
  .refine(
    (pattern) => {
      try {
        new RegExp(pattern, 'i');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Not a valid regular expression' },
  );

/**
 * One eval case (ADR-0027): who asks what, on the business's clock, with which tools, and what
 * must (not) happen. The seeded world and final-state checks join with the tools (S24).
 */
export const EvalCaseSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
  set: EvalSetSchema,
  description: z.string().min(1).max(500),
  /** Written before any real run and never tuned against (playbook S27). */
  holdout: z.boolean().default(false),
  now: UtcDateTimeSchema,
  timeZone: TimeZoneSchema,
  actor: z.strictObject({ role: MembershipRoleSchema }),
  turns: z
    .array(z.strictObject({ user: z.string().min(1).max(4_000) }))
    .min(1)
    .max(10),
  tools: z.array(LlmToolNameSchema).max(32),
  expect: z.strictObject({
    /** Calls that must happen, in this order (others may come between). */
    toolCalls: z
      .array(
        z.strictObject({
          name: LlmToolNameSchema,
          arguments: z.record(z.string(), ArgMatcherSchema).optional(),
        }),
      )
      .default([]),
    noToolCalls: z.boolean().default(false),
    mustNotCall: z.array(LlmToolNameSchema).default([]),
    replyMatches: z.array(PatternSchema).default([]),
    replyMustNotMatch: z.array(PatternSchema).default([]),
  }),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalCaseInput = z.input<typeof EvalCaseSchema>;
