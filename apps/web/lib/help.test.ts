import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELP_ARTICLES,
  HELP_LINKS,
  HELP_TOPICS,
  helpArticle,
  helpHref,
  searchHelp,
  searchText,
} from './help';

// The help centre's content (S59, AC-X-13): every link the app uses names an article, the
// articles are well formed, and the search finds by words, ignoring case and accents.

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('help articles', () => {
  it('have unique slugs, a known topic, a summary and a body', () => {
    const slugs = HELP_ARTICLES.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const article of HELP_ARTICLES) {
      expect(article.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(HELP_TOPICS).toContain(article.topic);
      expect(article.summary.length).toBeGreaterThan(0);
      expect(article.body.length).toBeGreaterThan(0);
    }
    // Every topic has something in it.
    for (const topic of HELP_TOPICS) {
      expect(HELP_ARTICLES.some((article) => article.topic === topic)).toBe(true);
    }
  });

  it('say nothing a client could read as markup or a system word', () => {
    const text = JSON.stringify(HELP_ARTICLES);
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).not.toMatch(/\btenant\b|\bentity\b|lorem/i);
  });

  it('cover every screen that links to one (HELP_LINKS)', () => {
    for (const slug of Object.values(HELP_LINKS)) expect(helpArticle(slug)).toBeDefined();
    expect(helpHref(HELP_LINKS.import)).toBe('/help/import-clients');
  });

  it('are what every /help/<slug> in the app’s code names', () => {
    const root = join(import.meta.dirname, '..', 'app');
    const named = new Set<string>();
    for (const file of sources(root)) {
      for (const match of readFileSync(file, 'utf8').matchAll(
        /['"`]\/help\/([a-z0-9-]+)['"`?#]/g,
      )) {
        if (match[1] !== undefined && match[1] !== 'contact') named.add(match[1]);
      }
    }
    for (const slug of named) expect(helpArticle(slug), slug).toBeDefined();
  });
});

describe('searchHelp', () => {
  it('lists every article for an empty query', () => {
    expect(searchHelp('  ')).toHaveLength(HELP_ARTICLES.length);
  });

  it('finds by every word, ignoring case, accents and apostrophes, titles first', () => {
    const found = searchHelp('IMPORT csv');
    expect(found[0]?.slug).toBe('import-clients');
    expect(searchHelp('waitlist').map((a) => a.slug)).toContain('waitlist');
    expect(searchHelp('two-step').map((a) => a.slug)).toEqual(
      expect.arrayContaining(['team', 'sign-in']),
    );
    expect(searchHelp('cafe')).toEqual(searchHelp('café'));
    expect(searchHelp('dont').length).toBeGreaterThan(0);
  });

  it('finds nothing for words no article holds', () => {
    expect(searchHelp('zebra quantum')).toEqual([]);
  });

  it('normalises text for matching', () => {
    expect(searchText('Café’s RÉSUMÉ')).toBe('cafes resume');
  });
});
