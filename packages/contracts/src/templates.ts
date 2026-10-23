import { z } from 'zod';
import { PriceCentsSchema, SERVICE_LIMITS } from './appointments.js';
import { TemplateMemorySchema } from './memory.js';
import { RuleDefaultsSchema, type RuleDefaults } from './rules.js';
import { TemplateIdSchema } from './tenancy.js';
import { AutonomySettingsSchema } from './trust.js';

// Industry templates (L3, docs/architecture/modules-and-templates.md, ADR-0018): data only, one
// per kind of business, validated by `TemplateSchema`. A template gives a new business its
// words ("client"/"stylist"), a starting service menu, booking rule and autonomy defaults,
// intake fields, insight thresholds, hints for the AI and hints for onboarding. Businesses
// override any of it (L4); the template itself never changes per business.

/** The business types the onboarding groups templates under. */
export const TemplateGroupSchema = z.enum(['beauty', 'wellness_fitness']);
export type TemplateGroup = z.infer<typeof TemplateGroupSchema>;

/** The modules a template turns on; V1 has only appointments. */
export const ModuleIdSchema = z.enum(['appointments']);
export type ModuleId = z.infer<typeof ModuleIdSchema>;

/** Insights the operator feed can show (Phase 8); a template picks which are on. */
export const InsightTypeSchema = z.enum([
  'rebooking_due',
  'schedule_gaps',
  'no_show_pattern',
  'waitlist_match',
]);
export type InsightType = z.infer<typeof InsightTypeSchema>;

/** Limits shared by the schema and the template tests. */
export const TEMPLATE_LIMITS = {
  maxCatalogServices: 40,
  maxIntakeFields: 20,
  maxSelectOptions: 20,
  maxPromptFragments: 10,
  maxPromptFragmentLength: 500,
  maxHints: 20,
  maxHintLength: 200,
  /** Rebooking intervals: one week to a year. */
  minRebookingDays: 7,
  maxRebookingDays: 365,
} as const;

const Label = z.string().trim().min(1).max(40);

/** A word in the business's own language, e.g. `{ singular: 'stylist', plural: 'stylists' }`. */
export const TermSchema = z.object({ singular: Label, plural: Label }).strict();
export type Term = z.infer<typeof TermSchema>;

/** What the UI and the AI call clients, staff, services and bookings. Lowercase. */
export const TerminologySchema = z
  .object({ client: TermSchema, staff: TermSchema, service: TermSchema, booking: TermSchema })
  .strict()
  .refine((t) => Object.values(t).every((term) => isLowercase(term.singular, term.plural)), {
    message: 'Terms are lowercase; the UI capitalises them where needed',
  });
export type Terminology = z.infer<typeof TerminologySchema>;

const RebookingDaysSchema = z
  .number()
  .int()
  .min(TEMPLATE_LIMITS.minRebookingDays)
  .max(TEMPLATE_LIMITS.maxRebookingDays);

/** A typical service on the template's starting menu; onboarding offers it (Phase 9). */
export const CatalogServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60).nullable().default(null),
    durationMinutes: z
      .number()
      .int()
      .min(SERVICE_LIMITS.minDurationMinutes)
      .max(SERVICE_LIMITS.maxDurationMinutes),
    bufferBeforeMinutes: z.number().int().min(0).max(SERVICE_LIMITS.maxBufferMinutes).default(0),
    bufferAfterMinutes: z.number().int().min(0).max(SERVICE_LIMITS.maxBufferMinutes).default(0),
    /** A typical US price range in cents: "from", and "to" when it varies. */
    priceFromCents: PriceCentsSchema,
    priceToCents: PriceCentsSchema.nullable().default(null),
    /** When a regular is usually due again; `null`: not a repeat service. */
    rebookAfterDays: RebookingDaysSchema.nullable().default(null),
  })
  .strict()
  .refine((s) => s.priceToCents === null || s.priceToCents >= s.priceFromCents, {
    message: 'The "to" price must not be below the "from" price',
    path: ['priceToCents'],
  });
export type CatalogService = z.output<typeof CatalogServiceSchema>;

/**
 * A template's defaults for the single-valued booking rules (ADR-0016); unset values fall back
 * to the platform's. Same ranges as the stored rules.
 */
export const TemplateRuleDefaultsSchema = RuleDefaultsSchema.partial();
export type TemplateRuleDefaults = z.output<typeof TemplateRuleDefaultsSchema>;

/** The values a template sets, without unset keys, to lay over the platform defaults. */
export function ruleDefaultsOf(defaults: TemplateRuleDefaults): Partial<RuleDefaults> {
  const set: Partial<RuleDefaults> = {};
  if (defaults.slotIntervalMinutes !== undefined) {
    set.slotIntervalMinutes = defaults.slotIntervalMinutes;
  }
  if (defaults.minimumNoticeMinutes !== undefined) {
    set.minimumNoticeMinutes = defaults.minimumNoticeMinutes;
  }
  if (defaults.maximumAdvanceDays !== undefined) {
    set.maximumAdvanceDays = defaults.maximumAdvanceDays;
  }
  if (defaults.maxBookingsPerDay !== undefined) set.maxBookingsPerDay = defaults.maxBookingsPerDay;
  return set;
}

/** A field on the client profile, e.g. allergies. `sensitive`: health information. */
export const IntakeFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use snake_case, at most 40 characters'),
    label: z.string().trim().min(1).max(80),
    type: z.enum(['text', 'long_text', 'boolean', 'date', 'select']),
    options: z
      .array(z.string().trim().min(1).max(60))
      .min(2)
      .max(TEMPLATE_LIMITS.maxSelectOptions)
      .optional(),
    sensitive: z.boolean().default(false),
  })
  .strict()
  .refine((f) => (f.type === 'select') === (f.options !== undefined), {
    message: 'Only and every select field has options',
    path: ['options'],
  })
  .refine((f) => f.options === undefined || new Set(f.options).size === f.options.length, {
    message: 'Options are unique',
    path: ['options'],
  });
export type IntakeField = z.output<typeof IntakeFieldSchema>;

/** Which insights are on, and their thresholds. */
export const TemplateInsightsSchema = z
  .object({
    enabled: z.array(InsightTypeSchema).refine(isUnique, 'Each insight once'),
    /** When a regular is due again if their service says nothing. */
    rebookingIntervalDays: RebookingDaysSchema,
    /** The shortest open gap in a day worth suggesting to fill. */
    minGapMinutes: z.number().int().min(15).max(240),
  })
  .strict();
export type TemplateInsights = z.infer<typeof TemplateInsightsSchema>;

const Hint = z.string().trim().min(1).max(TEMPLATE_LIMITS.maxHintLength);

/** What onboarding looks for on a website, price list or photo (Phase 9). */
export const OnboardingHintsSchema = z
  .object({
    lookFor: z.array(Hint).min(1).max(TEMPLATE_LIMITS.maxHints),
    serviceKeywords: z.array(Hint).min(1).max(TEMPLATE_LIMITS.maxHints),
  })
  .strict();
export type OnboardingHints = z.infer<typeof OnboardingHintsSchema>;

/** One industry template. */
export const TemplateSchema = z
  .object({
    id: TemplateIdSchema,
    /** Schema version, so a later version can upgrade templates. */
    version: z.literal(1),
    /** Shown in onboarding, e.g. "Hair salon". */
    name: z.string().trim().min(1).max(60),
    group: TemplateGroupSchema,
    terminology: TerminologySchema,
    modules: z.array(ModuleIdSchema).min(1).refine(isUnique, 'Each module once'),
    serviceCatalog: z
      .array(CatalogServiceSchema)
      .min(1)
      .max(TEMPLATE_LIMITS.maxCatalogServices)
      .refine((services) => isUnique(services.map((s) => s.name.toLowerCase())), {
        message: 'Service names are unique (ignoring case)',
      }),
    defaultRules: TemplateRuleDefaultsSchema,
    defaultAutonomy: AutonomySettingsSchema,
    intakeFields: z
      .array(IntakeFieldSchema)
      .max(TEMPLATE_LIMITS.maxIntakeFields)
      .refine((fields) => isUnique(fields.map((f) => f.key)), {
        message: 'Intake field keys are unique',
      }),
    insights: TemplateInsightsSchema,
    /** Domain hints added to the AI's instructions (Phase 6); never client data. */
    promptFragments: z
      .array(z.string().trim().min(1).max(TEMPLATE_LIMITS.maxPromptFragmentLength))
      .max(TEMPLATE_LIMITS.maxPromptFragments),
    onboardingHints: OnboardingHintsSchema,
    /** What Pepper's memory warns about on a booking, and the visit notes it suggests (S30). */
    memory: TemplateMemorySchema.default({ warnings: [], visitNoteKeys: [] }),
  })
  .strict();
export type Template = z.output<typeof TemplateSchema>;
export type TemplateInput = z.input<typeof TemplateSchema>;

/** `GET /v1/templates`: what onboarding shows to pick a business type. */
export const TemplateSummarySchema = z.object({
  id: TemplateIdSchema,
  name: z.string(),
  group: TemplateGroupSchema,
  terminology: TerminologySchema,
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

export const TemplatesResponseSchema = z.object({ templates: z.array(TemplateSummarySchema) });
export type TemplatesResponse = z.infer<typeof TemplatesResponseSchema>;

function isUnique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

function isLowercase(...values: readonly string[]): boolean {
  return values.every((value) => value === value.toLowerCase());
}
