import {
  PLATFORM_DRAFTS,
  PLATFORM_REMINDERS,
  PLATFORM_WAITLIST,
  ruleDefaultsOf,
  TemplateIdSchema,
  TemplateSchema,
  type RuleDefaults,
  type Template,
  type TemplateDrafts,
  type TemplateId,
  type TemplateInput,
  type TemplateInsights,
  type TemplateReminders,
  type TemplateSummary,
  type TemplateWaitlist,
} from '@pepper/contracts';
import { barber } from './catalog/barber.js';
import { beautySalon } from './catalog/beauty-salon.js';
import { lashBrow } from './catalog/lash-brow.js';
import { massage } from './catalog/massage.js';
import { nails } from './catalog/nails.js';
import { personalTrainer } from './catalog/personal-trainer.js';
import { spa } from './catalog/spa.js';
import { yogaPilatesPrivate } from './catalog/yoga-pilates-private.js';

// The eight V1 industry templates (L3, ADR-0018). Data only: each is parsed with the contracts'
// `TemplateSchema` when this module loads, so a broken template stops the app at startup (and
// fails the template tests) instead of reaching a business. Templates are read-only.

const SOURCES: Record<TemplateId, TemplateInput> = {
  'beauty-salon': beautySalon,
  barber,
  nails,
  spa,
  'lash-brow': lashBrow,
  'personal-trainer': personalTrainer,
  massage,
  'yoga-pilates-private': yogaPilatesPrivate,
};

const TEMPLATES: ReadonlyMap<TemplateId, Template> = new Map(
  TemplateIdSchema.options.map((id) => [id, deepFreeze(parseTemplate(id, SOURCES[id]))]),
);

/** Every template, in the order onboarding lists them (`TemplateIdSchema`). */
export function listTemplates(): Template[] {
  return [...TEMPLATES.values()];
}

/** One template. */
export function getTemplate(id: TemplateId): Template {
  const template = TEMPLATES.get(TemplateIdSchema.parse(id));
  // Every id has a template: the map is built from TemplateIdSchema's options.
  if (template === undefined) throw new Error(`No template ${id}`);
  return template;
}

/**
 * What onboarding shows to pick a business type (`GET /v1/templates`): the featured types
 * first, each group in the schema's order.
 */
export function templateSummaries(): TemplateSummary[] {
  const templates = listTemplates();
  return [...templates.filter((t) => t.featured), ...templates.filter((t) => !t.featured)].map(
    ({ id, name, group, featured, serviceCatalog, terminology }) => ({
      id,
      name,
      group,
      featured,
      serviceCount: serviceCatalog.length,
      terminology,
    }),
  );
}

/**
 * The template's booking rule defaults for the availability engine (ADR-0016's "template"
 * step); none without a template, so the platform defaults apply.
 */
export function templateRuleDefaults(id: TemplateId | null): Partial<RuleDefaults> {
  return id === null ? {} : ruleDefaultsOf(getTemplate(id).defaultRules);
}

/**
 * Without a template, every rule-based insight is on with an hour as the shortest gap (the
 * platform default, ADR-0039); the waitlist match follows its own feature (S37).
 */
export const PLATFORM_INSIGHTS: TemplateInsights = deepFreeze<TemplateInsights>({
  enabled: ['rebooking_due', 'schedule_gaps', 'no_show_pattern', 'staff_overload'],
  rebookingIntervalDays: 28,
  minGapMinutes: 60,
});

/** The insights a business's template turns on, and their thresholds. */
export function templateInsights(id: TemplateId | null): TemplateInsights {
  return id === null ? PLATFORM_INSIGHTS : getTemplate(id).insights;
}

function parseTemplate(id: TemplateId, source: TemplateInput): Template {
  const template = TemplateSchema.parse(source);
  if (template.id !== id) throw new Error(`Template ${template.id} is listed as ${id}`);
  return template;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The voice of the business's rebooking emails and the morning pass's hour (S36). */
export function templateDrafts(id: TemplateId | null): TemplateDrafts {
  return id === null ? PLATFORM_DRAFTS : getTemplate(id).drafts;
}

/** The confirm cut-off a new business of the type starts with (S78.3, AC-X-217). */
export function templateReminders(id: TemplateId | null): TemplateReminders {
  return id === null ? PLATFORM_REMINDERS : getTemplate(id).reminders;
}

/** How many waiting clients a freed slot is offered to at once (S37, ADR-0041). */
export function templateWaitlist(id: TemplateId | null): TemplateWaitlist {
  return id === null ? PLATFORM_WAITLIST : getTemplate(id).waitlist;
}
