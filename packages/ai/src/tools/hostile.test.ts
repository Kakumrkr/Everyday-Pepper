import { LlmToolCallSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { hostileAttacks, hostileProvider, validArguments } from './hostile.js';
import { TOOLS } from './registry.js';

const ids = (n: string) => ({
  serviceId: `0199f4b2-7c1e-7a00-8000-0000000000${n}1`,
  staffMemberId: `0199f4b2-7c1e-7a00-8000-0000000000${n}2`,
  clientId: `0199f4b2-7c1e-7a00-8000-0000000000${n}3`,
  bookingId: `0199f4b2-7c1e-7a00-8000-0000000000${n}4`,
});
const targets = { own: ids('a'), foreign: ids('b') };

describe('the hostile fake', () => {
  const attacks = hostileAttacks(targets, '2026-11-03');

  it('attacks every tool, with ids, smuggled fields and broken arguments', () => {
    expect(new Set(attacks.map((a) => a.id)).size).toBe(attacks.length);
    for (const tool of TOOLS) {
      const mine = attacks.filter((a) => a.call.name === tool.name);
      expect(mine.length, tool.name).toBeGreaterThanOrEqual(7);
    }
    expect(attacks.filter((a) => a.stoppedWith.includes('unknown_tool')).length).toBe(7);
  });

  it('starts from arguments each tool would accept, so only the attack differs', () => {
    const valid = validArguments(targets.own, '2026-11-03');
    for (const tool of TOOLS) {
      expect(tool.args.safeParse(valid[tool.name]).success, tool.name).toBe(true);
    }
  });

  it('makes every attack a tool call the provider contract accepts, then stops', async () => {
    const provider = hostileProvider(attacks);
    const request = {
      route: 'routine' as const,
      instructions: 'x',
      messages: [{ role: 'user' as const, content: 'go' }],
      tools: [],
      toolChoice: 'auto' as const,
      maxOutputTokens: 64,
    };
    for (const attack of attacks) {
      const response = await provider.respond(request);
      const [call] = response.toolCalls;
      expect(LlmToolCallSchema.parse(call)).toMatchObject(attack.call);
    }
    expect((await provider.respond(request)).toolCalls).toEqual([]);
  });
});
