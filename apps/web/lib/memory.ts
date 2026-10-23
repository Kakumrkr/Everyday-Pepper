import {
  isLearnedRuleKey,
  type MemoryFactView,
  type MemorySubject,
  type Permission,
} from '@pepper/contracts';
import { keyWords } from '@pepper/ui';
import { ROUTES } from './account';

// "What I know" (S32): how the remembered facts are grouped, filtered and described on the
// screens, and who may change which. The api decides every change (ADR-0034); this only hides
// what a role could not do anyway.

export type MemoryFilter = 'all' | 'clients' | 'team' | 'services' | 'business' | 'sensitive';

export const MEMORY_FILTERS: readonly { key: MemoryFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'clients', label: 'Clients' },
  { key: 'team', label: 'Team' },
  { key: 'services', label: 'Services' },
  { key: 'business', label: 'Business' },
  { key: 'sensitive', label: 'Sensitive' },
];

export type MemoryGroupKey = 'rules' | 'clients' | 'team' | 'services' | 'business';

export const MEMORY_GROUP_TITLE: Record<MemoryGroupKey, string> = {
  rules: 'Rules I learned',
  clients: 'About clients',
  team: 'About the team',
  services: 'About services',
  business: 'About the business',
};

const GROUP_ORDER: readonly MemoryGroupKey[] = ['rules', 'clients', 'team', 'services', 'business'];

/** The group a fact is listed under: learned rules apart, visit notes with their client. */
export function groupOf(fact: Pick<MemoryFactView, 'key' | 'subject'>): MemoryGroupKey {
  if (isLearnedRuleKey(fact.key)) return 'rules';
  switch (fact.subject.type) {
    case 'client':
    case 'booking':
      return 'clients';
    case 'staff':
      return 'team';
    case 'service':
      return 'services';
    case 'business':
      return 'business';
  }
}

export function matchesFilter(fact: MemoryFactView, filter: MemoryFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'sensitive':
      return fact.sensitive;
    case 'clients':
      return fact.subject.type === 'client' || fact.subject.type === 'booking';
    case 'team':
      return fact.subject.type === 'staff';
    case 'services':
      return fact.subject.type === 'service';
    case 'business':
      return fact.subject.type === 'business';
  }
}

/** The facts that pass `filter`, grouped in the screen's order (empty groups left out). */
export function groupFacts(
  facts: readonly MemoryFactView[],
  filter: MemoryFilter,
): { key: MemoryGroupKey; title: string; facts: MemoryFactView[] }[] {
  const shown = facts.filter((fact) => matchesFilter(fact, filter));
  return GROUP_ORDER.map((key) => ({
    key,
    title: MEMORY_GROUP_TITLE[key],
    facts: shown.filter((fact) => groupOf(fact) === key),
  })).filter((group) => group.facts.length > 0);
}

/** A fact's name on a screen: "Allergy", or a learned rule's kind. */
export function factLabel(key: string): string {
  if (isLearnedRuleKey(key)) {
    if (key.startsWith('rule_hours_')) return 'Hours';
    if (key.startsWith('rule_blackout_')) return 'Closed days';
    return keyWords(key.slice('rule_'.length)) ?? 'Rule';
  }
  return keyWords(key) ?? 'Fact';
}

const SOURCE_WORDS = {
  chat: { you: 'You told me in chat', other: 'A teammate told me in chat' },
  screen: { you: 'You added it', other: 'A teammate added it' },
  ai_action: {
    you: 'I saved it when you approved a change',
    other: 'Saved with a teammate’s change',
  },
} as const;

/** Where a fact came from and when (playbook M-5): "You told me in chat · Oct 12". */
export function sourceLine(
  fact: Pick<MemoryFactView, 'source' | 'byYou' | 'createdAt'>,
  timeZone: string,
): string {
  const words = SOURCE_WORDS[fact.source][fact.byYou ? 'you' : 'other'];
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(fact.createdAt));
  return `${words} · ${date}`;
}

/** Whom a fact is about, as a line: "Maria Lopez", "Maria Lopez · visit Nov 2, Full color". */
export function aboutLine(fact: MemoryFactView, timeZone: string): string | null {
  if (fact.visit !== null) {
    const date = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'short',
      day: 'numeric',
    }).format(new Date(fact.visit.startsAt));
    const visit = `visit ${date}${fact.visit.serviceName === '' ? '' : `, ${fact.visit.serviceName}`}`;
    return fact.subjectName === null ? visit : `${fact.subjectName} · ${visit}`;
  }
  return fact.subjectName;
}

/** The screen where a learned rule lives, to see or change it. */
export function ruleLink(fact: Pick<MemoryFactView, 'key' | 'subject'>): string | null {
  if (!isLearnedRuleKey(fact.key)) return null;
  return fact.subject.type === 'staff' ? `${ROUTES.team}/${fact.subject.id}` : ROUTES.rules;
}

/** Whether the member may change or forget facts about this subject (ADR-0034). */
export function canChange(subject: MemorySubject, permissions: readonly Permission[]): boolean {
  switch (subject.type) {
    case 'client':
    case 'booking':
      return permissions.includes('client_notes.manage');
    case 'staff':
      return permissions.includes('staff.manage');
    case 'service':
      return permissions.includes('services.manage');
    case 'business':
      return permissions.includes('business.update');
  }
}

/** A name the member typed ("Usual service") as a fact key (`usual_service`); `null` if none. */
export function toFactKey(label: string): string | null {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return key === '' ? null : key;
}

/** Names offered when adding a fact by hand (any other is fine). */
export const SUGGESTED_KEYS = {
  client: ['Allergy', 'Preference', 'Usual service', 'Notes'],
  visit: ['Formula', 'Products', 'Notes'],
} as const;

/** A visit note's visit, on the client's own profile: "Nov 2 · Full color". */
export function visitLine(fact: Pick<MemoryFactView, 'visit'>, timeZone: string): string | null {
  if (fact.visit === null) return null;
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(fact.visit.startsAt));
  return fact.visit.serviceName === '' ? date : `${date} · ${fact.visit.serviceName}`;
}
