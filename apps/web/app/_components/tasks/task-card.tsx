'use client';

import { TaskSchema, type Member, type Task } from '@pepper/contracts';
import { buttonClass, LegacyCard, cx } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  assigneeChoices,
  assigneeFromChoice,
  assigneeLabel,
  dueAtFrom,
  dueLabel,
} from '../../../lib/tasks';
import { Field, Notice } from '../booking/sheet';

/**
 * The member's to-dos on Home (S21, ADR-0026): add one with an optional due time on the
 * business's clock, mark it done, undo. Owners and managers see everyone's and may give a
 * to-do to anyone (`members` is their team); staff see and add only their own. The api
 * checks every change.
 */
export function TaskCard({
  open,
  done,
  me,
  members,
  timeZone,
  now,
}: {
  open: Task[];
  done: Task[];
  me: string;
  /** The business's members when the caller may assign (owners, managers); else `null`. */
  members: Member[] | null;
  timeZone: string;
  now: number;
}) {
  const router = useRouter();
  const headingId = useId();
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('');
  const [assignee, setAssignee] = useState(me);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const due = dueAtFrom(timeZone, day, time);
    if (title.trim() === '') {
      setError('Write what needs doing.');
      return;
    }
    if (!due.ok) {
      setError('Pick a valid date and time.');
      return;
    }
    setBusy(true);
    const answer = await sendJson('POST', '/v1/tasks', {
      title,
      dueAt: due.dueAt,
      ...(members !== null && { assigneeUserId: assigneeFromChoice(assignee) }),
    });
    setBusy(false);
    if (!answer.ok || !TaskSchema.safeParse(answer.data).success) {
      setError(answer.ok ? 'Something went wrong.' : answer.message);
      return;
    }
    setTitle('');
    setDay('');
    setTime('');
    setError(null);
    router.refresh();
  }

  async function setStatus(task: Task, status: Task['status']): Promise<void> {
    setBusy(true);
    const answer = await sendJson('PATCH', `/v1/tasks/${task.id}`, { status });
    setBusy(false);
    setError(answer.ok ? null : answer.message);
    if (answer.ok) router.refresh();
  }

  return (
    <LegacyCard as="section" labelledBy={headingId}>
      <h2 id={headingId} className="m-0 font-display text-lg font-bold">
        To-dos
      </h2>

      {open.length === 0 ? (
        <p className="mt-1 mb-0 text-ink-2">Nothing to do. Add the first to-do below.</p>
      ) : (
        <ul className="m-0 mt-2 grid list-none gap-1 p-0" data-testid="open-tasks">
          {open.map((task) => {
            const due = task.dueAt === null ? null : dueLabel(timeZone, task.dueAt, now);
            return (
              <li key={task.id} className="flex items-start gap-2">
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Mark done: ${task.title}`}
                  onClick={() => void setStatus(task, 'done')}
                  className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-transparent hover:bg-brand-soft focus-visible:outline-3 focus-visible:outline-brand disabled:cursor-progress"
                >
                  <span aria-hidden="true" className="size-5 rounded-full border-2 border-brand" />
                </button>
                <div className="grid gap-0.5 pt-2.5">
                  <span className="font-semibold">{task.title}</span>
                  <span className="text-sm text-ink-2">
                    {due === null ? null : (
                      <span className={cx(due.overdue && 'font-semibold text-wait')}>
                        {due.overdue ? `Overdue · ${due.text}` : due.text}
                      </span>
                    )}
                    {due !== null && members !== null ? ' · ' : null}
                    {members === null ? null : assigneeLabel(task.assigneeUserId, me, members)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <form className="mt-4 grid gap-3" noValidate onSubmit={(event) => void add(event)}>
        <Field label="New to-do">
          <input
            name="title"
            value={title}
            maxLength={200}
            placeholder="e.g. Order more color"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date" hint="Optional">
            <input
              type="date"
              name="dueDay"
              value={day}
              onChange={(event) => {
                setDay(event.target.value);
              }}
            />
          </Field>
          <Field label="Time" hint="9:00 AM if empty">
            <input
              type="time"
              name="dueTime"
              value={time}
              disabled={day === ''}
              onChange={(event) => {
                setTime(event.target.value);
              }}
            />
          </Field>
        </div>
        {members === null ? null : (
          <Field label="For">
            <select
              name="assignee"
              value={assignee}
              onChange={(event) => {
                setAssignee(event.target.value);
              }}
            >
              {assigneeChoices(me, members).map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <button
          type="submit"
          disabled={busy}
          className={buttonClass({ className: 'justify-self-start' })}
        >
          Add to-do
        </button>
      </form>

      {done.length === 0 ? null : (
        <section aria-label="Recently done" className="mt-5">
          <h3 className="m-0 text-sm font-bold text-ink-2">Recently done</h3>
          <ul className="m-0 mt-1 grid list-none gap-1 p-0" data-testid="done-tasks">
            {done.map((task) => (
              <li key={task.id} className="flex min-h-11 items-center justify-between gap-3">
                <span className="text-ink-2 line-through">{task.title}</span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Undo: ${task.title}`}
                  className={buttonClass({ variant: 'quiet', size: 'sm' })}
                  onClick={() => void setStatus(task, 'open')}
                >
                  Undo
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </LegacyCard>
  );
}
