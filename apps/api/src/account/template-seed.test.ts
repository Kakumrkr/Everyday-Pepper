import { ServiceInputSchema, UserIdSchema, WeeklyHoursSchema } from '@pepper/contracts';
import { getTemplate, listTemplates } from '@pepper/templates';
import { describe, expect, it } from 'vitest';
import { OWNER_FALLBACK_NAME, seedFromTemplate } from './template-seed.js';

const userId = UserIdSchema.parse('0190a8c4-7b4e-7c2a-9f1e-3d5b6a7c8d9e');

describe('seedFromTemplate (S45, AC-W1-7)', () => {
  it('takes the whole barbershop menu, the owner and the hours', () => {
    const template = getTemplate('barber');
    const seed = seedFromTemplate(template, { userId, name: 'Marcus Reed' });
    expect(seed.services.map((s) => s.service.name)).toEqual(
      template.serviceCatalog.map((s) => s.name),
    );
    expect(seed.services[0]).toEqual({
      service: {
        name: 'Haircut',
        category: 'Cuts',
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 5,
        priceFromCents: 3000,
        priceToCents: 4500,
      },
      rebookAfterDays: 21,
    });
    expect(seed.owner).toEqual({ userId, displayName: 'Marcus Reed' });
    expect(seed.hours).toEqual(template.defaultHours);
  });

  it.each(listTemplates().map((t) => [t.id, t] as const))(
    'gives %s services and hours the domain accepts',
    (_id, template) => {
      const seed = seedFromTemplate(template, { userId, name: 'Ana' });
      for (const { service } of seed.services) {
        expect(ServiceInputSchema.safeParse(service).success).toBe(true);
      }
      expect(WeeklyHoursSchema.safeParse(seed.hours).success).toBe(true);
    },
  );

  it('makes a range whose "to" equals its "from" one price', () => {
    const template = getTemplate('barber');
    const [first] = template.serviceCatalog;
    if (first === undefined) throw new Error('The barbershop has a menu');
    const flat = {
      ...template,
      serviceCatalog: [{ ...first, priceToCents: first.priceFromCents }],
    };
    const [service] = seedFromTemplate(flat, { userId, name: 'Ana' }).services;
    expect(service?.service.priceToCents).toBeNull();
    expect(service?.service.priceFromCents).toBe(first.priceFromCents);
  });

  it('names the staff entry "Owner" when the account has no usable name, and cuts long ones', () => {
    const template = getTemplate('nails');
    expect(seedFromTemplate(template, { userId, name: '   ' }).owner.displayName).toBe(
      OWNER_FALLBACK_NAME,
    );
    const long = seedFromTemplate(template, { userId, name: 'A'.repeat(200) }).owner.displayName;
    expect(long).toHaveLength(80);
    const emoji = seedFromTemplate(template, { userId, name: `${'A'.repeat(79)}💈` }).owner;
    expect(emoji.displayName).toBe('A'.repeat(79));
  });
});
