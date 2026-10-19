import { describe, expect, it } from 'vitest';
import { SERVICE_LIMITS } from './appointments.js';
import { RULE_LIMITS } from './rules.js';
import {
  CatalogServiceSchema,
  IntakeFieldSchema,
  TemplateRuleDefaultsSchema,
  ruleDefaultsOf,
  TEMPLATE_LIMITS,
  TemplateInsightsSchema,
  TemplateSchema,
  TemplateSummarySchema,
  TerminologySchema,
  type TemplateInput,
} from './templates.js';
import { TemplateIdSchema } from './tenancy.js';

const term = (singular: string, plural = `${singular}s`) => ({ singular, plural });

function template(overrides: Partial<TemplateInput> = {}): TemplateInput {
  return {
    id: 'barber',
    version: 1,
    name: 'Barbershop',
    group: 'beauty',
    terminology: {
      client: term('client'),
      staff: term('barber'),
      service: term('service'),
      booking: term('appointment'),
    },
    modules: ['appointments'],
    serviceCatalog: [
      { name: 'Haircut', durationMinutes: 30, priceFromCents: 3000, rebookAfterDays: 21 },
    ],
    defaultRules: { slotIntervalMinutes: 15 },
    defaultAutonomy: {},
    intakeFields: [{ key: 'notes', label: 'Notes', type: 'long_text' }],
    insights: { enabled: ['rebooking_due'], rebookingIntervalDays: 21, minGapMinutes: 30 },
    promptFragments: ['Most cuts take 30 minutes.'],
    onboardingHints: { lookFor: ['price list'], serviceKeywords: ['fade'] },
    ...overrides,
  };
}

describe('TemplateIdSchema', () => {
  it('lists the eight V1 templates', () => {
    expect(TemplateIdSchema.options).toEqual([
      'beauty-salon',
      'barber',
      'nails',
      'spa',
      'lash-brow',
      'personal-trainer',
      'massage',
      'yoga-pilates-private',
    ]);
  });

  it.each(['Barber', 'salon', '', null])('rejects %s', (value) => {
    expect(TemplateIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('TemplateSchema', () => {
  it('accepts a template and fills the defaults', () => {
    const parsed = TemplateSchema.parse(template());
    expect(parsed.serviceCatalog[0]).toEqual({
      name: 'Haircut',
      category: null,
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 3000,
      priceToCents: null,
      rebookAfterDays: 21,
    });
    expect(parsed.intakeFields[0]).toMatchObject({ sensitive: false });
  });

  it('rejects unknown keys', () => {
    expect(TemplateSchema.safeParse({ ...template(), extra: true }).success).toBe(false);
  });

  it('rejects another schema version', () => {
    expect(TemplateSchema.safeParse({ ...template(), version: 2 }).success).toBe(false);
  });

  it('needs at least one module and one catalog service', () => {
    expect(TemplateSchema.safeParse(template({ modules: [] })).success).toBe(false);
    expect(TemplateSchema.safeParse(template({ serviceCatalog: [] })).success).toBe(false);
  });

  it('rejects a module twice', () => {
    const modules: TemplateInput['modules'] = ['appointments', 'appointments'];
    expect(TemplateSchema.safeParse(template({ modules })).success).toBe(false);
  });

  it('rejects service names that differ only in case', () => {
    const serviceCatalog = [
      { name: 'Haircut', durationMinutes: 30, priceFromCents: 3000 },
      { name: 'haircut', durationMinutes: 45, priceFromCents: 4000 },
    ];
    expect(TemplateSchema.safeParse(template({ serviceCatalog })).success).toBe(false);
  });

  it(`allows at most ${String(TEMPLATE_LIMITS.maxCatalogServices)} catalog services`, () => {
    const services = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `Service ${String(i)}`,
        durationMinutes: 30,
        priceFromCents: 1000,
      }));
    const max = TEMPLATE_LIMITS.maxCatalogServices;
    expect(TemplateSchema.safeParse(template({ serviceCatalog: services(max) })).success).toBe(
      true,
    );
    expect(TemplateSchema.safeParse(template({ serviceCatalog: services(max + 1) })).success).toBe(
      false,
    );
  });

  it('rejects duplicate intake field keys', () => {
    const intakeFields = [
      { key: 'notes', label: 'Notes', type: 'text' as const },
      { key: 'notes', label: 'More notes', type: 'long_text' as const },
    ];
    expect(TemplateSchema.safeParse(template({ intakeFields })).success).toBe(false);
  });

  it('rejects "just do it" for bulk messages', () => {
    expect(
      TemplateSchema.safeParse(template({ defaultAutonomy: { 'message.bulk': 'auto' } })).success,
    ).toBe(false);
    expect(
      TemplateSchema.safeParse(template({ defaultAutonomy: { 'message.bulk': 'notify' } })).success,
    ).toBe(true);
  });

  it('rejects an unknown autonomy action', () => {
    const defaultAutonomy = { 'booking.delete': 'ask' } as TemplateInput['defaultAutonomy'];
    expect(TemplateSchema.safeParse(template({ defaultAutonomy })).success).toBe(false);
  });

  it('rejects an over-long prompt fragment and too many fragments', () => {
    const long = 'x'.repeat(TEMPLATE_LIMITS.maxPromptFragmentLength + 1);
    expect(TemplateSchema.safeParse(template({ promptFragments: [long] })).success).toBe(false);
    const many = Array.from({ length: TEMPLATE_LIMITS.maxPromptFragments + 1 }, () => 'hint');
    expect(TemplateSchema.safeParse(template({ promptFragments: many })).success).toBe(false);
  });

  it('needs onboarding hints', () => {
    const onboardingHints = { lookFor: [], serviceKeywords: ['fade'] };
    expect(TemplateSchema.safeParse(template({ onboardingHints })).success).toBe(false);
  });
});

describe('TerminologySchema', () => {
  const terminology = {
    client: term('client'),
    staff: term('stylist'),
    service: term('service'),
    booking: term('appointment'),
  };

  it('accepts lowercase terms', () => {
    expect(TerminologySchema.parse(terminology)).toEqual(terminology);
  });

  it('rejects capitalised terms', () => {
    expect(TerminologySchema.safeParse({ ...terminology, staff: term('Stylist') }).success).toBe(
      false,
    );
  });

  it('rejects a missing or empty term', () => {
    const withoutBooking = {
      client: terminology.client,
      staff: terminology.staff,
      service: terminology.service,
    };
    expect(TerminologySchema.safeParse(withoutBooking).success).toBe(false);
    expect(TerminologySchema.safeParse({ ...terminology, client: term('', '') }).success).toBe(
      false,
    );
  });
});

describe('CatalogServiceSchema', () => {
  const service = { name: 'Color', durationMinutes: 90, priceFromCents: 9000 };

  it('uses the service limits', () => {
    expect(
      CatalogServiceSchema.safeParse({
        ...service,
        durationMinutes: SERVICE_LIMITS.maxDurationMinutes + 1,
      }).success,
    ).toBe(false);
    expect(
      CatalogServiceSchema.safeParse({
        ...service,
        bufferAfterMinutes: SERVICE_LIMITS.maxBufferMinutes + 1,
      }).success,
    ).toBe(false);
    expect(CatalogServiceSchema.safeParse({ ...service, priceFromCents: 10.5 }).success).toBe(
      false,
    );
  });

  it('rejects a "to" price below the "from" price', () => {
    expect(CatalogServiceSchema.safeParse({ ...service, priceToCents: 8999 }).success).toBe(false);
    expect(CatalogServiceSchema.safeParse({ ...service, priceToCents: 9000 }).success).toBe(true);
  });

  it.each([TEMPLATE_LIMITS.minRebookingDays - 1, TEMPLATE_LIMITS.maxRebookingDays + 1])(
    'rejects rebooking after %i days',
    (rebookAfterDays) => {
      expect(CatalogServiceSchema.safeParse({ ...service, rebookAfterDays }).success).toBe(false);
    },
  );
});

describe('TemplateRuleDefaultsSchema', () => {
  it('accepts no defaults', () => {
    expect(TemplateRuleDefaultsSchema.parse({})).toEqual({});
  });

  it('uses the stored rules’ ranges', () => {
    expect(TemplateRuleDefaultsSchema.safeParse({ slotIntervalMinutes: 45 }).success).toBe(false);
    expect(
      TemplateRuleDefaultsSchema.safeParse({ maximumAdvanceDays: RULE_LIMITS.maxAdvanceDays + 1 })
        .success,
    ).toBe(false);
    expect(TemplateRuleDefaultsSchema.safeParse({ maxBookingsPerDay: 0 }).success).toBe(false);
    expect(TemplateRuleDefaultsSchema.safeParse({ maxBookingsPerDay: null }).success).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(TemplateRuleDefaultsSchema.safeParse({ bufferMinutes: 10 }).success).toBe(false);
  });
});

describe('ruleDefaultsOf', () => {
  it('keeps only the values a template sets', () => {
    expect(ruleDefaultsOf({})).toEqual({});
    expect(
      ruleDefaultsOf({
        slotIntervalMinutes: 30,
        minimumNoticeMinutes: 0,
        maximumAdvanceDays: 60,
        maxBookingsPerDay: null,
      }),
    ).toEqual({
      slotIntervalMinutes: 30,
      minimumNoticeMinutes: 0,
      maximumAdvanceDays: 60,
      maxBookingsPerDay: null,
    });
    expect(Object.keys(ruleDefaultsOf({ maximumAdvanceDays: 30 }))).toEqual(['maximumAdvanceDays']);
  });
});

describe('IntakeFieldSchema', () => {
  it('needs options exactly for select fields', () => {
    expect(
      IntakeFieldSchema.safeParse({ key: 'pressure', label: 'Pressure', type: 'select' }).success,
    ).toBe(false);
    expect(
      IntakeFieldSchema.safeParse({
        key: 'pressure',
        label: 'Pressure',
        type: 'select',
        options: ['Light', 'Medium', 'Firm'],
      }).success,
    ).toBe(true);
    expect(
      IntakeFieldSchema.safeParse({
        key: 'notes',
        label: 'Notes',
        type: 'text',
        options: ['a', 'b'],
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate options', () => {
    expect(
      IntakeFieldSchema.safeParse({
        key: 'pressure',
        label: 'Pressure',
        type: 'select',
        options: ['Firm', 'Firm'],
      }).success,
    ).toBe(false);
  });

  it.each(['Allergies', 'hair-type', '1st', ''])('rejects the key %j', (key) => {
    expect(IntakeFieldSchema.safeParse({ key, label: 'Label', type: 'text' }).success).toBe(false);
  });
});

describe('TemplateInsightsSchema', () => {
  it('rejects an insight twice', () => {
    expect(
      TemplateInsightsSchema.safeParse({
        enabled: ['schedule_gaps', 'schedule_gaps'],
        rebookingIntervalDays: 28,
        minGapMinutes: 30,
      }).success,
    ).toBe(false);
  });

  it.each([14, 241])('rejects a minimum gap of %i minutes', (minGapMinutes) => {
    expect(
      TemplateInsightsSchema.safeParse({ enabled: [], rebookingIntervalDays: 28, minGapMinutes })
        .success,
    ).toBe(false);
  });
});

describe('TemplateSummarySchema', () => {
  it('describes a template for onboarding', () => {
    const { id, name, group, terminology } = TemplateSchema.parse(template());
    expect(TemplateSummarySchema.parse({ id, name, group, terminology })).toEqual({
      id,
      name,
      group,
      terminology,
    });
  });
});
