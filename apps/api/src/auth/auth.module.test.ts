import { describe, expect, it, vi } from 'vitest';
import { toNestLog } from './auth.module.js';

describe('toNestLog', () => {
  it('maps Better Auth levels to the Nest logger', () => {
    const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
    const log = toNestLog(logger);
    log('error', 'e');
    log('warn', 'w');
    log('info', 'i');
    log('debug', 'd');
    expect(logger.error).toHaveBeenCalledWith('e');
    expect(logger.warn).toHaveBeenCalledWith('w');
    expect(logger.log.mock.calls).toEqual([['i'], ['d']]);
  });
});
