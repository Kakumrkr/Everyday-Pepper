import {
  ruleDefaultsOf,
  TemplateIdSchema,
  TemplateSchema,
  type RuleDefaults,
  type Template,
  type TemplateId,
  type TemplateInput,
  type TemplateSummary,
} from '@floty/contracts';
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

/** What onboarding shows to pick a business type (`GET /v1/templates`). */
export function templateSummaries(): TemplateSummary[] {
  return listTemplates().map(({ id, name, group, terminology }) => ({
    id,
    name,
    group,
    terminology,
  }));
}

/**
 * The template's booking rule defaults for the availability engine (ADR-0016's "template"
 * step); none without a template, so the platform defaults apply.
 */
export function templateRuleDefaults(id: TemplateId | null): Partial<RuleDefaults> {
  return id === null ? {} : ruleDefaultsOf(getTemplate(id).defaultRules);
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
