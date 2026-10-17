import { describe, expect, it } from 'vitest';
import { ServiceNotFoundError, StaffMemberNotFoundError, TimeOffNotFoundError } from './errors.js';

describe('appointments errors', () => {
  it.each([
    [new ServiceNotFoundError(), 'ServiceNotFoundError'],
    [new StaffMemberNotFoundError(), 'StaffMemberNotFoundError'],
    [new TimeOffNotFoundError(), 'TimeOffNotFoundError'],
  ])('%s is a named Error', (error, name) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).not.toBe('');
  });
});
