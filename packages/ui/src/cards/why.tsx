import type { ChatFallback, ScreenLink } from '@pepper/contracts';
import type { ReactNode } from 'react';
import { cx } from '../class-names.js';
import { Icon } from '../icons.js';
import { safeScreenLink, type WhyModel } from './labels.js';

/** How a page renders an in-app link (Next's `Link`); a plain anchor by default. */
export type RenderLink = (link: ScreenLink) => ReactNode;

const plainLink: RenderLink = (link) => (
  <a href={link.href} className="font-semibold text-brand underline underline-offset-2">
    {link.label}
  </a>
);

/**
 * The *Why?* sheet's body (D-2, playbook principle 9): what started it, what I did, what I
 * didn't, and the setting used, with a link to change it. Built from `whyModel` (records and
 * codes); the member's own words are shown as plain text.
 */
export function WhyContent({
  why,
  autonomyLink,
  renderLink = plainLink,
}: {
  why: WhyModel;
  autonomyLink?: ScreenLink;
  renderLink?: RenderLink;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Block title="What started it">
        <p className="m-0 whitespace-pre-wrap">{why.started}</p>
      </Block>
      {why.did.length === 0 ? null : (
        <Block title="What I did">
          <ul className="m-0 flex flex-col gap-1 pl-5">
            {why.did.map((line, index) => (
              <li key={`${line}-${String(index)}`}>{line}</li>
            ))}
          </ul>
        </Block>
      )}
      {why.didNot.length === 0 ? null : (
        <Block title="What I didn’t do">
          <ul className="m-0 flex flex-col gap-1 pl-5">
            {why.didNot.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Block>
      )}
      <div className="flex items-start gap-2 rounded-md bg-info-soft p-3 text-sm">
        <Icon name="dial" className="mt-0.5 text-info" />
        <p className="m-0">
          Setting used: <b>{why.setting}</b>
          {autonomyLink === undefined ? null : <> · {renderLink(autonomyLink)}</>}
        </p>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="m-0 text-xs font-bold tracking-wide text-ink-2 uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A clear state in the chat: the AI's deterministic fallback, a turn limit, the AI off or
 * paused (AC-X-2). The link is shown only if it is a path in this app (`ScreenLinkSchema`),
 * whatever was sent.
 */
export function ChatNotice({
  text,
  link,
  tone = 'wait',
  renderLink = plainLink,
}: {
  text: string;
  link?: unknown;
  tone?: 'wait' | 'info';
  renderLink?: RenderLink;
}) {
  const safe = safeScreenLink(link ?? null);
  return (
    <div
      className={cx(
        'flex max-w-[34rem] flex-col gap-2 rounded-lg p-4 text-sm',
        tone === 'wait' ? 'bg-wait-soft' : 'bg-info-soft',
      )}
    >
      <p className="m-0 whitespace-pre-wrap">{text}</p>
      {safe === null ? null : <p className="m-0">{renderLink(safe)}</p>}
    </div>
  );
}

/** A turn's fallback reply (`turn.failed`). */
export function FallbackNotice({
  fallback,
  renderLink,
}: {
  fallback: ChatFallback;
  renderLink?: RenderLink;
}) {
  return (
    <ChatNotice
      text={fallback.text}
      link={fallback.link}
      {...(renderLink !== undefined && { renderLink })}
    />
  );
}
