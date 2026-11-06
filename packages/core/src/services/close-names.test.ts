import { describe, expect, it } from 'vitest';
import { closeNames, editDistance, nameDistance } from './close-names.js';

// Close names for a typo (S56a, AC-W2-8).

const people = [
  { id: 1, name: 'Maria Lopez' },
  { id: 2, name: 'Mariana Ortiz' },
  { id: 3, name: 'Sara Kim' },
  { id: 4, name: 'Sarah Park' },
  { id: 5, name: 'Jay Brooks' },
  { id: 6, name: 'José Núñez' },
];

describe('editDistance', () => {
  it('counts a swap of two neighbouring letters as one edit', () => {
    expect(editDistance('mraia', 'maria')).toBe(1);
    expect(editDistance('maria', 'maria')).toBe(0);
    expect(editDistance('mari', 'maria')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('nameDistance', () => {
  it('allows 1 edit in a word of up to 5 letters, 2 in a longer one, none in 1–2 letters', () => {
    expect(nameDistance('Jya', 'Jay Brooks')).toBe(1);
    expect(nameDistance('Jzz', 'Jay Brooks')).toBeNull();
    expect(nameDistance('Mriaa', 'Maria Lopez')).toBeNull();
    expect(nameDistance('Chirstohper', 'Christopher Lee')).toBe(2);
    expect(nameDistance('Jo', 'Jay Brooks')).toBeNull();
  });

  it('needs every word of the search close to a word of the name', () => {
    expect(nameDistance('Maria Lopes', 'Maria Lopez')).toBe(1);
    expect(nameDistance('Maria Kim', 'Maria Lopez')).toBeNull();
  });

  it('ignores accents and case', () => {
    expect(nameDistance('jose nunez', 'José Núñez')).toBe(0);
  });
});

describe('closeNames', () => {
  it('suggests the closest names first, at most 3', () => {
    expect(closeNames('Mraia', people).map((p) => p.name)).toEqual(['Maria Lopez']);
    expect(closeNames('Sarha', people).map((p) => p.name)).toEqual(['Sara Kim', 'Sarah Park']);
    expect(closeNames('Brooksy', people).map((p) => p.name)).toEqual(['Jay Brooks']);
  });

  it('suggests nobody when no name is close', () => {
    expect(closeNames('Xavier', people)).toEqual([]);
    expect(closeNames('', people)).toEqual([]);
  });

  it('keeps at most the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `Maria ${String(i)}` }));
    expect(closeNames('Mraia', many)).toHaveLength(3);
    expect(closeNames('Mraia', many, 1)).toHaveLength(1);
  });
});
