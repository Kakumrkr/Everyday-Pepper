import { describe, expect, it } from 'vitest';
import { grantableRoles, inviteLink, inviteTokenFromHash, safeNext } from './invite';

const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';

describe('inviteLink', () => {
  it('puts the token in the fragment of the invite page', () => {
    expect(inviteLink('https://app.floty.test', TOKEN)).toBe(
      `https://app.floty.test/invite#${TOKEN}`,
    );
  });
});

describe('inviteTokenFromHash', () => {
  it('reads the token with or without the #', () => {
    expect(inviteTokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFromHash(TOKEN)).toBe(TOKEN);
  });

  it.each(['', '#', '#short', `#${TOKEN}x`, '#<script>'])('rejects %j', (hash) => {
    expect(inviteTokenFromHash(hash)).toBeNull();
  });
});

describe('safeNext', () => {
  it('allows only the invite page', () => {
    expect(safeNext('/invite')).toBe('/invite');
  });

  it.each(['https://evil.test/invite', '//evil.test', '/invite/../x', '/', undefined, ['/invite']])(
    'refuses %j',
    (value) => {
      expect(safeNext(value)).toBeNull();
    },
  );
});

describe('grantableRoles', () => {
  it('owners offer every role, managers all but owner, staff none', () => {
    expect(grantableRoles('owner')).toEqual(['staff', 'manager', 'owner']);
    expect(grantableRoles('manager')).toEqual(['staff', 'manager']);
    expect(grantableRoles('staff')).toEqual([]);
  });
});
