import { buttonStyle, cx } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  HELP_ARTICLES,
  HELP_CONTACT_PATH,
  HELP_PATH,
  helpArticle,
  type HelpBlock,
} from '../../../lib/help';
import { newRequestHref } from '../../../lib/support';
import { PlainLink } from '../../_components/help/help-link';
import { currentAccount } from '../../_server/account';

export const dynamic = 'force-dynamic';

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const article = helpArticle((await params).slug);
  return { title: article === undefined ? 'Help · Pepper' : `${article.title} · Pepper help` };
}

/**
 * One help article (S59, PCR-010, AC-X-13), ending in "Still stuck?": a new request about it
 * when signed in, the public form otherwise. Two more articles of the same topic below.
 */
export default async function HelpArticlePage({ params }: { params: Params }) {
  const { slug } = await params;
  const article = helpArticle(slug);
  if (article === undefined) notFound();
  const signedIn = (await currentAccount()).state === 'signed-in';
  const ask = signedIn
    ? newRequestHref({ page: `${HELP_PATH}/${article.slug}`, topic: article.slug })
    : `${HELP_CONTACT_PATH}?topic=${article.slug}`;
  const related = HELP_ARTICLES.filter(
    (other) => other.topic === article.topic && other.slug !== article.slug,
  ).slice(0, 2);
  return (
    <>
      <PlainLink href={HELP_PATH} back>
        All help
      </PlainLink>
      <article className="flex flex-col gap-5">
        <header className="flex flex-col gap-2">
          <p className="m-0 type-caption text-ink-2">{article.topic}</p>
          <h1 className="m-0 type-display">{article.title}</h1>
          <p className="m-0 type-body text-ink-2">{article.summary}</p>
        </header>
        {article.body.map((block, index) => (
          <Block key={index} block={block} />
        ))}
      </article>
      <section
        aria-labelledby="still-stuck"
        className="flex flex-col items-start gap-3 rounded-lg bg-surface-2 px-5 py-5"
      >
        <h2 id="still-stuck" className="m-0 type-subheading">
          Still stuck?
        </h2>
        <p className="m-0 type-body text-ink-2">
          Tell us what’s going on. A person on the Pepper team answers the same day.
        </p>
        <Link href={ask} className={buttonStyle({ variant: 'primary' })}>
          {signedIn ? 'Tell us what went wrong' : 'Write to us'}
        </Link>
      </section>
      {related.length === 0 ? null : (
        <nav aria-label="More on this" className="flex flex-col gap-2">
          <p className="m-0 type-label text-ink-2">More on {article.topic.toLowerCase()}</p>
          {related.map((other) => (
            <PlainLink key={other.slug} href={`${HELP_PATH}/${other.slug}`}>
              {other.title}
            </PlainLink>
          ))}
        </nav>
      )}
    </>
  );
}

function Block({ block }: { block: HelpBlock }) {
  switch (block.kind) {
    case 'p':
      return <p className="m-0 type-body text-ink">{block.text}</p>;
    case 'note':
      return (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink">{block.text}</p>
      );
    case 'steps':
    case 'list': {
      const items = block.items.map((item) => (
        <li key={item} className="type-body text-ink">
          {item}
        </li>
      ));
      return block.kind === 'steps' ? (
        <ol className={cx('m-0 flex flex-col gap-2 pl-6', 'list-decimal')}>{items}</ol>
      ) : (
        <ul className="m-0 flex list-disc flex-col gap-2 pl-6">{items}</ul>
      );
    }
  }
}
