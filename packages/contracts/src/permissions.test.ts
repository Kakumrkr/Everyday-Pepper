import { describe, expect, it } from 'vitest';
import { PermissionSchema, roleRequiresMfa } from './permissions.js';

describe('PermissionSchema', () => {
  it('accepts a known action and rejects others', () => {
    expect(PermissionSchema.parse('members.manage')).toBe('members.manage');
    expect(PermissionSchema.safeParse('members.*').success).toBe(false);
  });
});

describe('roleRequiresMfa', () => {
  it.each([
    ['owner', true],
    ['manager', true],
    ['staff', false],
  ] as const)('%s → %s', (role, required) => {
    expect(roleRequiresMfa(role)).toBe(required);
  });
});
