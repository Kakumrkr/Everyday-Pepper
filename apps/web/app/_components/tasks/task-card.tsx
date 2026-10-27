'use client';

import { TaskSchema, type Member, type Task } from '@pepper/contracts';
import { Button, cx, fieldStyle, FOCUS_RING } from '@pepper/ui';
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
 * checks every change. On the kit (S41): a flat section, to-dos as hairline rows.
 */
const CONTROL = cx(fieldStyle, 'min-h-12');
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
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="m-0 type-heading">
        To-dos
      </h2>

      {open.length === 0 ? (
        <p className="m-0 type-body text-ink-2">Nothing to do. Add the first to-do below.</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0" data-testid="open-tasks">
          {open.map((task) => {
            const due = task.dueAt === null ? null : dueLabel(timeZone, task.dueAt, now);
            return (
              <li key={task.id} className="flex items-start gap-2 py-1.5">
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Mark done: ${task.title}`}
                  onClick={() => void setStatus(task, 'done')}
                  className={cx(
                    'grid size-11 shrink-0 cursor-pointer place-items-center rounded-pill bg-transparent p-0 hover:bg-brand-soft disabled:cursor-progress',
                    FOCUS_RING,
                  )}
                >
                  <span aria-hidden="true" className="size-5 rounded-pill border-2 border-brand" />
                </button>
                <div className="grid gap-0.5 pt-2.5">
                  <span className="type-body font-semibold text-ink">{task.title}</span>
                  <span className="type-caption text-ink-2 tabular-nums">
                    {due === null ? null : (
                      <span className={cx(due.overdue && 'font-semibold text-warn')}>
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

      <form className="mt-2 grid gap-3" noValidate onSubmit={(event) => void add(event)}>
        <Field label="New to-do">
          <input
            className={CONTROL}
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
              className={CONTROL}
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
              className={CONTROL}
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
              className={CONTROL}
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
        <Button type="submit" variant="secondary" busy={busy} className="justify-self-start">
          Add to-do
        </Button>
      </form>

      {done.length === 0 ? null : (
        <section aria-label="Recently done" className="mt-3">
          <h3 className="m-0 type-label text-ink-2">Recently done</h3>
          <ul className="m-0 list-none divide-y divide-line p-0" data-testid="done-tasks">
            {done.map((task) => (
              <li key={task.id} className="flex min-h-12 items-center justify-between gap-3">
                <span className="type-body text-ink-2 line-through">{task.title}</span>
                <Button
                  variant="quiet"
                  size="sm"
                  icon="undo"
                  disabled={busy}
                  aria-label={`Undo: ${task.title}`}
                  onClick={() => void setStatus(task, 'open')}
                >
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
