import { cx, FOCUS_RING, Icon } from '@pepper/ui';
import Link from 'next/link';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DRAFT_NOTICE,
  legalDate,
  type LegalBlock,
  type LegalDocument,
} from '../../../lib/legal';
import { HelpBlockView } from '../help/help-block';
import { PlainLink } from '../help/help-link';

/**
 * A policy page (S59.5, AC-X-54): the title, when it last changed, the draft banner until the
 * lawyer's review, "On this page" to jump to a section, then the sections. Each section is its
 * own link target and is highlighted when opened by its link, so a client who taps the line in
 * an email lands on the part that explains it (`/privacy#ai`, AC-X-56).
 */
export function LegalPage({ document: doc }: { document: LegalDocument }) {
  const other = LEGAL_DOCUMENTS.filter((each) => each.path !== doc.path);
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-display">{doc.title}</h1>
        <p className="m-0 type-body text-ink-2">{doc.summary}</p>
        <p className="m-0 type-caption text-ink-2">
          Last updated <time dateTime={doc.updated}>{legalDate(doc.updated)}</time>
        </p>
      </header>
      <p
        role="note"
        className="m-0 flex gap-3 rounded-md bg-warn-soft px-4 py-3 type-body text-ink"
        data-testid="legal-draft"
      >
        <Icon name="alert" className="mt-0.5 shrink-0 text-warn" />
        <span>
          <strong className="font-semibold">Draft. </strong>
          {LEGAL_DRAFT_NOTICE}
        </span>
      </p>
      <details className="group rounded-lg bg-surface-2">
        <summary
          className={cx(
            'flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 type-label text-ink',
            FOCUS_RING,
          )}
        >
          On this page
          <Icon
            name="down"
            className="shrink-0 text-ink-2 transition-transform group-open:rotate-180"
          />
        </summary>
        <nav aria-label="On this page" className="px-2 pb-2">
          <ol className="m-0 flex list-none flex-col p-0">
            {doc.sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={cx(
                    'flex min-h-11 items-center rounded-md px-2 type-body text-brand underline-offset-4 hover:underline',
                    FOCUS_RING,
                  )}
                >
                  {section.heading}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </details>
      {doc.sections.map((section) => (
        <section
          key={section.id}
          id={section.id}
          aria-labelledby={`${section.id}-heading`}
          className="-mx-4 flex scroll-mt-4 flex-col gap-3 rounded-lg px-4 py-2 target:bg-brand-soft target:py-4"
        >
          <h2 id={`${section.id}-heading`} className="m-0 type-heading">
            {section.heading}
          </h2>
          {section.blocks.map((block, index) => (
            <LegalBlockView key={index} block={block} />
          ))}
        </section>
      ))}
      <nav aria-label="More" className="flex flex-col gap-1 border-t border-line pt-4">
        {other.map((each) => (
          <PlainLink key={each.path} href={each.path}>
            {each.title}
          </PlainLink>
        ))}
        <PlainLink href="/help">Help centre</PlainLink>
      </nav>
    </>
  );
}

function LegalBlockView({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'quote':
      return (
        <blockquote className="m-0 border-l-4 border-brand bg-surface px-4 py-3 type-body text-ink italic">
          {block.text}
        </blockquote>
      );
    case 'link':
      return (
        <Link
          href={block.href}
          className={cx(
            'inline-flex min-h-11 items-center self-start type-label text-brand underline underline-offset-4',
            FOCUS_RING,
          )}
        >
          {block.text}
        </Link>
      );
    case 'p':
    case 'note':
    case 'list':
    case 'steps':
      return <HelpBlockView block={block} />;
  }
}
