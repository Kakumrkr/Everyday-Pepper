import type { TemplateInput } from '@pepper/contracts';

/** Private yoga and Pilates: one-to-one or duet sessions, often weekly at a fixed time. */
export const yogaPilatesPrivate: TemplateInput = {
  id: 'yoga-pilates-private',
  version: 1,
  name: 'Private yoga & Pilates',
  group: 'wellness_fitness',
  terminology: {
    client: { singular: 'client', plural: 'clients' },
    staff: { singular: 'instructor', plural: 'instructors' },
    service: { singular: 'session type', plural: 'session types' },
    booking: { singular: 'session', plural: 'sessions' },
  },
  modules: ['appointments'],
  serviceCatalog: [
    {
      name: 'Intro session',
      category: 'Getting started',
      durationMinutes: 60,
      bufferAfterMinutes: 15,
      priceFromCents: 6000,
    },
    {
      name: 'Private yoga, 60 minutes',
      category: 'Yoga',
      durationMinutes: 60,
      bufferAfterMinutes: 15,
      priceFromCents: 9000,
      priceToCents: 12000,
      rebookAfterDays: 7,
    },
    {
      name: 'Private yoga, 90 minutes',
      category: 'Yoga',
      durationMinutes: 90,
      bufferAfterMinutes: 15,
      priceFromCents: 12500,
      priceToCents: 16000,
      rebookAfterDays: 7,
    },
    {
      name: 'Private Pilates reformer, 55 minutes',
      category: 'Pilates',
      durationMinutes: 55,
      bufferAfterMinutes: 10,
      priceFromCents: 9500,
      priceToCents: 12500,
      rebookAfterDays: 7,
    },
    {
      name: 'Duet Pilates reformer, 55 minutes',
      category: 'Pilates',
      durationMinutes: 55,
      bufferAfterMinutes: 10,
      priceFromCents: 13000,
      priceToCents: 16000,
      rebookAfterDays: 7,
    },
    {
      name: 'Private mat Pilates, 55 minutes',
      category: 'Pilates',
      durationMinutes: 55,
      bufferAfterMinutes: 10,
      priceFromCents: 8000,
      priceToCents: 11000,
      rebookAfterDays: 7,
    },
  ],
  defaultRules: { slotIntervalMinutes: 30, minimumNoticeMinutes: 720, maximumAdvanceDays: 60 },
  defaultAutonomy: {},
  intakeFields: [
    { key: 'goals', label: 'Goals', type: 'long_text' },
    {
      key: 'experience',
      label: 'Experience',
      type: 'select',
      options: ['New', 'Some experience', 'Regular practice'],
    },
    { key: 'injuries', label: 'Injuries or limitations', type: 'long_text', sensitive: true },
    { key: 'pregnant', label: 'Pregnant', type: 'boolean', sensitive: true },
  ],
  drafts: {
    voice:
      'Calm, warm and encouraging, like an instructor checking in; never about health or the body.',
    morningHour: 7,
  },
  insights: {
    enabled: [
      'rebooking_due',
      'schedule_gaps',
      'no_show_pattern',
      'waitlist_match',
      'staff_overload',
    ],
    rebookingIntervalDays: 7,
    minGapMinutes: 60,
  },
  promptFragments: [
    'Clients usually come weekly at the same time; offer the same slot next week first.',
    'A duet session is one booking for two clients who train together.',
    'Never give medical advice; note injuries and pregnancy on the client profile for the instructor.',
  ],
  memory: {
    warnings: [
      { serviceCategories: ['Yoga', 'Pilates', 'Getting started'], keys: ['injury', 'pregnancy'] },
    ],
    visitNoteKeys: ['focus', 'modifications'],
  },
  onboardingHints: {
    lookFor: [
      'private session prices and packages',
      'instructor names and certifications',
      'availability',
      'cancellation policy',
    ],
    serviceKeywords: [
      'private yoga',
      'reformer',
      'mat pilates',
      'duet',
      'intro session',
      'package',
    ],
  },
};
