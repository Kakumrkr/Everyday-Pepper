import { cx } from '@pepper/ui';
import type { HelpBlock } from '../../../lib/help';

/** One block of a help article or a policy (S59; shared with the legal pages in S59.5). */
export function HelpBlockView({ block }: { block: HelpBlock }) {
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
