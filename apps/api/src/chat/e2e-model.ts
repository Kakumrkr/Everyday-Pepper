import { LlmError, scriptedResponse, type LlmProvider } from '@pepper/ai';
import type {
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
  LlmToolCall,
} from '@pepper/contracts';

// The scripted model behind the Playwright journeys (S26, ADR-0031). It is never used in
// production: the api refuses to start with it outside `local`/`ci`, or next to an OpenAI key
// (`loadApiConfig`). It is stateless, so parallel browsers can share one api: each answer
// depends only on the request, i.e. the member's latest words and this turn's tool results.
// It calls the real tools through the real loop and trust layer; only the model is fake. It
// understands a few fixed phrasings (the journeys and the chat's slot picker use them):
//   "Book <client> for <service> with <staff> on YYYY-MM-DD at HH:MM"
//   "Book <Weekday> YYYY-MM-DD at HH:MM with <staff> instead"   (a time picked on a card)
//   "Move <client>'s booking on YYYY-MM-DD to HH:MM"
//   "Remind me to <something>"
//   "Remember <client>'s <what> is <value>"                     (S30: a remembered fact)
//   "Block YYYY-MM-DD HH:MM-HH:MM for <staff>"
//   "What does YYYY-MM-DD look like?"
//   "Simulate an outage"                                        (the model can't be reached)
//   "Think slowly"                                              (a turn to stop or resume)

const BOOK = /^Book (\S+) for (.+?) with (\S+) on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})/i;
const PICKED = /^Book \w{3} (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) with (\S+) instead/i;
const MOVE = /^Move (\S+)'s booking on (\d{4}-\d{2}-\d{2}) to (\d{2}:\d{2})/i;
const REMIND = /^Remind me to (.+)$/i;
const REMEMBER = /^Remember (\S+)'s (.+?) is (.+)$/i;
const BLOCK = /^Block (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2}) for (\S+)/i;
const DAY = /^What does (\d{4}-\d{2}-\d{2}) look like/i;

const HELP =
  'I can book, move or cancel appointments, block time, add to-dos and show you a day. What would you like?';

interface ToolResult {
  status: string;
  code?: string;
  message?: string;
  summary?: string;
  data?: Record<string, unknown>;
}

interface Booking {
  client: string;
  service: string;
  staff: string;
  date: string;
  time: string;
}

export class E2eModel implements LlmProvider {
  async respond(request: LlmRequest, options: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    const { said, earlier, results } = turnOf(request.messages);
    if (/^Simulate an outage/i.test(said)) {
      // Not counted by the circuit breaker, so parallel journeys keep their model.
      throw new LlmError('auth', 'The provider could not be reached');
    }
    if (/^Think slowly/i.test(said)) {
      await pause(8_000, options.signal);
      return scriptedResponse({ text: 'Done thinking.' });
    }
    const picked = PICKED.exec(said);
    const book = BOOK.exec(said);
    if (picked !== null) {
      const first = earlier
        .map((text) => BOOK.exec(text))
        .find((match): match is RegExpExecArray => match !== null);
      if (first === undefined) return reply(HELP);
      return booking(
        {
          client: at(first, 1),
          service: at(first, 2),
          staff: at(picked, 3),
          date: at(picked, 1),
          time: at(picked, 2),
        },
        results,
      );
    }
    if (book !== null) {
      return booking(
        {
          client: at(book, 1),
          service: at(book, 2),
          staff: at(book, 3),
          date: at(book, 4),
          time: at(book, 5),
        },
        results,
      );
    }
    const move = MOVE.exec(said);
    if (move !== null) {
      const day = results.get('get_day');
      if (day === undefined) return call('get_day', { date: at(move, 2), staffMemberId: null });
      const done = results.get('move_booking');
      if (done !== undefined)
        return reply(answerTo(done, 'Moved.', 'Approve it and I’ll move it.'));
      const bookingId = idByName(
        (day.data?.['bookings'] as unknown[] | undefined)?.map((booking) => ({
          ...(booking as Record<string, unknown>),
          name: (booking as Record<string, unknown>)['clientName'],
        })),
        'bookingId',
        at(move, 1),
      );
      if (bookingId === null) return reply(`I can't find ${at(move, 1)}'s booking that day.`);
      return call('move_booking', {
        bookingId,
        date: at(move, 2),
        time: at(move, 3),
        staffMemberId: null,
        emailClient: null,
      });
    }
    const remind = REMIND.exec(said);
    if (remind !== null) {
      const done = results.get('add_todo');
      if (done === undefined) {
        return call('add_todo', {
          title: at(remind, 1),
          dueDate: null,
          dueTime: null,
          assigneeStaffMemberId: null,
        });
      }
      return reply(answerTo(done, 'Added.', 'Approve it and I’ll add it.'));
    }
    const remember = REMEMBER.exec(said);
    if (remember !== null) {
      const clients = results.get('find_clients');
      if (clients === undefined) return call('find_clients', { name: at(remember, 1) });
      const done = results.get('remember_fact');
      if (done !== undefined) {
        return reply(answerTo(done, 'Saved.', 'Approve it and I’ll remember it.'));
      }
      const matches = clients.data?.['matches'];
      const clientId = Array.isArray(matches) ? idOf(matches[0], 'clientId') : null;
      if (clientId === null) return reply(`I can't find a client called ${at(remember, 1)}.`);
      return call('remember_fact', {
        about: 'client',
        id: clientId,
        key: at(remember, 2)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_'),
        value: at(remember, 3).trim(),
        sensitive: null,
      });
    }
    const block = BLOCK.exec(said);
    if (block !== null) {
      const team = results.get('list_services_and_staff');
      if (team === undefined) return call('list_services_and_staff', {});
      const done = results.get('block_time');
      if (done === undefined) {
        const staffMemberId = idByName(team.data?.['staff'], 'staffMemberId', at(block, 4));
        if (staffMemberId === null) return reply(`I can't find ${at(block, 4)} on your team.`);
        return call('block_time', {
          staffMemberId,
          date: at(block, 1),
          from: at(block, 2),
          to: at(block, 3),
        });
      }
      return reply(answerTo(done, 'Blocked.', 'Approve it and I’ll block it.'));
    }
    const day = DAY.exec(said);
    if (day !== null) {
      if (!results.has('get_day'))
        return call('get_day', { date: at(day, 1), staffMemberId: null });
      return reply('Here is that day.');
    }
    return reply(HELP);
  }

  async *stream(
    request: LlmRequest,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<LlmStreamEvent> {
    const response = await this.respond(request, options);
    // Word by word, like a provider's deltas.
    for (const delta of response.text.match(/\S+\s*|\s+/g) ?? []) {
      yield { type: 'text_delta', delta };
    }
    yield { type: 'done', response };
  }
}

/** One booking request: look the names up, then book; then say how it went. */
function booking(wanted: Booking, results: Map<string, ToolResult>): LlmResponse {
  const clients = results.get('find_clients');
  const team = results.get('list_services_and_staff');
  if (clients === undefined || team === undefined) {
    return calls([
      ['find_clients', { name: wanted.client }],
      ['list_services_and_staff', {}],
    ]);
  }
  const done = results.get('create_booking');
  if (done !== undefined) {
    if (done.status === 'refused' && done.code === 'slot_unavailable') {
      return reply('That time is taken. These are the nearest times that work:');
    }
    return reply(answerTo(done, 'Booked.', 'Here it is. Approve it and I’ll book it.'));
  }
  const matches = clients.data?.['matches'];
  const clientId = Array.isArray(matches) ? idOf(matches[0], 'clientId') : null;
  const serviceId = idByName(team.data?.['services'], 'serviceId', wanted.service);
  const staffMemberId = idByName(team.data?.['staff'], 'staffMemberId', wanted.staff);
  if (clientId === null) return reply(`I can't find a client called ${wanted.client}.`);
  if (serviceId === null || staffMemberId === null) return reply(HELP);
  return call('create_booking', {
    clientId,
    serviceId,
    staffMemberId,
    date: wanted.date,
    time: wanted.time,
    emailClient: null,
  });
}

function answerTo(result: ToolResult, done: string, waiting: string): string {
  if (result.status === 'done') return done;
  if (result.status === 'awaiting_approval') return waiting;
  if (result.code === 'forbidden')
    return 'Your role doesn’t let me do that. Ask an owner or a manager.';
  return 'I couldn’t do that. Nothing changed.';
}

/** The member's latest words, their earlier ones (newest first), and this turn's tool results. */
function turnOf(messages: readonly LlmMessage[]) {
  const lastUser = messages.map((message) => message.role).lastIndexOf('user');
  const said = textOf(messages[lastUser]);
  const earlier = messages
    .slice(0, Math.max(lastUser, 0))
    .filter((message) => message.role === 'user')
    .map(textOf)
    .reverse();
  const names = new Map<string, string>();
  const results = new Map<string, ToolResult>();
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls) names.set(toolCall.id, toolCall.name);
    } else if (message.role === 'tool') {
      const name = names.get(message.toolCallId);
      if (name !== undefined) results.set(name, parse(message.content));
    }
  }
  return { said, earlier, results };
}

function textOf(message: LlmMessage | undefined): string {
  if (message === undefined) return '';
  try {
    // A message labelled untrusted arrives JSON-wrapped.
    const wrapped = JSON.parse(message.content) as { untrusted_data?: unknown };
    if (typeof wrapped.untrusted_data === 'string') return wrapped.untrusted_data.trim();
  } catch {
    // Plain text.
  }
  return message.content.trim();
}

function parse(content: string): ToolResult {
  try {
    const value = JSON.parse(content) as ToolResult & { untrusted_data?: string };
    return typeof value.untrusted_data === 'string'
      ? (JSON.parse(value.untrusted_data) as ToolResult)
      : value;
  } catch {
    return { status: 'refused' };
  }
}

function idOf(item: unknown, key: string): string | null {
  if (typeof item !== 'object' || item === null) return null;
  const value = (item as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/** The id of the first item whose name starts with `name` (any case). */
function idByName(items: unknown, key: string, name: string): string | null {
  if (!Array.isArray(items)) return null;
  const wanted = name.toLowerCase();
  const found: unknown = (items as unknown[]).find((item) =>
    idOf(item, 'name')?.toLowerCase().startsWith(wanted),
  );
  return idOf(found, key);
}

function at(match: RegExpExecArray, index: number): string {
  return (match[index] ?? '').trim();
}

function reply(text: string): LlmResponse {
  return scriptedResponse({ text });
}

let callIds = 0;

function call(name: string, args: Record<string, unknown>): LlmResponse {
  return calls([[name, args]]);
}

function calls(list: [string, Record<string, unknown>][]): LlmResponse {
  const toolCalls: LlmToolCall[] = list.map(([name, args]) => {
    callIds += 1;
    return { id: `e2e_${String(callIds)}`, name, arguments: JSON.stringify(args) };
  });
  return scriptedResponse({ toolCalls });
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new LlmError('aborted', 'The call was cancelled'));
      },
      { once: true },
    );
  });
}
