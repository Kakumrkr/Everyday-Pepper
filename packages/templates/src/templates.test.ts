import {
  AUTONOMY_ACTIONS,
  PLATFORM_DRAFTS,
  PLATFORM_RULE_DEFAULTS,
  PLATFORM_WAITLIST,
  RULE_LIMITS,
  SENSITIVE_MEMORY_KEYS,
  TemplateIdSchema,
  TemplateSchema,
  TemplateSummarySchema,
  type Template,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  getTemplate,
  listTemplates,
  PLATFORM_INSIGHTS,
  templateDrafts,
  templateInsights,
  templateRuleDefaults,
  templateSummaries,
  templateWaitlist,
} from './templates.js';

// The schema validation test every template needs (modules-and-templates.md): each V1 template
// parses with the contracts' schema and its content makes sense for a real business.

const templates = listTemplates();

describe('listTemplates', () => {
  it('has one template per id, in the schema order', () => {
    expect(templates.map((t) => t.id)).toEqual(TemplateIdSchema.options);
  });

  it('groups five beauty and three wellness & fitness templates (v1-scope.md)', () => {
    const groups = templates.map((t) => t.group);
    expect(groups.filter((g) => g === 'beauty')).toHaveLength(5);
    expect(groups.filter((g) => g === 'wellness_fitness')).toHaveLength(3);
  });

  it('has unique names', () => {
    expect(new Set(templates.map((t) => t.name)).size).toBe(templates.length);
  });
});

describe.each(templates.map((t) => [t.id, t] as const))('template %s', (_id, template) => {
  it('passes the template schema unchanged', () => {
    expect(TemplateSchema.parse(template)).toEqual(template);
  });

  it('opens on at least four days a week, between 6 a.m. and 9 p.m. (S45)', () => {
    const { intervals } = template.defaultHours;
    expect(new Set(intervals.map((i) => i.weekday)).size).toBeGreaterThanOrEqual(4);
    for (const interval of intervals) {
      expect(interval.start >= '06:00' && interval.end <= '21:00').toBe(true);
    }
  });

  it('fits its longest service into its shortest day (bookable on day one)', () => {
    const minutes = (time: string): number => {
      const [h = 0, m = 0] = time.split(':').map(Number);
      return h * 60 + m;
    };
    const shortestDay = Math.min(
      ...template.defaultHours.intervals.map((i) => minutes(i.end) - minutes(i.start)),
    );
    const longest = Math.max(
      ...template.serviceCatalog.map(
        (s) => s.bufferBeforeMinutes + s.durationMinutes + s.bufferAfterMinutes,
      ),
    );
    expect(longest).toBeLessThanOrEqual(shortestDay);
  });

  it('turns on the appointments module', () => {
    expect(template.modules).toContain('appointments');
  });

  it('has singular and plural words that differ', () => {
    for (const term of Object.values(template.terminology)) {
      expect(term.plural).not.toBe(term.singular);
    }
  });

  it('sets every booking rule default, within the stored rules’ limits', () => {
    const rules = template.defaultRules;
    expect(RULE_LIMITS.slotIntervalMinutes).toContain(rules.slotIntervalMinutes);
    expect(rules.minimumNoticeMinutes).toBeGreaterThanOrEqual(0);
    expect(rules.minimumNoticeMinutes).toBeLessThanOrEqual(RULE_LIMITS.maxMinimumNoticeMinutes);
    expect(rules.maximumAdvanceDays).toBeGreaterThanOrEqual(1);
    expect(rules.maximumAdvanceDays).toBeLessThanOrEqual(RULE_LIMITS.maxAdvanceDays);
    // No template caps bookings per day: that is each business's own choice.
    expect(rules.maxBookingsPerDay).toBeUndefined();
  });

  it('has services whose durations fit its slot grid', () => {
    // Off-grid durations still book, but leave odd gaps; a template should not cause them.
    const grid =
      template.defaultRules.slotIntervalMinutes ?? PLATFORM_RULE_DEFAULTS.slotIntervalMinutes;
    for (const service of template.serviceCatalog) {
      const occupied =
        service.bufferBeforeMinutes + service.durationMinutes + service.bufferAfterMinutes;
      expect(occupied % 5, service.name).toBe(0);
      expect(service.durationMinutes, service.name).toBeGreaterThanOrEqual(grid >= 30 ? 20 : 15);
    }
  });

  it('has realistic US prices (whole dollars, at most $500)', () => {
    for (const service of template.serviceCatalog) {
      expect(service.priceFromCents % 100, service.name).toBe(0);
      expect(service.priceToCents ?? service.priceFromCents, service.name).toBeLessThanOrEqual(
        50_000,
      );
    }
  });

  it('has at least one repeat service, so rebooking insights have something to work with', () => {
    expect(template.serviceCatalog.some((s) => s.rebookAfterDays !== null)).toBe(true);
  });

  it('marks health-related intake fields as sensitive', () => {
    const health = /allerg|health|medic|pregnan|injur|sensitiv|avoid/i;
    for (const field of template.intakeFields) {
      if (health.test(field.key)) expect(field.sensitive, field.key).toBe(true);
    }
  });

  it('only sets autonomy levels the action allows', () => {
    for (const [action, level] of Object.entries(template.defaultAutonomy)) {
      const { allowsAuto } = AUTONOMY_ACTIONS[action as keyof typeof AUTONOMY_ACTIONS];
      expect(level !== 'auto' || allowsAuto, action).toBe(true);
    }
  });

  it('warns about sensitive facts on services it has (S30, AC-W3-2)', () => {
    const categories = new Set(template.serviceCatalog.map((s) => s.category?.toLowerCase()));
    expect(template.memory.warnings.length).toBeGreaterThan(0);
    for (const rule of template.memory.warnings) {
      for (const category of rule.serviceCategories) {
        expect(categories.has(category.toLowerCase()), category).toBe(true);
      }
      for (const key of rule.keys) expect(SENSITIVE_MEMORY_KEYS, key).toContain(key);
    }
  });

  it('suggests visit-note keys that are not sensitive by default', () => {
    expect(template.memory.visitNoteKeys.length).toBeGreaterThan(0);
    for (const key of template.memory.visitNoteKeys) {
      expect(SENSITIVE_MEMORY_KEYS).not.toContain(key);
    }
  });

  it('has prompt fragments without placeholders or client data', () => {
    for (const fragment of template.promptFragments) {
      expect(fragment).not.toMatch(/[{}<>]|@|\d{3}[-. ]\d{3}[-. ]\d{4}/);
    }
  });

  it('is read-only', () => {
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.serviceCatalog[0])).toBe(true);
    expect(() => {
      (template as { name: string }).name = 'Changed';
    }).toThrow(TypeError);
  });
});

describe('getTemplate', () => {
  it('returns the template with that id', () => {
    expect(getTemplate('barber')).toMatchObject({ id: 'barber', name: 'Barbershop' });
  });

  it('refuses an unknown id', () => {
    expect(() => getTemplate('florist' as Template['id'])).toThrow();
  });
});

describe('templateSummaries', () => {
  it('describes every template for onboarding, without the rest of the template', () => {
    const summaries = templateSummaries();
    expect([...summaries.map((s) => s.id)].sort()).toEqual([...TemplateIdSchema.options].sort());
    for (const summary of summaries) {
      expect(TemplateSummarySchema.strict().parse(summary)).toEqual(summary);
      expect(summary.serviceCount).toBe(getTemplate(summary.id).serviceCatalog.length);
    }
    expect(summaries[0]?.terminology.staff).toEqual({ singular: 'stylist', plural: 'stylists' });
  });

  it('lists the four V1 segment types first (S45, AC-W1-8), then the rest', () => {
    const summaries = templateSummaries();
    expect(summaries.slice(0, 4).map((s) => s.id)).toEqual([
      'beauty-salon',
      'barber',
      'nails',
      'lash-brow',
    ]);
    expect(summaries.map((s) => s.featured)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('templateRuleDefaults', () => {
  it('has no defaults without a template', () => {
    expect(templateRuleDefaults(null)).toEqual({});
  });

  it('returns the template’s rule defaults', () => {
    expect(templateRuleDefaults('personal-trainer')).toEqual({
      slotIntervalMinutes: 30,
      minimumNoticeMinutes: 720,
      maximumAdvanceDays: 60,
    });
  });
});

describe('templateInsights', () => {
  it('turns every rule-based insight on without a template', () => {
    expect(templateInsights(null)).toBe(PLATFORM_INSIGHTS);
    expect(PLATFORM_INSIGHTS.enabled).toEqual([
      'rebooking_due',
      'schedule_gaps',
      'no_show_pattern',
      'staff_overload',
    ]);
  });

  it("returns the template's insights, with staff overload on in every template (S35)", () => {
    expect(templateInsights('spa')).toMatchObject({ minGapMinutes: 60 });
    for (const template of listTemplates()) {
      expect(templateInsights(template.id).enabled, template.id).toContain('staff_overload');
    }
  });
});

describe('templateDrafts (S36)', () => {
  it("falls back to the platform's voice and hour without a template, else the template's", () => {
    expect(templateDrafts(null)).toBe(PLATFORM_DRAFTS);
    for (const template of listTemplates()) {
      expect(templateDrafts(template.id), template.id).toBe(template.drafts);
      expect(template.drafts.voice.length, template.id).toBeGreaterThan(0);
    }
  });
});

describe('templateWaitlist (S37)', () => {
  it('offers to the top 3 without a template, else as the template says (1-5)', () => {
    expect(templateWaitlist(null)).toBe(PLATFORM_WAITLIST);
    expect(PLATFORM_WAITLIST.offerFanOut).toBe(3);
    for (const template of listTemplates()) {
      expect(templateWaitlist(template.id), template.id).toBe(template.waitlist);
      expect(template.waitlist.offerFanOut, template.id).toBeGreaterThanOrEqual(1);
      expect(template.waitlist.offerFanOut, template.id).toBeLessThanOrEqual(5);
    }
  });
});
