import * as Sentry from '@sentry/node';
import { describe, expect, it, vi } from 'vitest';
import { raiseAlert } from './alerts.js';

vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }));

describe('raiseAlert', () => {
  it('sends an error-level message with its tags', () => {
    raiseAlert('Outbox message given up', { messageId: 'm-1' });
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Outbox message given up', {
      level: 'error',
      tags: { messageId: 'm-1' },
    });
  });
});
