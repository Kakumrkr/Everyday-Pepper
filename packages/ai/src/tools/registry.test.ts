import { LlmToolDefinitionSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { DESCRIPTION_MAX, guideProblems } from './guide.js';
import { findTool, toolDefinitions, TOOLS } from './registry.js';

// The registry without a database: names, strict schemas, descriptions as prompts, and the
// arguments the model must never be able to pass (playbook S24 pitfalls).

const SMUGGLED = ['tenantId', 'userId', 'staffId', 'role', 'override', 'actor', 'via'];

/** Arguments that fit each tool's schema, for the tests that add fields to them. */
const VALID: Record<string, Record<string, unknown>> = {
  find_availability: {
    serviceId: '0199f4b2-7c1e-7a00-8000-0000000000a1',
    staffMemberId: null,
    date: '2026-11-03',
    days: null,
    notBefore: null,
  },
  find_clients: { name: 'Maria' },
  get_day: { date: '2026-11-03', staffMemberId: null },
  get_booking: { bookingId: '0199f4b2-7c1e-7a00-8000-0000000000b1' },
  list_services_and_staff: {},
  create_booking: {
    clientId: '0199f4b2-7c1e-7a00-8000-0000000000c1',
    serviceId: '0199f4b2-7c1e-7a00-8000-0000000000a1',
    staffMemberId: null,
    date: '2026-11-03',
    time: '10:00',
    emailClient: null,
  },
  move_booking: {
    bookingId: '0199f4b2-7c1e-7a00-8000-0000000000b1',
    date: '2026-11-03',
    time: '11:00',
    staffMemberId: null,
    emailClient: false,
  },
  cancel_booking: { bookingId: '0199f4b2-7c1e-7a00-8000-0000000000b1', emailClient: true },
  block_time: { staffMemberId: null, date: '2026-11-03', from: '12:00', to: '13:00' },
  add_todo: {
    title: 'Call Maria about Friday',
    dueDate: null,
    dueTime: null,
    assigneeStaffMemberId: null,
  },
};

describe('the tool registry', () => {
  it('has the ten V1 tools, named verb_noun, reads first', () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      'find_availability',
      'find_clients',
      'get_day',
      'get_booking',
      'list_services_and_staff',
      'create_booking',
      'move_booking',
      'cancel_booking',
      'block_time',
      'add_todo',
    ]);
    for (const tool of TOOLS) expect(tool.name).toMatch(/^[a-z]+(?:_[a-z]+)+$/);
    expect(TOOLS.filter((tool) => tool.kind === 'write').map((tool) => tool.tier)).toEqual(
      Array(5).fill('internal_write'),
    );
  });

  it('gives the provider strict definitions within its limits', () => {
    for (const definition of toolDefinitions()) {
      expect(LlmToolDefinitionSchema.parse(definition)).toEqual(definition);
      expect(definition.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
      expect(definition.parameters['additionalProperties']).toBe(false);
    }
  });

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s: its description is a complete prompt',
    (_name, tool) => {
      const argNames = Object.keys(VALID[tool.name] ?? {});
      expect(guideProblems(tool.guide, { localTimes: tool.localTimes, argNames })).toEqual([]);
      const properties = toolDefinitions().find((d) => d.name === tool.name)?.parameters[
        'properties'
      ] as Record<string, { description?: string }>;
      // Every argument says what it means, and times say whose clock.
      for (const [name, property] of Object.entries(properties)) {
        expect(property.description, name).toBeTruthy();
      }
      const text = JSON.stringify(properties);
      if (/HH:MM|YYYY-MM-DD/.test(text)) expect(tool.localTimes).toBe(true);
    },
  );

  it.each(TOOLS.map((tool) => [tool.name, tool] as const))(
    '%s: takes valid arguments and refuses the business, the member or an override',
    (_name, tool) => {
      const valid = VALID[tool.name];
      expect(tool.args.safeParse(valid).success).toBe(true);
      for (const field of SMUGGLED) {
        expect(tool.args.safeParse({ ...valid, [field]: 'x' }).success, field).toBe(false);
      }
    },
  );

  it('refuses contacts where a name or a to-do goes', () => {
    const clients = findTool('find_clients');
    expect(clients?.args.safeParse({ name: 'maria@example.test' }).success).toBe(false);
    expect(clients?.args.safeParse({ name: '+1 555 123 4567' }).success).toBe(false);
    const todo = findTool('add_todo');
    expect(
      todo?.args.safeParse({ ...VALID['add_todo'], title: 'Call Maria on 555-123-4567' }).success,
    ).toBe(false);
  });

  it('takes only local dates and 24-hour times', () => {
    const create = findTool('create_booking');
    for (const time of ['2pm', '25:00', '14:30:00', '2026-11-03T10:00:00Z']) {
      expect(create?.args.safeParse({ ...VALID['create_booking'], time }).success, time).toBe(
        false,
      );
    }
    expect(
      create?.args.safeParse({ ...VALID['create_booking'], date: 'next Friday' }).success,
    ).toBe(false);
  });
});
