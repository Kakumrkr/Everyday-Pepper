'use client';

import { Input, List, ListRow } from '@pepper/ui';
import { useState } from 'react';
import { HELP_PATH, HELP_TOPICS, searchHelp, type HelpArticle } from '../../../lib/help';
import { TextLink } from '../auth-page';
import { kitLink } from '../kit-link';

/**
 * The help centre's list (S59, AC-X-13): every article by topic, narrowed as you type (title,
 * summary and text; case and accents ignored). Nothing found offers a way to ask.
 */
export function HelpSearch({ askHref }: { askHref: string }) {
  const [query, setQuery] = useState('');
  const found = searchHelp(query);
  const searching = query.trim() !== '';
  return (
    <div className="flex flex-col gap-6">
      <Input
        label="Search the help centre"
        type="search"
        name="q"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        placeholder="e.g. import, waitlist, two-step"
        autoComplete="off"
      />
      <p className="sr-only" role="status">
        {searching ? `${String(found.length)} articles match` : ''}
      </p>
      {searching ? (
        found.length === 0 ? (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-2 px-5 py-5">
            <p className="m-0 type-subheading text-ink">No article matches</p>
            <p className="m-0 type-body text-ink-2">
              Try another word, or <TextLink href={askHref}>ask us</TextLink>: a person answers the
              same day.
            </p>
          </div>
        ) : (
          <Articles articles={found} />
        )
      ) : (
        HELP_TOPICS.map((topic) => {
          const articles = found.filter((article) => article.topic === topic);
          if (articles.length === 0) return null;
          const id = `topic-${topic.toLowerCase().replace(/[^a-z]+/g, '-')}`;
          return (
            <section key={topic} aria-labelledby={id}>
              <h2 id={id} className="m-0 mb-1 type-heading">
                {topic}
              </h2>
              <Articles articles={articles} />
            </section>
          );
        })
      )}
    </div>
  );
}

function Articles({ articles }: { articles: readonly HelpArticle[] }) {
  return (
    <List>
      {articles.map((article) => (
        <ListRow
          key={article.slug}
          title={article.title}
          meta={article.summary}
          href={`${HELP_PATH}/${article.slug}`}
          renderLink={kitLink}
        />
      ))}
    </List>
  );
}
