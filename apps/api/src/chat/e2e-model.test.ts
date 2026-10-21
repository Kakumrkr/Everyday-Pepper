import { isLlmError } from '@pepper/ai';
import type { LlmMessage, LlmRequest, LlmResponse } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { E2eModel } from './e2e-model.js';

const model = new E2eModel();

function request(messages: LlmMessage[]): LlmRequest {
  return {
    route: 'routine',
    instructions: 'x',
    messages,
    tools: [],
    toolChoice: 'auto',
    maxOutputTokens: 512,
  };
}

const user = (content: string): LlmMessage => ({ role: 'user', content });

/** The model's answer, then the tool results the test gives back for each call. */
function answered(response: LlmResponse, results: Record<string, unknown>): LlmMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: response.toolCalls, replay: [] },
    ...response.toolCalls.map((call): LlmMessage => ({
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify(results[call.name]),
      isError: false,
    })),
  ];
}

const team = {
  status: 'answered',
  data: {
    services: [{ serviceId: 'svc-haircut', name: 'Haircut' }],
    staff: [
      { staffMemberId: 'stf-jess', name: 'Jess' },
      { staffMemberId: 'stf-marco', name: 'Marco' },
    ],
  },
};

describe('E2eModel (the journeys’ scripted model, never in production)', () => {
  it('books: looks the names up, books exactly what was said, then says how it went', async () => {
    const said = user('Book Maria for Haircut with Jess on 2026-10-27 at 10:00');
    const first = await model.respond(request([said]));
    expect(first.toolCalls.map((call) => call.name)).toEqual([
      'find_clients',
      'list_services_and_staff',
    ]);
    const looked = answered(first, {
      find_clients: {
        status: 'answered',
        data: { matches: [{ clientId: 'cli-maria', name: 'Maria L.' }] },
      },
      list_services_and_staff: team,
    });
    const second = await model.respond(request([said, ...looked]));
    expect(second.toolCalls).toHaveLength(1);
    expect(JSON.parse(second.toolCalls[0]?.arguments ?? '')).toEqual({
      clientId: 'cli-maria',
      serviceId: 'svc-haircut',
      staffMemberId: 'stf-jess',
      date: '2026-10-27',
      time: '10:00',
      emailClient: null,
    });
    const taken = answered(second, {
      create_booking: { status: 'refused', code: 'slot_unavailable' },
    });
    expect((await model.respond(request([said, ...looked, ...taken]))).text).toMatch(/taken/);
  });

  it('a time picked on the card books it with the earlier client and service', async () => {
    const asked = user('Book Maria for Haircut with Jess on 2026-10-27 at 10:00');
    const picked = user('Book Tue 2026-10-27 at 10:30 with Marco instead');
    const history: LlmMessage[] = [
      asked,
      { role: 'assistant', content: 'Taken.', toolCalls: [], replay: [] },
      picked,
    ];
    const first = await model.respond(request(history));
    const looked = answered(first, {
      find_clients: {
        status: 'answered',
        data: { matches: [{ clientId: 'cli-maria', name: 'Maria L.' }] },
      },
      list_services_and_staff: team,
    });
    const second = await model.respond(request([...history, ...looked]));
    expect(JSON.parse(second.toolCalls[0]?.arguments ?? '')).toMatchObject({
      staffMemberId: 'stf-marco',
      time: '10:30',
    });
    const waiting = answered(second, { create_booking: { status: 'awaiting_approval' } });
    expect((await model.respond(request([...history, ...looked, ...waiting]))).text).toMatch(
      /Approve/,
    );
  });

  it('adds a to-do, blocks time (and says so when refused), reads a day', async () => {
    const remind = await model.respond(request([user('Remind me to restock towels')]));
    expect(JSON.parse(remind.toolCalls[0]?.arguments ?? '')).toMatchObject({
      title: 'restock towels',
    });
    const block = user('Block 2026-10-27 12:00-13:00 for Marco');
    const looked = answered(await model.respond(request([block])), {
      list_services_and_staff: team,
    });
    const blocking = await model.respond(request([block, ...looked]));
    expect(JSON.parse(blocking.toolCalls[0]?.arguments ?? '')).toEqual({
      staffMemberId: 'stf-marco',
      date: '2026-10-27',
      from: '12:00',
      to: '13:00',
    });
    const refused = answered(blocking, { block_time: { status: 'refused', code: 'forbidden' } });
    expect((await model.respond(request([block, ...looked, ...refused]))).text).toMatch(
      /role doesn’t let me/,
    );
    const day = await model.respond(request([user('What does 2026-10-27 look like?')]));
    expect(day.toolCalls[0]?.name).toBe('get_day');
  });

  it('moves a booking found on the day by the client’s name', async () => {
    const said = user("Move Maria's booking on 2026-10-27 to 15:00");
    const first = await model.respond(request([said]));
    expect(first.toolCalls[0]?.name).toBe('get_day');
    const read = answered(first, {
      get_day: {
        status: 'answered',
        data: { bookings: [{ bookingId: 'bkg-1', clientName: 'Maria L.' }] },
      },
    });
    const moving = await model.respond(request([said, ...read]));
    expect(JSON.parse(moving.toolCalls[0]?.arguments ?? '')).toEqual({
      bookingId: 'bkg-1',
      date: '2026-10-27',
      time: '15:00',
      staffMemberId: null,
      emailClient: null,
    });
  });

  it('can be "down" without tripping the shared circuit breaker, and offers help otherwise', async () => {
    const down = await model
      .respond(request([user('Simulate an outage')]))
      .catch((e: unknown) => e);
    expect(isLlmError(down) && down.code).toBe('auth');
    expect((await model.respond(request([user('hello')]))).text).toMatch(/I can book/);
  });

  it('streams its text word by word and stops a slow answer when cancelled', async () => {
    const events = [];
    for await (const event of model.stream(request([user('hello')]))) events.push(event);
    expect(events.filter((event) => event.type === 'text_delta').length).toBeGreaterThan(3);
    const controller = new AbortController();
    const slow = model.respond(request([user('Think slowly')]), { signal: controller.signal });
    controller.abort();
    await expect(slow).rejects.toMatchObject({ code: 'aborted' });
  });
});
