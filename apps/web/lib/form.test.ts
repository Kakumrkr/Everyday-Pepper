import { describe, expect, it } from 'vitest';
import { formPassword, formText } from './form';

describe('form fields', () => {
  const data = new FormData();
  data.set('name', '  Ana  ');
  data.set('password', ' spaced secret ');
  data.set('file', new Blob(['x']));

  it('trims text fields and keeps passwords as typed', () => {
    expect(formText(data, 'name')).toBe('Ana');
    expect(formPassword(data, 'password')).toBe(' spaced secret ');
  });

  it('returns an empty string for a missing or file field', () => {
    expect(formText(data, 'missing')).toBe('');
    expect(formText(data, 'file')).toBe('');
    expect(formPassword(data, 'file')).toBe('');
  });
});
